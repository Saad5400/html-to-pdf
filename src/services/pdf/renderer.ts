import { isIP } from 'node:net';
import type { Logger } from 'pino';
import type { BrowserContext, Page, Route } from 'playwright';
import type { Config } from '@/config/index.js';
import { assertContentSize, assertHtmlSize, assertPageCount, LimitExceededError } from '@/security/limits.js';
import { assertSafeUrl, SsrfError } from '@/security/ssrf.js';
import type { ConvertOptions, ConvertRequest, RenderResult } from '@/types/index.js';
import { BrowserPool } from './browser-pool.js';
import { buildPdfOptions } from './options.js';

export class RenderError extends Error {
  public readonly originalCause?: unknown;
  constructor(message: string, originalCause?: unknown) {
    super(message);
    this.name = 'RenderError';
    if (originalCause !== undefined) this.originalCause = originalCause;
  }
}

export class RenderTimeoutError extends RenderError {
  constructor() {
    super('Render exceeded wall-clock budget');
    this.name = 'RenderTimeoutError';
  }
}

const SET_CONTENT_WAITS = new Set(['load', 'domcontentloaded', 'networkidle']);

/**
 * Pins a request URL to its already-resolved IP, preserving the original Host
 * header so virtual hosting still works. This closes the DNS-rebind window
 * between our `assertSafeUrl` lookup and Chromium's independent re-resolution.
 */
export function pinHostToIp(originalUrl: string, ip: string): { url: string; host: string } {
  const u = new URL(originalUrl);
  const host = u.host; // includes :port if non-default
  const isV6 = isIP(ip) === 6;
  u.hostname = isV6 ? `[${ip}]` : ip;
  return { url: u.toString(), host };
}

export class PdfRenderer {
  constructor(
    private readonly pool: BrowserPool,
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async render(req: ConvertRequest): Promise<RenderResult> {
    const opts: ConvertOptions = {
      format: 'A4',
      landscape: false,
      printBackground: true,
      scale: 1,
      displayHeaderFooter: false,
      preferCSSPageSize: false,
      waitUntil: 'networkidle',
      emulateMedia: 'print',
      colorScheme: 'light',
      ...req.options,
    } as ConvertOptions;

    const start = Date.now();
    const ssrfPolicy = {
      allowedHosts: this.config.ALLOWED_URL_HOSTS,
      blockedHosts: this.config.BLOCKED_URL_HOSTS,
      allowPrivateNetworks: this.config.ALLOW_PRIVATE_NETWORKS,
    };

    if (req.html) assertHtmlSize(req.html, this.config.MAX_HTML_BYTES);
    if (req.url) await assertSafeUrl(req.url, ssrfPolicy);

    const deadline = Date.now() + this.config.RENDER_TIMEOUT_MS;
    const remaining = (): number => Math.max(1, deadline - Date.now());

    let context: BrowserContext | undefined;
    let page: Page | undefined;
    let renderedBytes = 0;
    let needsDiscard = false;

    try {
      context = await this.pool.checkout();
      page = await context.newPage();
      page.setDefaultNavigationTimeout(this.config.NAVIGATION_TIMEOUT_MS);
      page.setDefaultTimeout(this.config.NAVIGATION_TIMEOUT_MS);

      if (opts.viewport) await page.setViewportSize(opts.viewport);
      if (opts.extraHttpHeaders) await page.setExtraHTTPHeaders(opts.extraHttpHeaders);

      const cookies = (opts.cookies ?? [])
        .map((c) => {
          const base = {
            name: c.name,
            value: c.value,
            path: c.path ?? '/',
            ...(c.httpOnly !== undefined ? { httpOnly: c.httpOnly } : {}),
            ...(c.secure !== undefined ? { secure: c.secure } : {}),
            sameSite: 'Lax' as const,
          };
          if (c.domain) return { ...base, domain: c.domain };
          if (req.url) return { ...base, url: req.url };
          if (req.baseUrl) return { ...base, url: req.baseUrl };
          return undefined;
        })
        .filter((c): c is NonNullable<typeof c> => Boolean(c));
      if (cookies.length) await context.addCookies(cookies);

      const blocked = new Set<string>(opts.blockResources ?? []);
      const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);
      await page.route('**/*', async (route: Route) => {
        const reqUrl = route.request().url();
        const resourceType = route.request().resourceType();
        if (blocked.has(resourceType)) return route.abort();
        if (reqUrl.startsWith('data:') || reqUrl.startsWith('about:') || reqUrl.startsWith('blob:'))
          return route.continue();
        // Reject anything not http(s) outright (file://, javascript:, chrome:, view-source:, ftp:).
        try {
          const parsed = new URL(reqUrl);
          if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) return route.abort('blockedbyclient');
        } catch {
          return route.abort('blockedbyclient');
        }
        try {
          const resolved = await assertSafeUrl(reqUrl, ssrfPolicy);
          const ip = resolved.addresses[0];
          if (!ip) return route.abort('addressunreachable');
          // Pin only for HTTP. For HTTPS, IP substitution breaks SNI and TLS
          // hostname verification — and DNS rebinding on HTTPS is much harder
          // (the attacker would need a valid cert for the original hostname
          // pointing at the rebound IP). Cert validation is the second line.
          const parsedReq = new URL(reqUrl);
          if (parsedReq.protocol === 'http:') {
            const { url: pinned, host } = pinHostToIp(reqUrl, ip);
            const headers = { ...route.request().headers(), host };
            return route.continue({ url: pinned, headers });
          }
          return route.continue();
        } catch {
          return route.abort('blockedbyclient');
        }
      });

      page.on('response', (res) => {
        const len = Number(res.headers()['content-length'] ?? 0);
        if (Number.isFinite(len)) renderedBytes += Math.max(0, len);
      });

      await page.emulateMedia({
        media: opts.emulateMedia,
        colorScheme: opts.colorScheme === 'no-preference' ? null : opts.colorScheme,
      });

      // Wall-clock guard: closes the page (which rejects in-flight ops) when
      // the budget runs out. This is the *only* reliable kill switch for an
      // infinite-loop script — page.pdf itself takes no AbortSignal.
      let timedOut = false;
      const fireBudget = (): Promise<never> =>
        new Promise<never>((_, reject) => {
          const t = setTimeout(() => {
            timedOut = true;
            page!.close({ runBeforeUnload: false }).catch(() => {});
            reject(new RenderTimeoutError());
          }, remaining());
          t.unref?.();
        });
      const withBudget = <T>(work: Promise<T>): Promise<T> =>
        Promise.race([work, fireBudget()]);

      if (req.url) {
        await withBudget(
          page.goto(req.url, {
            waitUntil: opts.waitUntil,
            timeout: Math.min(this.config.NAVIGATION_TIMEOUT_MS, remaining()),
          }),
        );
      } else {
        const html = req.baseUrl ? injectBaseTag(req.html!, req.baseUrl) : req.html!;
        const setContentWait = opts.waitUntil === 'commit' ? 'domcontentloaded' : opts.waitUntil;
        if (!SET_CONTENT_WAITS.has(setContentWait)) {
          throw new RenderError(`Invalid waitUntil for HTML input: ${setContentWait}`);
        }
        await withBudget(
          page.setContent(html, {
            waitUntil: setContentWait as 'load' | 'domcontentloaded' | 'networkidle',
            timeout: Math.min(this.config.NAVIGATION_TIMEOUT_MS, remaining()),
          }),
        );
      }

      if (renderedBytes > this.config.MAX_CONTENT_BYTES) {
        throw new LimitExceededError(
          `Network bytes exceeded (${renderedBytes} > ${this.config.MAX_CONTENT_BYTES})`,
        );
      }

      if (opts.waitForSelector) {
        await withBudget(
          page.waitForSelector(opts.waitForSelector, {
            timeout: Math.min(this.config.NAVIGATION_TIMEOUT_MS, remaining()),
          }),
        );
      }
      if (opts.waitForTimeoutMs) {
        await page.waitForTimeout(Math.min(opts.waitForTimeoutMs, remaining()));
      }

      if (opts.customCss) {
        await withBudget(page.addStyleTag({ content: opts.customCss }));
      }
      if (opts.customScript) {
        await withBudget(page.addScriptTag({ content: opts.customScript }));
      }

      // Web-font race fix: networkidle resolves before document.fonts settles
      // for fonts loaded via @font-face/@import. Without this wait, headings
      // styled with Google Fonts often render in fallback faces. Cheap (~10ms)
      // when fonts are already ready; saves a class of rendering bugs that
      // are hard to debug from the user side. Inlined as a string to avoid
      // pulling DOM types into the build (the eval runs inside Chromium).
      await withBudget(
        page.evaluate(
          `('fonts' in document) ? document.fonts.ready.then(() => undefined) : undefined`,
        ),
      ).catch(() => undefined);

      const pdfBuffer = await withBudget(page.pdf(buildPdfOptions(opts)));

      if (timedOut) throw new RenderTimeoutError();

      assertContentSize(pdfBuffer.byteLength, this.config.MAX_CONTENT_BYTES);
      const pages = countPdfPages(pdfBuffer);
      assertPageCount(pages, this.config.MAX_PAGES_PER_DOC);

      return {
        pdf: pdfBuffer,
        pages,
        bytes: pdfBuffer.byteLength,
        durationMs: Date.now() - start,
      };
    } catch (err) {
      needsDiscard = true;
      if (
        err instanceof SsrfError ||
        err instanceof LimitExceededError ||
        err instanceof RenderError
      ) {
        throw err;
      }
      const message = err instanceof Error ? err.message : 'Render failed';
      throw new RenderError(message, err);
    } finally {
      if (page) await page.close({ runBeforeUnload: false }).catch(() => {});
      if (context) {
        if (needsDiscard) await this.pool.discard(context);
        else await this.pool.release(context);
      }
    }
  }
}

export function injectBaseTag(html: string, baseHref: string): string {
  const tag = `<base href="${baseHref.replace(/"/g, '&quot;')}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}${tag}`);
  if (/<html[^>]*>/i.test(html))
    return html.replace(/<html[^>]*>/i, (m) => `${m}<head>${tag}</head>`);
  return `<head>${tag}</head>${html}`;
}

export function countPdfPages(pdf: Buffer): number {
  const WINDOW = 65_536;
  const headLen = Math.min(pdf.length, WINDOW);
  const tailStart = Math.max(headLen, pdf.length - WINDOW);
  const HEAD = pdf.subarray(0, headLen).toString('latin1');
  const TAIL = tailStart < pdf.length ? pdf.subarray(tailStart).toString('latin1') : '';
  const re = /\/Type\s*\/Pages[^>]*\/Count\s+(\d+)/m;
  const m = re.exec(HEAD) ?? (TAIL ? re.exec(TAIL) : null);
  if (m) return Number(m[1]);
  const tally =
    (HEAD.match(/\/Type\s*\/Page(?!s)/g) ?? []).length +
    (TAIL.match(/\/Type\s*\/Page(?!s)/g) ?? []).length;
  return Math.max(1, tally);
}
