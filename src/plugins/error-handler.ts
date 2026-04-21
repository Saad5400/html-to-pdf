import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import {
  hasZodFastifySchemaValidationErrors,
  isResponseSerializationError,
} from 'fastify-type-provider-zod';
import { ZodError } from 'zod';
import { LimitExceededError } from '@/security/limits.js';
import { SsrfError } from '@/security/ssrf.js';
import { RenderError, RenderTimeoutError } from '@/services/pdf/index.js';
import { PoolBackpressureError, PoolStoppedError } from '@/services/pdf/browser-pool.js';

const plugin: FastifyPluginAsync = async (app) => {
  app.setErrorHandler((err, req, reply) => {
    if (hasZodFastifySchemaValidationErrors(err)) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Request schema validation failed',
        details: err.validation,
      });
    }
    if (isResponseSerializationError(err)) {
      req.log.error({ err }, 'response serialization failed');
      return reply.status(500).send({ error: 'serialization_error', message: 'Response failed validation' });
    }
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'validation_error',
        message: 'Request body failed validation',
        details: err.issues,
      });
    }
    if (err instanceof SsrfError) {
      return reply.status(400).send({ error: 'ssrf_blocked', message: err.message });
    }
    if (err instanceof LimitExceededError) {
      return reply.status(413).send({ error: 'limit_exceeded', message: err.message });
    }
    if (err instanceof PoolBackpressureError) {
      reply.header('retry-after', '5');
      return reply.status(503).send({ error: 'backpressure', message: err.message });
    }
    if (err instanceof PoolStoppedError) {
      return reply.status(503).send({ error: 'shutting_down', message: err.message });
    }
    if (err instanceof RenderTimeoutError) {
      app.metrics?.renderErrors.labels('timeout').inc();
      return reply.status(504).send({ error: 'render_timeout', message: err.message });
    }
    if (err instanceof RenderError) {
      app.metrics?.renderErrors.labels('render').inc();
      return reply.status(502).send({ error: 'render_failed', message: err.message });
    }
    const e = err as { statusCode?: number; name?: string; message?: string };
    if (e.statusCode) {
      return reply.status(e.statusCode).send({
        error: e.name ?? 'http_error',
        message: e.message ?? 'Request failed',
      });
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send({ error: 'internal_error', message: 'Internal Server Error' });
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send({ error: 'not_found', message: `${req.method} ${req.url} not found` });
  });
};

export default fp(plugin, { name: 'error-handler' });
