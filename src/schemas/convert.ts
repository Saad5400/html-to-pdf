import { z } from 'zod';

const Margin = z
  .union([
    z.string().regex(/^\d+(\.\d+)?(px|in|cm|mm)$/),
    z.number().nonnegative(),
  ])
  .optional();

export const PageFormat = z.enum([
  'Letter',
  'Legal',
  'Tabloid',
  'Ledger',
  'A0',
  'A1',
  'A2',
  'A3',
  'A4',
  'A5',
  'A6',
]);

export const ConvertOptionsSchema = z
  .object({
    format: PageFormat.default('A4'),
    landscape: z.boolean().default(false),
    printBackground: z.boolean().default(true),
    scale: z.number().min(0.1).max(2).default(1),
    displayHeaderFooter: z.boolean().default(false),
    headerTemplate: z.string().max(8192).optional(),
    footerTemplate: z.string().max(8192).optional(),
    margin: z
      .object({ top: Margin, right: Margin, bottom: Margin, left: Margin })
      .optional(),
    pageRanges: z.string().regex(/^[\d,\-\s]*$/).optional(),
    width: z.union([z.string(), z.number()]).optional(),
    height: z.union([z.string(), z.number()]).optional(),
    preferCSSPageSize: z.boolean().default(false),
    waitUntil: z.enum(['load', 'domcontentloaded', 'networkidle', 'commit']).default('networkidle'),
    waitForSelector: z.string().max(512).optional(),
    waitForTimeoutMs: z.number().int().min(0).max(15_000).optional(),
    emulateMedia: z.enum(['screen', 'print']).default('print'),
    colorScheme: z.enum(['light', 'dark', 'no-preference']).default('light'),
    timezone: z.string().max(64).optional(),
    locale: z.string().max(32).optional(),
    viewport: z
      .object({
        width: z.number().int().min(200).max(4000).default(1280),
        height: z.number().int().min(200).max(4000).default(1024),
        deviceScaleFactor: z.number().min(1).max(3).default(1),
      })
      .optional(),
    customCss: z.string().max(50_000).optional(),
    customScript: z.string().max(50_000).optional(),
    blockResources: z
      .array(
        z.enum([
          'image',
          'media',
          'font',
          'stylesheet',
          'script',
          'xhr',
          'fetch',
          'websocket',
          'eventsource',
          'manifest',
          'other',
        ]),
      )
      .optional(),
    extraHttpHeaders: z.record(z.string(), z.string().max(2048)).optional(),
    cookies: z
      .array(
        z.object({
          name: z.string(),
          value: z.string(),
          domain: z.string().optional(),
          path: z.string().optional(),
          httpOnly: z.boolean().optional(),
          secure: z.boolean().optional(),
        }),
      )
      .max(50)
      .optional(),
  })
  .strict();

const sourceShape = z
  .object({
    url: z.string().url().optional(),
    html: z.string().optional(),
    baseUrl: z.string().url().optional(),
  })
  .refine((v) => Boolean(v.url) !== Boolean(v.html), {
    message: 'Provide exactly one of `url` or `html`',
  });

export const ConvertRequestSchema = z
  .object({
    options: ConvertOptionsSchema.optional(),
    webhookUrl: z.string().url().optional(),
    metadata: z.record(z.string(), z.string().max(1024)).optional(),
  })
  .and(sourceShape);

export const JobIdParamSchema = z.object({
  id: z.string().regex(/^job_[0-9a-z]{21}$/),
});
