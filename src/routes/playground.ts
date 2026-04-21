import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyPluginAsync } from 'fastify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Locate the playground HTML in either dev (src/) or built (dist/) layouts.
const CANDIDATES = [
  path.resolve(HERE, '..', '..', 'public', 'playground.html'), // dev: src/routes -> repo/public
  path.resolve(HERE, '..', '..', '..', 'public', 'playground.html'), // dist/src/routes -> repo/public
];

const plugin: FastifyPluginAsync = async (app) => {
  let cached: string | undefined;
  app.get('/playground', { schema: { hide: true } }, async (_req, reply) => {
    if (!cached) {
      for (const p of CANDIDATES) {
        try {
          cached = await fs.readFile(p, 'utf8');
          break;
        } catch {
          /* try next */
        }
      }
      if (!cached) {
        return reply.status(404).send({ error: 'not_found', message: 'playground asset missing' });
      }
    }
    reply.header('content-type', 'text/html; charset=utf-8').send(cached);
  });
};

export default plugin;
