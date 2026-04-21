import { Queue, QueueEvents, type JobsOptions } from 'bullmq';
import IORedis, { type Redis } from 'ioredis';
import { createHash } from 'node:crypto';
import type { Config } from '@/config/index.js';
import { canonicalJson } from '@/lib/hash.js';
import type { ConvertRequest, JobRecord } from '@/types/index.js';

export interface ConvertJobData {
  request: ConvertRequest;
  apiKeyId?: string;
  webhookUrl?: string;
  idempotencyKey?: string;
  requestId?: string;
}

export interface ConvertJobResult {
  storageKey: string;
  bytes: number;
  pages: number;
  sha256: string;
}

const connections = new Map<string, Redis>();

/**
 * BullMQ Workers and QueueEvents both require `maxRetriesPerRequest: null`,
 * but other consumers (rate-limit) want default retries. Maintain separate
 * cached connections by purpose.
 */
export function getRedis(config: Config, purpose: 'queue' | 'general' = 'queue'): Redis {
  const cached = connections.get(purpose);
  if (cached) return cached;
  const conn = new IORedis(config.REDIS_URL, {
    enableReadyCheck: true,
    ...(purpose === 'queue' ? { maxRetriesPerRequest: null } : {}),
  });
  connections.set(purpose, conn);
  return conn;
}

export async function closeAllRedis(): Promise<void> {
  const all = Array.from(connections.values());
  connections.clear();
  await Promise.allSettled(all.map((c) => c.quit()));
}

/**
 * Atomic idempotency: bind (apiKeyId, idempotencyKey) → jobId in Redis with
 * NX. The first POST wins; subsequent POSTs see the same jobId. Scoped per
 * tenant so customers can't collide on shared keys.
 */
export function idempotencyHash(apiKeyId: string | undefined, key: string, body: ConvertRequest): string {
  // Anonymous traffic refuses idempotency: the keyspace is shared across all
  // unauthenticated callers and would let one client hijack another's job.
  if (!apiKeyId) throw new Error('apiKeyId is required for idempotency');
  const bodyDigest = createHash('sha256').update(canonicalJson(body)).digest('hex');
  return createHash('sha256').update(`${apiKeyId}|${key}|${bodyDigest}`).digest('hex');
}

export class JobsService {
  readonly queue: Queue<ConvertJobData, ConvertJobResult>;
  readonly events: QueueEvents;
  readonly redis: Redis;

  constructor(private readonly config: Config) {
    const conn = getRedis(config, 'queue');
    this.redis = conn;
    this.queue = new Queue<ConvertJobData, ConvertJobResult>(config.QUEUE_NAME, {
      connection: conn,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: { age: 24 * 3600, count: 1000 },
        removeOnFail: { age: 7 * 24 * 3600 },
      },
    });
    this.events = new QueueEvents(config.QUEUE_NAME, { connection: conn.duplicate() });
  }

  /**
   * Returns either {jobId, deduped:false} for a brand-new job, or
   * {jobId, deduped:true} when the idempotency key already maps to one.
   *
   * Ordering: enqueue first, then claim. On a lost SETNX race we soft-cancel
   * our newly-added job (BullMQ jobIds are unique by construction so we can't
   * collide with the winner). On a *crashed* claim, the orphaned Redis entry
   * times out after the TTL — better than the inverse failure mode (claim
   * present, job never enqueued) which would have client polling forever.
   */
  async enqueue(
    jobId: string,
    data: ConvertJobData,
  ): Promise<{ jobId: string; deduped: boolean }> {
    const opts: JobsOptions = { jobId };
    if (data.idempotencyKey && data.apiKeyId !== undefined) {
      const hash = idempotencyHash(data.apiKeyId, data.idempotencyKey, data.request);
      const redisKey = `idem:${hash}`;
      const ttl = 24 * 3600;
      await this.queue.add('convert', data, opts);
      const set = await this.redis.set(redisKey, jobId, 'EX', ttl, 'NX');
      if (set !== 'OK') {
        const existing = await this.redis.get(redisKey);
        if (existing && existing !== jobId) {
          await this.queue
            .remove(jobId)
            .catch(() => {});
          return { jobId: existing, deduped: true };
        }
      }
      return { jobId, deduped: false };
    }
    await this.queue.add('convert', data, opts);
    return { jobId, deduped: false };
  }

  async get(jobId: string): Promise<JobRecord | undefined> {
    const job = await this.queue.getJob(jobId);
    if (!job) return undefined;
    const state = await job.getState();
    const status = mapState(state);
    const rec: JobRecord = {
      id: job.id ?? jobId,
      status,
      createdAt: new Date(job.timestamp).toISOString(),
    };
    if (job.finishedOn) rec.finishedAt = new Date(job.finishedOn).toISOString();
    if (job.failedReason) rec.error = job.failedReason;
    return rec;
  }

  async close(): Promise<void> {
    await this.events.close().catch(() => {});
    await this.queue.close().catch(() => {});
  }
}

function mapState(state: string): JobRecord['status'] {
  switch (state) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'active':
      return 'active';
    default:
      return 'queued';
  }
}
