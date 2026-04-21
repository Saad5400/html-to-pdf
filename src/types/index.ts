import type { z } from 'zod';
import type { ConvertOptionsSchema, ConvertRequestSchema } from '@/schemas/convert.js';

export type ConvertOptions = z.infer<typeof ConvertOptionsSchema>;
export type ConvertRequest = z.infer<typeof ConvertRequestSchema>;

export type JobStatus = 'queued' | 'active' | 'completed' | 'failed';

export interface JobRecord {
  id: string;
  status: JobStatus;
  createdAt: string;
  finishedAt?: string;
  error?: string;
  result?: {
    storageKey: string;
    bytes: number;
    pages: number;
    sha256: string;
    downloadUrl: string;
    expiresAt: string;
  };
}

export interface RenderResult {
  pdf: Buffer;
  pages: number;
  bytes: number;
  durationMs: number;
}

export interface StorageAdapter {
  put(key: string, data: Buffer, contentType: string): Promise<void>;
  get(key: string): Promise<Buffer>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
  signedUrl(key: string, ttlSeconds: number): Promise<string>;
}

export interface ApiKeyRecord {
  id: string;
  hash: string;
  label: string;
  rateLimitPerMin?: number;
}
