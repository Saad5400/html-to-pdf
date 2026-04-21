import fp from 'fastify-plugin';
import type { FastifyPluginAsync } from 'fastify';
import { collectDefaultMetrics, Counter, Histogram, Registry } from 'prom-client';

declare module 'fastify' {
  interface FastifyInstance {
    metrics: {
      registry: Registry;
      requests: Counter<string>;
      latency: Histogram<string>;
      pdfBytes: Histogram<string>;
      pdfPages: Histogram<string>;
      renderErrors: Counter<string>;
    };
  }
}

const plugin: FastifyPluginAsync = async (app) => {
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });

  const requests = new Counter({
    name: 'http_requests_total',
    help: 'Total HTTP requests',
    labelNames: ['method', 'route', 'status'],
    registers: [registry],
  });

  const latency = new Histogram({
    name: 'http_request_duration_seconds',
    help: 'HTTP request latency in seconds',
    labelNames: ['method', 'route', 'status'],
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 20, 30, 45, 60],
    registers: [registry],
  });

  const pdfBytes = new Histogram({
    name: 'pdf_render_bytes',
    help: 'Bytes per rendered PDF',
    buckets: [
      10_000, 50_000, 100_000, 250_000, 500_000, 1_000_000, 2_000_000, 5_000_000, 10_000_000,
      25_000_000,
    ],
    registers: [registry],
  });

  const pdfPages = new Histogram({
    name: 'pdf_render_pages',
    help: 'Pages per rendered PDF',
    buckets: [1, 5, 10, 25, 50, 100, 250, 500],
    registers: [registry],
  });

  const renderErrors = new Counter({
    name: 'pdf_render_errors_total',
    help: 'PDF render errors by reason',
    labelNames: ['reason'],
    registers: [registry],
  });

  app.decorate('metrics', { registry, requests, latency, pdfBytes, pdfPages, renderErrors });

  app.addHook('onRequest', (req, _reply, done) => {
    (req as { _start?: bigint })._start = process.hrtime.bigint();
    done();
  });
  app.addHook('onResponse', (req, reply, done) => {
    const start = (req as { _start?: bigint })._start;
    const route = req.routeOptions?.url ?? req.url;
    const status = String(reply.statusCode);
    requests.labels(req.method, route, status).inc();
    if (start) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      latency.labels(req.method, route, status).observe(seconds);
    }
    done();
  });

  app.get('/metrics', { schema: { hide: true } }, async (_req, reply) => {
    reply.header('content-type', registry.contentType);
    return registry.metrics();
  });
};

export default fp(plugin, { name: 'metrics' });
