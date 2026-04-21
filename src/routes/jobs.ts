import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { Config } from '@/config/index.js';
import { newJobId } from '@/lib/id.js';
import { ConvertRequestSchema, JobIdParamSchema } from '@/schemas/convert.js';
import { assertSafeUrl } from '@/security/ssrf.js';
import type { JobsService } from '@/services/queue/index.js';
import type { JobStore } from '@/services/queue/job-store.js';
import type { StorageAdapter } from '@/types/index.js';

export interface JobsDeps {
  jobs: JobsService;
  jobStore: JobStore;
  storage: StorageAdapter;
  config: Config;
}

const plugin: FastifyPluginAsync<JobsDeps> = async (app, deps) => {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/v1/jobs',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Enqueue an async PDF conversion',
        body: ConvertRequestSchema,
        headers: z.object({
          'idempotency-key': z.string().min(8).max(128).optional(),
        }),
        response: {
          202: z.object({
            jobId: z.string(),
            status: z.string(),
            deduped: z.boolean(),
          }),
        },
      },
      preHandler: async (req) => {
        await app.requireApiKey(req);
      },
    },
    async (req, reply) => {
      // Validate webhook URL through the same SSRF guard as render targets.
      if (req.body.webhookUrl) {
        await assertSafeUrl(req.body.webhookUrl, {
          allowedHosts: deps.config.ALLOWED_URL_HOSTS,
          blockedHosts: deps.config.BLOCKED_URL_HOSTS,
          allowPrivateNetworks: deps.config.ALLOW_PRIVATE_NETWORKS,
        });
      }
      const idem = (req.headers['idempotency-key'] as string | undefined) ?? undefined;
      const candidateId = newJobId();
      const data = {
        request: req.body,
        ...(req.apiKey?.id ? { apiKeyId: req.apiKey.id } : {}),
        ...(req.body.webhookUrl ? { webhookUrl: req.body.webhookUrl } : {}),
        ...(idem ? { idempotencyKey: idem } : {}),
        requestId: req.id as string,
      };
      const { jobId, deduped } = await deps.jobs.enqueue(candidateId, data);
      reply.status(202).send({ jobId, status: deduped ? 'deduped' : 'queued', deduped });
    },
  );

  f.get(
    '/v1/jobs/:id',
    {
      schema: {
        tags: ['jobs'],
        summary: 'Get job status and (if complete) download URL',
        params: JobIdParamSchema,
        response: {
          200: z.unknown(),
          404: z.object({ error: z.string(), message: z.string() }),
        },
      },
      preHandler: async (req) => {
        await app.requireApiKey(req);
      },
    },
    async (req, reply) => {
      let rec = await deps.jobs.get(req.params.id);
      const persisted = await deps.jobStore.read(req.params.id);

      // Fall back to the durable store when BullMQ has already evicted the job
      // (default 24h retention) but our JobStore still has it.
      if (!rec && !persisted) {
        return reply.status(404).send({ error: 'not_found', message: 'job not found' });
      }
      if (!rec && persisted) {
        rec = {
          id: req.params.id,
          status: persisted.status,
          createdAt: persisted.finishedAt,
          finishedAt: persisted.finishedAt,
        };
      }
      if (persisted) deps.jobStore.hydrate(rec!, persisted);

      if (rec!.status === 'completed') {
        const live = await deps.jobs.queue.getJob(req.params.id);
        const result = live?.returnvalue;
        if (result && !rec!.result) {
          rec!.result = {
            ...result,
            downloadUrl: '',
            expiresAt: '',
          };
        }
        if (rec!.result?.storageKey) {
          const url = await deps.storage.signedUrl(
            rec!.result.storageKey,
            deps.config.SIGNED_URL_TTL_SECONDS,
          );
          rec!.result.downloadUrl = url;
          rec!.result.expiresAt = new Date(
            Date.now() + deps.config.SIGNED_URL_TTL_SECONDS * 1000,
          ).toISOString();
        }
      }
      return reply.send(rec);
    },
  );
};

export default plugin;
