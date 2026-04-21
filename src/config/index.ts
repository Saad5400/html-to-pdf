import { z } from 'zod';

const numberFromEnv = (def: number) =>
  z
    .union([z.string(), z.number()])
    .transform((v) => Number(v))
    .pipe(z.number().int().nonnegative())
    .default(def);

const boolFromEnv = (def: boolean) =>
  z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))
    .default(def);

const csvFromEnv = z
  .string()
  .optional()
  .transform((v) =>
    (v ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  );

const ConfigSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  HOST: z.string().default('0.0.0.0'),
  PORT: numberFromEnv(3000),
  LOG_LEVEL: z.enum(['silent', 'fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  REQUEST_BODY_LIMIT_MB: numberFromEnv(10),

  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  QUEUE_NAME: z.string().default('html-to-pdf'),
  QUEUE_CONCURRENCY: numberFromEnv(4),

  BROWSER_POOL_SIZE: numberFromEnv(4),
  BROWSER_IDLE_TTL_MS: numberFromEnv(60_000),
  RENDER_TIMEOUT_MS: numberFromEnv(30_000),
  NAVIGATION_TIMEOUT_MS: numberFromEnv(20_000),
  MAX_CONTENT_BYTES: numberFromEnv(25 * 1024 * 1024),
  MAX_HTML_BYTES: numberFromEnv(10 * 1024 * 1024),
  MAX_PAGES_PER_DOC: numberFromEnv(500),

  API_KEYS: csvFromEnv,
  ALLOWED_URL_HOSTS: csvFromEnv,
  BLOCKED_URL_HOSTS: csvFromEnv,
  ALLOW_PRIVATE_NETWORKS: boolFromEnv(false),

  STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
  LOCAL_STORAGE_DIR: z.string().default('./storage'),
  SIGNED_URL_TTL_SECONDS: numberFromEnv(3600),
  SIGNED_URL_SECRET: z.string().min(16).default('change-me-please-32-chars-min-secret'),
  WEBHOOK_SECRET: z.string().min(16).optional(),
  TRUST_PROXY: z
    .union([z.string(), z.boolean()])
    .transform((v) => {
      if (typeof v === 'boolean') return v;
      if (['1', 'true', 'yes', 'on'].includes(v.toLowerCase())) return true;
      if (['0', 'false', 'no', 'off', ''].includes(v.toLowerCase())) return false;
      return v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    })
    .default(false),
  S3_BUCKET: z.string().optional(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ENDPOINT: z.string().optional(),
  S3_ACCESS_KEY_ID: z.string().optional(),
  S3_SECRET_ACCESS_KEY: z.string().optional(),
  S3_FORCE_PATH_STYLE: boolFromEnv(true),

  RATE_LIMIT_PER_MIN: numberFromEnv(60),
  PUBLIC_BASE_URL: z.string().url().optional(),

  // ---- Feature toggles ----
  // MODE=minimal: pure sync /v1/convert with no Redis, no storage, no queue.
  //               Useful for libraries, CI, and self-host setups that just
  //               want "ask → PDF back" with no infrastructure.
  // MODE=full   : everything (default).
  // Individual toggles below override MODE-derived defaults.
  MODE: z.enum(['full', 'minimal']).default('full'),
  ENABLE_QUEUE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))
    .optional(),
  ENABLE_STORAGE: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))
    .optional(),
  ENABLE_RATE_LIMIT: z
    .union([z.string(), z.boolean()])
    .transform((v) => (typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase())))
    .optional(),
  AUTH_REQUIRED: boolFromEnv(true),

  // Worker-side: max concurrent renders against the same upstream host.
  // Prevents a single tenant from DoSing one URL with N parallel jobs.
  PER_HOST_CONCURRENCY: numberFromEnv(2),
  // How long completed/failed job results survive past BullMQ's own TTL.
  JOB_RESULT_TTL_SECONDS: numberFromEnv(7 * 24 * 3600),
});

type RawConfig = z.infer<typeof ConfigSchema>;
export interface Config extends RawConfig {
  // Resolved feature toggles (after applying MODE defaults + overrides).
  features: {
    queue: boolean;
    storage: boolean;
    rateLimit: boolean;
    auth: boolean;
  };
}

let cached: Config | undefined;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n  ');
    throw new Error(`Invalid configuration:\n  ${issues}`);
  }
  if (parsed.data.STORAGE_DRIVER === 's3' && !parsed.data.S3_BUCKET) {
    throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
  }
  if (
    parsed.data.NODE_ENV === 'production' &&
    parsed.data.SIGNED_URL_SECRET === 'change-me-please-32-chars-min-secret'
  ) {
    throw new Error('SIGNED_URL_SECRET must be set to a real value in production');
  }
  const minimal = parsed.data.MODE === 'minimal';
  const features = {
    queue: parsed.data.ENABLE_QUEUE ?? !minimal,
    storage: parsed.data.ENABLE_STORAGE ?? !minimal,
    rateLimit: parsed.data.ENABLE_RATE_LIMIT ?? !minimal,
    auth: parsed.data.AUTH_REQUIRED,
  };
  // Auth defaults to off in minimal mode unless explicitly enabled.
  if (minimal && parsed.data.AUTH_REQUIRED && parsed.data.API_KEYS.length === 0) {
    features.auth = false;
  }
  return { ...parsed.data, features };
}

export function getConfig(): Config {
  if (!cached) cached = loadConfig();
  return cached;
}

export function resetConfigForTests(): void {
  cached = undefined;
}
