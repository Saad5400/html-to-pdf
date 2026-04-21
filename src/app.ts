import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { pino } from 'pino';
import { sha256Hex } from '@/lib/hash.js';
import type { Config } from '@/config/index.js';
import authPlugin from '@/plugins/auth.js';
import errorHandler from '@/plugins/error-handler.js';
import metricsPlugin from '@/plugins/metrics.js';
import convertRoutes from '@/routes/convert.js';
import filesRoutes from '@/routes/files.js';
import healthRoutes from '@/routes/health.js';
import jobsRoutes from '@/routes/jobs.js';
import playgroundRoute from '@/routes/playground.js';
import { ApiKeyService } from '@/services/auth/api-key.js';
import { BrowserPool, PdfRenderer } from '@/services/pdf/index.js';
import { closeAllRedis, getRedis, JobsService } from '@/services/queue/index.js';
import { JobStore } from '@/services/queue/job-store.js';
import { createStorage } from '@/services/storage/index.js';
import type { StorageAdapter } from '@/types/index.js';

export interface AppHandle {
  server: FastifyInstance;
  pool: BrowserPool;
  jobs: JobsService | undefined;
  shutdown: () => Promise<void>;
}

export async function buildApp(config: Config): Promise<AppHandle> {
  const loggerInstance = pino({
    level: config.LOG_LEVEL,
    name: 'http',
    redact: {
      paths: ['req.headers.authorization', 'req.headers["x-api-key"]'],
      censor: '[REDACTED]',
    },
  });

  const baseServer = Fastify({
    loggerInstance,
    bodyLimit: config.REQUEST_BODY_LIMIT_MB * 1024 * 1024,
    trustProxy: config.TRUST_PROXY as never,
    disableRequestLogging: false,
    genReqId: () => randomUUID(),
  });
  const server = baseServer.withTypeProvider<ZodTypeProvider>();

  server.setValidatorCompiler(validatorCompiler);
  server.setSerializerCompiler(serializerCompiler);

  await server.register(sensible);
  await server.register(helmet, { contentSecurityPolicy: false });
  await server.register(cors, { origin: true, credentials: false });

  if (config.features.rateLimit) {
    // Use Redis backend when the queue is enabled (shared infrastructure);
    // otherwise the rate-limit plugin falls back to in-memory LRU.
    const useRedis = config.features.queue;
    await server.register(rateLimit, {
      max: config.RATE_LIMIT_PER_MIN,
      timeWindow: '1 minute',
      ...(useRedis ? { redis: getRedis(config, 'general') } : {}),
      keyGenerator: (req) => {
        const headerToken =
          (req.headers['x-api-key'] as string | undefined) ??
          (Array.isArray(req.headers.authorization)
            ? req.headers.authorization[0]
            : req.headers.authorization);
        const source = headerToken ?? req.ip;
        return sha256Hex(String(source)).slice(0, 32);
      },
    });
  }

  await server.register(swagger, {
    openapi: {
      info: {
        title: 'HTML to PDF Service',
        description: `High-fidelity HTML and URL to PDF conversion API. Mode: ${config.MODE}.`,
        version: '0.1.0',
      },
      servers: config.PUBLIC_BASE_URL ? [{ url: config.PUBLIC_BASE_URL }] : [],
      components: {
        securitySchemes: {
          bearer: { type: 'http', scheme: 'bearer' },
          apiKey: { type: 'apiKey', in: 'header', name: 'x-api-key' },
        },
      },
      security: [{ bearer: [] }, { apiKey: [] }],
    },
    transform: jsonSchemaTransform,
  });
  await server.register(swaggerUi, { routePrefix: '/docs' });

  const pool = new BrowserPool({
    size: config.BROWSER_POOL_SIZE,
    idleTtlMs: config.BROWSER_IDLE_TTL_MS,
    maxQueueDepth: config.BROWSER_POOL_SIZE * 4,
    logger: loggerInstance,
  });
  const renderer = new PdfRenderer(pool, config, loggerInstance);
  const apiKeys = new ApiKeyService(config);

  // ---- Optional infra (only constructed when their feature is on) ----
  let storage: StorageAdapter | undefined;
  if (config.features.storage) storage = createStorage(config);

  let jobs: JobsService | undefined;
  let jobStore: JobStore | undefined;
  if (config.features.queue) {
    jobs = new JobsService(config);
    jobStore = new JobStore(getRedis(config, 'general'), config);
  }

  await server.register(metricsPlugin);
  await server.register(authPlugin, { apiKeys, required: config.features.auth });
  await server.register(errorHandler);
  await server.register(healthRoutes, {
    pool,
    ...(config.features.queue ? { redis: getRedis(config, 'general') } : {}),
  });
  // The sync convert endpoint is the always-on path (the one minimal mode is
  // built around). It does not depend on queue or storage.
  await server.register(convertRoutes, { renderer, config });
  if (jobs && jobStore && storage) {
    await server.register(jobsRoutes, { jobs, jobStore, storage, config });
  }
  if (storage) {
    await server.register(filesRoutes, { storage, config });
  }
  await server.register(playgroundRoute);

  const shutdown = async (): Promise<void> => {
    server.log.info('shutting down');
    await server.close();
    await jobs?.close();
    await pool.stop();
    await closeAllRedis();
  };

  return {
    server: baseServer as unknown as FastifyInstance,
    pool,
    jobs,
    shutdown,
  };
}
