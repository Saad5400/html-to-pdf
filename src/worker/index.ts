import { Worker, type Job } from 'bullmq';
import { pino, type Logger } from 'pino';
import { getConfig } from '@/config/index.js';
import { sha256Hex } from '@/lib/hash.js';
import { KeyedSemaphore } from '@/lib/semaphore.js';
import { BrowserPool, PdfRenderer } from '@/services/pdf/index.js';
import {
  closeAllRedis,
  getRedis,
  type ConvertJobData,
  type ConvertJobResult,
} from '@/services/queue/index.js';
import { JobStore } from '@/services/queue/job-store.js';
import { deliverWebhook } from '@/services/queue/webhook.js';
import { createStorage } from '@/services/storage/index.js';

function hostKey(req: ConvertJobData['request']): string {
  if (req.url) {
    try {
      return new URL(req.url).host.toLowerCase();
    } catch {
      return '__bad_url__';
    }
  }
  return '__html__';
}

async function main(): Promise<void> {
  const config = getConfig();
  const rootLogger = pino({ level: config.LOG_LEVEL, name: 'worker' });
  const ssrfPolicy = {
    allowedHosts: config.ALLOWED_URL_HOSTS,
    blockedHosts: config.BLOCKED_URL_HOSTS,
    allowPrivateNetworks: config.ALLOW_PRIVATE_NETWORKS,
  };

  const pool = new BrowserPool({
    size: config.BROWSER_POOL_SIZE,
    idleTtlMs: config.BROWSER_IDLE_TTL_MS,
    logger: rootLogger,
  });
  await pool.start();

  const renderer = new PdfRenderer(pool, config, rootLogger);
  const storage = createStorage(config);
  const connection = getRedis(config, 'queue');
  const generalRedis = getRedis(config, 'general');
  const jobStore = new JobStore(generalRedis, config);
  const perHost = new KeyedSemaphore(config.PER_HOST_CONCURRENCY);
  const webhookSecret = config.WEBHOOK_SECRET ?? config.SIGNED_URL_SECRET;

  const worker = new Worker<ConvertJobData, ConvertJobResult>(
    config.QUEUE_NAME,
    async (job: Job<ConvertJobData, ConvertJobResult>) => {
      const log: Logger = rootLogger.child({
        jobId: job.id,
        requestId: job.data.requestId,
        apiKeyId: job.data.apiKeyId,
      });
      const host = hostKey(job.data.request);
      const release = await perHost.acquire(host);
      const start = Date.now();
      try {
        log.info({ attempt: job.attemptsMade + 1, host }, 'render start');
        const result = await renderer.render(job.data.request);
        const sha = sha256Hex(result.pdf);
        const tenant = job.data.apiKeyId ?? 'anon';
        const key = `pdfs/${tenant}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`;
        if (!(await storage.exists(key))) {
          await storage.put(key, result.pdf, 'application/pdf');
        }
        const out: ConvertJobResult = {
          storageKey: key,
          bytes: result.bytes,
          pages: result.pages,
          sha256: sha,
        };
        await jobStore.writeCompleted(job.id ?? 'unknown', job.data.apiKeyId, out);
        log.info(
          { ms: Date.now() - start, pages: result.pages, bytes: result.bytes },
          'render done',
        );
        if (job.data.webhookUrl) {
          const url = await storage.signedUrl(key, config.SIGNED_URL_TTL_SECONDS);
          await deliverWebhook({
            url: job.data.webhookUrl,
            secret: webhookSecret,
            payload: { jobId: job.id, status: 'completed', ...out, downloadUrl: url },
            ssrfPolicy,
            logger: log,
          }).catch((err) => log.warn({ err: (err as Error).message }, 'webhook delivery rejected'));
        }
        return out;
      } finally {
        release();
      }
    },
    { connection, concurrency: config.QUEUE_CONCURRENCY, autorun: true },
  );

  worker.on('failed', (job, err) => {
    rootLogger.error({ jobId: job?.id, err: err.message }, 'job failed');
    const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    if (final && job) {
      void jobStore
        .writeFailed(job.id ?? 'unknown', job.data?.apiKeyId, err.message)
        .catch(() => {});
      if (job.data?.webhookUrl) {
        void deliverWebhook({
          url: job.data.webhookUrl,
          secret: webhookSecret,
          payload: { jobId: job.id, status: 'failed', error: err.message },
          ssrfPolicy,
          logger: rootLogger,
        }).catch(() => {});
      }
    }
  });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    rootLogger.info({ signal }, 'worker shutting down (drain)');
    const drainTimeout = setTimeout(() => {
      rootLogger.warn('drain timeout exceeded; forcing close');
      void worker.close(true);
    }, 30_000);
    drainTimeout.unref?.();
    await worker.close().catch(() => {});
    clearTimeout(drainTimeout);
    await pool.stop();
    await closeAllRedis();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  rootLogger.info(
    { concurrency: config.QUEUE_CONCURRENCY, perHost: config.PER_HOST_CONCURRENCY },
    'worker started',
  );
}

main().catch((err) => {
  console.error('worker boot failed', err);
  process.exit(1);
});
