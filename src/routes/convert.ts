import type { FastifyPluginAsync } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { sha256Hex } from '@/lib/hash.js';
import { ConvertRequestSchema } from '@/schemas/convert.js';
import type { PdfRenderer } from '@/services/pdf/index.js';
import type { Config } from '@/config/index.js';

export interface ConvertDeps {
  renderer: PdfRenderer;
  config: Config;
}

const plugin: FastifyPluginAsync<ConvertDeps> = async (app, deps) => {
  const f = app.withTypeProvider<ZodTypeProvider>();

  f.post(
    '/v1/convert',
    {
      schema: {
        tags: ['convert'],
        summary: 'Synchronously convert HTML or URL to PDF',
        body: ConvertRequestSchema,
        response: {
          200: z.unknown(),
          400: z.object({ error: z.string(), message: z.string() }),
          413: z.object({ error: z.string(), message: z.string() }),
          502: z.object({ error: z.string(), message: z.string() }),
        },
      },
      preHandler: async (req) => {
        await app.requireApiKey(req);
      },
    },
    async (req, reply) => {
      const result = await deps.renderer.render(req.body);
      app.metrics.pdfBytes.observe(result.bytes);
      app.metrics.pdfPages.observe(result.pages);
      const sha = sha256Hex(result.pdf);
      reply
        .header('content-type', 'application/pdf')
        .header('content-length', String(result.bytes))
        .header('content-disposition', `inline; filename="document-${sha.slice(0, 8)}.pdf"`)
        .header('x-pdf-pages', String(result.pages))
        .header('x-pdf-sha256', sha)
        .header('x-render-ms', String(result.durationMs));
      return reply.send(result.pdf);
    },
  );
};

export default plugin;
