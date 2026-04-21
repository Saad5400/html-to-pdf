import type { FastifyPluginAsync } from 'fastify';
import type { Redis } from 'ioredis';
import type { BrowserPool } from '@/services/pdf/index.js';

export interface HealthDeps {
  redis?: Redis;
  pool: BrowserPool;
}

const plugin: FastifyPluginAsync<HealthDeps> = async (app, deps) => {
  app.get('/health/live', { schema: { hide: true } }, async () => ({ status: 'ok' }));

  app.get('/health/ready', { schema: { hide: true } }, async (_req, reply) => {
    const checks: Record<string, { ok: boolean; detail?: string }> = {};
    if (deps.redis) {
      try {
        const pong = await deps.redis.ping();
        checks.redis = { ok: pong === 'PONG' };
      } catch (err) {
        checks.redis = { ok: false, detail: (err as Error).message };
      }
    }
    const poolSize = deps.pool.size();
    try {
      // start() is idempotent and ensures the browser is connected.
      await deps.pool.start();
      checks.browser = { ok: true };
    } catch (err) {
      checks.browser = { ok: false, detail: (err as Error).message };
    }
    const ok = Object.values(checks).every((c) => c.ok);
    reply.status(ok ? 200 : 503).send({ status: ok ? 'ok' : 'degraded', checks, pool: poolSize });
  });
};

export default plugin;
