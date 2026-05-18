import type { Config } from '@/config/index.js';
import type { StorageAdapter } from '@/types/index.js';
import { LocalStorage } from './local.js';
import { S3Storage } from './s3.js';

export function createStorage(config: Config): StorageAdapter {
  if (config.STORAGE_DRIVER === 's3') return new S3Storage(config);
  return new LocalStorage(config);
}

export { LocalStorage } from './local.js';
export { S3Storage } from './s3.js';
