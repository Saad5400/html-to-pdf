import type { Redis } from 'ioredis';
import type { Config } from '@/config/index.js';
import type { JobRecord } from '@/types/index.js';
import type { ConvertJobResult } from './index.js';

export interface PersistedResult {
  jobId: string;
  status: 'completed' | 'failed';
  storageKey?: string;
  bytes?: number;
  pages?: number;
  sha256?: string;
  error?: string;
  finishedAt: string;
  apiKeyId?: string;
}

/**
 * Durable job-result cache backed by a Redis hash. BullMQ removes completed
 * jobs after 24h by default; this store keeps the result pointer (storageKey,
 * sha, byte count) for `JOB_RESULT_TTL_SECONDS` so /v1/jobs/:id keeps working.
 *
 * We deliberately do NOT persist the input HTML or any PII — only the
 * result pointer + outcome.
 */
export class JobStore {
  private readonly ttlSeconds: number;
  constructor(
    private readonly redis: Redis,
    config: Config,
  ) {
    this.ttlSeconds = config.JOB_RESULT_TTL_SECONDS;
  }

  private key(jobId: string): string {
    return `htp:job:${jobId}`;
  }

  async writeCompleted(
    jobId: string,
    apiKeyId: string | undefined,
    result: ConvertJobResult,
  ): Promise<void> {
    const data: PersistedResult = {
      jobId,
      status: 'completed',
      storageKey: result.storageKey,
      bytes: result.bytes,
      pages: result.pages,
      sha256: result.sha256,
      finishedAt: new Date().toISOString(),
      ...(apiKeyId ? { apiKeyId } : {}),
    };
    await this.redis.set(this.key(jobId), JSON.stringify(data), 'EX', this.ttlSeconds);
  }

  async writeFailed(
    jobId: string,
    apiKeyId: string | undefined,
    error: string,
  ): Promise<void> {
    const data: PersistedResult = {
      jobId,
      status: 'failed',
      error,
      finishedAt: new Date().toISOString(),
      ...(apiKeyId ? { apiKeyId } : {}),
    };
    await this.redis.set(this.key(jobId), JSON.stringify(data), 'EX', this.ttlSeconds);
  }

  async read(jobId: string): Promise<PersistedResult | undefined> {
    const raw = await this.redis.get(this.key(jobId));
    if (!raw) return undefined;
    try {
      return JSON.parse(raw) as PersistedResult;
    } catch {
      return undefined;
    }
  }

  /** Apply a persisted record onto a JobRecord (used as fallback when the
   *  BullMQ entry has been removed). */
  hydrate(rec: JobRecord, persisted: PersistedResult): JobRecord {
    rec.status = persisted.status;
    rec.finishedAt = persisted.finishedAt;
    if (persisted.error) rec.error = persisted.error;
    if (persisted.status === 'completed' && persisted.storageKey) {
      rec.result = {
        storageKey: persisted.storageKey,
        bytes: persisted.bytes ?? 0,
        pages: persisted.pages ?? 0,
        sha256: persisted.sha256 ?? '',
        downloadUrl: '', // caller fills in via storage.signedUrl
        expiresAt: '',
      };
    }
    return rec;
  }
}
