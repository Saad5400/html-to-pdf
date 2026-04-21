import fp from 'fastify-plugin';
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import type { ApiKeyService } from '@/services/auth/api-key.js';
import type { ApiKeyRecord } from '@/types/index.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKey?: ApiKeyRecord;
  }
  interface FastifyInstance {
    requireApiKey: (req: FastifyRequest) => Promise<ApiKeyRecord>;
  }
}

const ANON: ApiKeyRecord = { id: 'anon', label: 'anonymous', hash: '' };

const plugin: FastifyPluginAsync<{ apiKeys: ApiKeyService; required: boolean }> = async (
  app,
  opts,
) => {
  app.decorate('requireApiKey', async (req: FastifyRequest): Promise<ApiKeyRecord> => {
    if (!opts.required) {
      req.apiKey = ANON;
      return ANON;
    }
    const header = req.headers.authorization ?? '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const token = m?.[1] ?? (req.headers['x-api-key'] as string | undefined);
    if (!token) throw app.httpErrors.unauthorized('API key required');
    const rec = await opts.apiKeys.verify(token.trim());
    if (!rec) throw app.httpErrors.unauthorized('Invalid API key');
    req.apiKey = rec;
    return rec;
  });
};

export default fp(plugin, { name: 'auth' });
