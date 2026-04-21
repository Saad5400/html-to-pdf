/**
 * htp — single-shot HTML/URL → PDF CLI.
 *
 * Examples:
 *   htp --url https://example.com --out out.pdf
 *   htp --html @input.html --landscape --format Letter --out out.pdf
 *   echo "<h1>Hi</h1>" | htp --out hi.pdf
 *   htp --url https://example.com > out.pdf
 *
 * No HTTP server, no Redis, no Docker — just Chromium under the hood.
 */
import { promises as fs } from 'node:fs';
import { pino } from 'pino';
import { loadConfig } from '../src/config/index.js';
import { BrowserPool, PdfRenderer } from '../src/services/pdf/index.js';
import type { ConvertOptions, ConvertRequest } from '../src/types/index.js';

interface CliArgs {
  url?: string;
  html?: string;
  out?: string;
  format?: string;
  landscape?: boolean;
  margin?: string;
  scale?: number;
  printBackground?: boolean;
  waitFor?: string;
  waitMs?: number;
  baseUrl?: string;
  emulateMedia?: 'screen' | 'print';
  header?: string;
  footer?: string;
  timeoutMs?: number;
  allowPrivate?: boolean;
  json?: boolean;
  quiet?: boolean;
  help?: boolean;
}

function usage(): string {
  return `htp — single-shot HTML/URL to PDF

Usage:
  htp [options]
  echo "<html>...</html>" | htp [options]

Source (exactly one of):
  --url <URL>              Render a remote URL
  --html <STRING|@file>    Render an HTML string, or @path to read from a file
                           (if neither given and stdin is piped, read stdin)

Output:
  --out <path>             Write PDF to file. Otherwise PDF goes to stdout.

Page options:
  --format <Letter|A4|A3|...>     Default: A4
  --landscape                     Landscape orientation
  --margin <value>                e.g. "10mm", "1in", "20px" (applied to all sides)
  --scale <0.1..2>                Default: 1
  --no-print-background           Disable background graphics
  --base-url <URL>                Base URL for relative refs in --html input
  --emulate-media <screen|print>  CSS @media to emulate (default: print)
  --wait-for <selector>           Wait for CSS selector before render
  --wait-ms <ms>                  Extra wait after navigation (max 15000)
  --header <html>                 Header template (uses Chromium's <span class>)
  --footer <html>                 Footer template
  --timeout-ms <ms>               Render budget (default: 30000)

Network:
  --allow-private                 Allow private/loopback target URLs

Output format:
  --json                          Print metadata JSON instead of PDF
  --quiet                         Suppress progress to stderr
  --help                          Show this help

Exit codes:
  0  Success
  2  Bad arguments
  3  Render error (timeout, SSRF, oversized, etc.)
`;
}

function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const next = (): string => {
      const v = argv[++i];
      if (v === undefined) {
        process.stderr.write(`error: ${a} requires a value\n`);
        process.exit(2);
      }
      return v;
    };
    switch (a) {
      case '-h':
      case '--help': out.help = true; break;
      case '--url': out.url = next(); break;
      case '--html': out.html = next(); break;
      case '--out': out.out = next(); break;
      case '--format': out.format = next(); break;
      case '--landscape': out.landscape = true; break;
      case '--margin': out.margin = next(); break;
      case '--scale': out.scale = Number(next()); break;
      case '--no-print-background': out.printBackground = false; break;
      case '--base-url': out.baseUrl = next(); break;
      case '--emulate-media': out.emulateMedia = next() as 'screen' | 'print'; break;
      case '--wait-for': out.waitFor = next(); break;
      case '--wait-ms': out.waitMs = Number(next()); break;
      case '--header': out.header = next(); break;
      case '--footer': out.footer = next(); break;
      case '--timeout-ms': out.timeoutMs = Number(next()); break;
      case '--allow-private': out.allowPrivate = true; break;
      case '--json': out.json = true; break;
      case '--quiet': out.quiet = true; break;
      default:
        process.stderr.write(`error: unknown argument ${JSON.stringify(a)}\n`);
        process.exit(2);
    }
  }
  return out;
}

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  return Buffer.concat(chunks).toString('utf8');
}

async function resolveHtml(arg: string | undefined): Promise<string | undefined> {
  if (!arg) return undefined;
  if (arg.startsWith('@')) return fs.readFile(arg.slice(1), 'utf8');
  return arg;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    process.stdout.write(usage());
    return;
  }

  let html = await resolveHtml(args.html);
  if (!html && !args.url) html = (await readStdin()) || undefined;

  if (Boolean(html) === Boolean(args.url)) {
    process.stderr.write('error: provide exactly one of --url or --html (or pipe HTML on stdin)\n');
    process.exit(2);
  }

  const log = (m: string): void => {
    if (!args.quiet) process.stderr.write(`[htp] ${m}\n`);
  };

  const config = loadConfig({
    LOG_LEVEL: 'silent',
    BROWSER_POOL_SIZE: '1',
    ...(args.timeoutMs ? { RENDER_TIMEOUT_MS: String(args.timeoutMs) } : {}),
    ...(args.allowPrivate ? { ALLOW_PRIVATE_NETWORKS: 'true' } : {}),
  });

  const logger = pino({ level: 'silent' });
  const pool = new BrowserPool({
    size: 1,
    idleTtlMs: 5_000,
    logger,
  });

  const opts: Partial<ConvertOptions> = {};
  if (args.format) opts.format = args.format as ConvertOptions['format'];
  if (args.landscape) opts.landscape = true;
  if (args.printBackground === false) opts.printBackground = false;
  if (args.scale !== undefined) opts.scale = args.scale;
  if (args.margin) opts.margin = { top: args.margin, right: args.margin, bottom: args.margin, left: args.margin };
  if (args.waitFor) opts.waitForSelector = args.waitFor;
  if (args.waitMs !== undefined) opts.waitForTimeoutMs = args.waitMs;
  if (args.emulateMedia) opts.emulateMedia = args.emulateMedia;
  if (args.header || args.footer) {
    opts.displayHeaderFooter = true;
    if (args.header) opts.headerTemplate = args.header;
    if (args.footer) opts.footerTemplate = args.footer;
  }

  const req: ConvertRequest = (
    args.url
      ? { url: args.url, options: opts }
      : { html: html!, ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}), options: opts }
  ) as ConvertRequest;

  log(`launching chromium...`);
  await pool.start();
  const renderer = new PdfRenderer(pool, config, logger);

  try {
    log(`rendering...`);
    const result = await renderer.render(req);
    log(`done: ${result.bytes} bytes, ${result.pages} pages, ${result.durationMs} ms`);
    if (args.json) {
      const sha = (await import('node:crypto')).createHash('sha256').update(result.pdf).digest('hex');
      const meta = { bytes: result.bytes, pages: result.pages, durationMs: result.durationMs, sha256: sha };
      process.stdout.write(JSON.stringify(meta, null, 2) + '\n');
    } else if (args.out) {
      await fs.writeFile(args.out, result.pdf);
      log(`wrote ${args.out}`);
    } else {
      // Binary to stdout — caller is responsible for redirecting.
      process.stdout.write(result.pdf);
    }
  } catch (err) {
    process.stderr.write(`[htp] ${(err as Error).name ?? 'Error'}: ${(err as Error).message}\n`);
    process.exit(3);
  } finally {
    await pool.stop();
  }
}

main().catch((err) => {
  process.stderr.write(`[htp] fatal: ${(err as Error).message ?? err}\n`);
  process.exit(1);
});
