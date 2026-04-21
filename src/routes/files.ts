import type { FastifyPluginAsync } from 'fastify';
import { hmacVerify } from '@/lib/hash.js';
import type { Config } from '@/config/index.js';
import type { StorageAdapter } from '@/types/index.js';

export interface FilesDeps {
  storage: StorageAdapter;
  config: Config;
}

const plugin: FastifyPluginAsync<FilesDeps> = async (app, deps) => {
  // Signed download endpoint used by the LocalStorage adapter.
  app.get<{ Params: { key: string }; Querystring: { exp?: string; sig?: string } }>(
    '/v1/files/:key',
    { schema: { hide: true } },
    async (req, reply) => {
      if (deps.config.STORAGE_DRIVER !== 'local') {
        return reply.status(404).send({ error: 'not_found' });
      }
      const key = decodeURIComponent(req.params.key);
      const exp = Number(req.query.exp ?? 0);
      const sig = req.query.sig ?? '';
      if (!exp || !sig) return reply.status(400).send({ error: 'missing_signature' });
      if (Date.now() / 1000 > exp) return reply.status(410).send({ error: 'expired' });
      if (!hmacVerify(deps.config.SIGNED_URL_SECRET, `${key}:${exp}`, sig)) {
        return reply.status(403).send({ error: 'bad_signature' });
      }
      try {
        const data = await deps.storage.get(key);
        const filename = key.split('/').pop() ?? 'download.pdf';
        // RFC 5987: encode filename for safety (key passes the resolveSafe
        // regex so it's already ASCII-safe, but quoting + filename* is more
        // robust against future schema changes that loosen key rules).
        const safeAscii = filename.replace(/[^\w.\-]/g, '_');
        const utf8Encoded = encodeURIComponent(filename);
        reply
          .header('content-type', 'application/pdf')
          .header('content-length', String(data.byteLength))
          .header(
            'content-disposition',
            `attachment; filename="${safeAscii}"; filename*=UTF-8''${utf8Encoded}`,
          );
        return reply.send(data);
      } catch {
        return reply.status(404).send({ error: 'not_found' });
      }
    },
  );
};

export default plugin;
