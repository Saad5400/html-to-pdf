# html-to-pdf

A production-grade service for converting **HTML strings** or **URLs** to **PDF**, built on Fastify, Playwright (Chromium), and BullMQ.

## Highlights

- **High-fidelity rendering** — Chromium via Playwright handles modern CSS, web fonts, JavaScript, SVG, MathML.
- **Sync + async APIs** — `POST /v1/convert` returns a PDF inline; `POST /v1/jobs` returns a job ID for long renders, with optional webhook callback.
- **Hardened by default** — SSRF guard with DNS-resolved private/loopback/link-local/multicast/CGNAT blocking, configurable allow/block hostlists, content/HTML/page size caps, helmet, rate limiting per API key.
- **Pluggable storage** — local filesystem (HMAC-signed download URLs) or any S3-compatible bucket (presigned URLs). MinIO works out of the box.
- **Operability** — Prometheus metrics at `/metrics`, structured JSON logs (pino) with auth header redaction, `/health/live` & `/health/ready` probes, OpenAPI 3 served at `/docs`, graceful SIGTERM shutdown.
- **Efficient** — pooled, reused Chromium contexts with idle eviction; sha256-content-addressed storage deduplicates identical renders.
- **Strict TypeScript** — `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`. Validated env config via Zod; validated request schemas via Zod + `fastify-type-provider-zod`.
- **Tested** — Vitest unit + integration suites with ≥80% coverage threshold, separate Playwright-driven e2e suite.

## Run modes — pick the one that fits

| Mode | Command | What you get | What you need |
|------|---------|--------------|---------------|
| **CLI (one-shot)** | `./bin/htp --html '<h1>Hi</h1>' --out hi.pdf` | Convert one document. No server. | Just Node + Chromium |
| **Minimal HTTP** | `npm run minimal` | `POST /v1/convert` → PDF inline. No auth. | **No Redis. No storage.** |
| **Local full stack** | `make local` | Sync + async + storage + playground UI. Opens browser. | Docker (for Redis) |
| **Docker compose** | `docker compose up --build` | Full stack with worker replicas, Redis, optional MinIO. | Docker |

### CLI examples

```bash
echo '<h1>Hi</h1>' | ./bin/htp --out hi.pdf
./bin/htp --url https://example.com --landscape --out wide.pdf
./bin/htp --html @report.html --header '<div style="font-size:9px">Header</div>' --margin 20mm --out report.pdf
./bin/htp --url https://example.com --json --quiet         # metadata only
```

### Minimal-mode HTTP

Pure sync, no infrastructure. Boots in <2s on first request. Ideal for
embedding in an app via internal HTTP, for CI, or for self-hosting on a
single VM.

```bash
npm run minimal
# → POST http://localhost:3000/v1/convert  (no auth, returns PDF inline)
curl -X POST http://localhost:3000/v1/convert \
  -H 'content-type: application/json' \
  -d '{"html":"<h1>Hi</h1>"}' -o out.pdf
```

`/v1/jobs` and `/v1/files` are deliberately absent in this mode (404).
Set `MODE=full` (or individual `ENABLE_QUEUE=true`/`ENABLE_STORAGE=true`)
to opt into them.

### Local full stack with playground UI

```bash
make local      # or: npm run local
```

This boots Redis (Docker), the API server, and a worker, then opens
**http://localhost:3000/playground** — a live HTML editor with a side-by-side
PDF preview. Edit the HTML, hit ⌘/Ctrl+Enter, see the PDF instantly.

### Docker compose (production-shaped)

```bash
cp .env.example .env
docker compose up --build
```

Convert HTML synchronously:

```bash
curl -sS -X POST http://localhost:3000/v1/convert \
  -H 'x-api-key: dev-key-change-me' \
  -H 'content-type: application/json' \
  -d '{"html":"<h1>Hello</h1>","options":{"format":"A4"}}' \
  -o out.pdf
```

Convert a URL asynchronously and poll for completion:

```bash
JOB=$(curl -sS -X POST http://localhost:3000/v1/jobs \
  -H 'x-api-key: dev-key-change-me' \
  -H 'idempotency-key: my-unique-key-1' \
  -H 'content-type: application/json' \
  -d '{"url":"https://example.com"}' | jq -r .jobId)

curl -sS http://localhost:3000/v1/jobs/$JOB \
  -H 'x-api-key: dev-key-change-me' | jq
```

## API

OpenAPI is auto-generated and live at `http://localhost:3000/docs`.

| Method | Path                     | Purpose |
| ------ | ------------------------ | ------- |
| POST   | `/v1/convert`            | Render PDF inline (sync) |
| POST   | `/v1/jobs`               | Enqueue async render; supports `Idempotency-Key` and `webhookUrl` |
| GET    | `/v1/jobs/:id`           | Job status + signed download URL on completion |
| GET    | `/v1/files/:key`         | HMAC-signed local download (when `STORAGE_DRIVER=local`) |
| GET    | `/health/live`           | Liveness |
| GET    | `/health/ready`          | Readiness (Redis + browser pool) |
| GET    | `/metrics`               | Prometheus exposition |
| GET    | `/docs`                  | Swagger UI |
| GET    | `/playground`            | Interactive HTML→PDF editor (dev convenience) |

### Convert request body

See `src/schemas/convert.ts` for the full Zod schema. Key options:

```jsonc
{
  "url":   "https://example.com",   // OR
  "html":  "<h1>Hi</h1>",            // exactly one required
  "baseUrl": "https://example.com/", // optional, used to resolve relative refs in `html`
  "options": {
    "format": "A4",                  // Letter|Legal|Tabloid|Ledger|A0..A6
    "landscape": false,
    "printBackground": true,
    "scale": 1,
    "margin": { "top": "10mm", "bottom": "10mm" },
    "pageRanges": "1-3,5",
    "displayHeaderFooter": false,
    "headerTemplate": "<div></div>",
    "footerTemplate": "<div style='font-size:8px'><span class='pageNumber'/></div>",
    "preferCSSPageSize": false,
    "waitUntil": "networkidle",      // load|domcontentloaded|networkidle|commit
    "waitForSelector": "#ready",
    "waitForTimeoutMs": 1000,
    "emulateMedia": "print",
    "colorScheme": "light",
    "viewport": { "width": 1280, "height": 1024, "deviceScaleFactor": 1 },
    "blockResources": ["image", "media", "font"],
    "extraHttpHeaders": { "Authorization": "Bearer ..." },
    "cookies": [{ "name": "session", "value": "...", "domain": ".example.com" }],
    "customCss": "body { font-family: sans-serif; }",
    "customScript": "document.title = 'rendered';"
  },
  "webhookUrl": "https://my.app/webhooks/pdf",
  "metadata":   { "tenant": "acme" }
}
```

## Architecture

```
┌───────┐   POST /v1/convert      ┌───────────┐    pool    ┌──────────┐
│client │ ─────────────────────►  │  Fastify  │ ─────────► │ Chromium │
└───────┘                         │   API     │ ◄───────── │  pages   │
   │                              └─────┬─────┘            └──────────┘
   │ POST /v1/jobs                      │
   ▼                                    ▼
┌──────┐                             Redis (BullMQ)
│queue │ ────────────────────────► ┌───────────┐
└──────┘                           │  worker   │ ───► storage (local|S3)
                                   └───────────┘
```

- `src/services/pdf/browser-pool.ts` — fixed-capacity pool of `BrowserContext`s with idle TTL eviction; waiters queued FIFO.
- `src/services/pdf/renderer.ts` — orchestrates SSRF check, navigation, resource blocking, content-size accounting, page count, and PDF emission.
- `src/services/queue/index.ts` — BullMQ producer; `src/worker/index.ts` — consumer with content-addressed dedupe and webhook delivery.
- `src/security/ssrf.ts` — DNS-resolves the URL host and rejects private/loopback/link-local/multicast/CGNAT IPs unless explicitly allowed.

## Notes on rendering quality

- **Web fonts** (`@font-face`, Google Fonts `@import`) are awaited automatically — the renderer calls `document.fonts.ready` after `networkidle` so headings styled with remote fonts always render in the intended face.
- **JS-rendered content** (KaTeX, MathJax, charts that paint after a CDN script loads) needs an explicit signal. `networkidle` only knows about the network, not that an inline script has finished mutating the DOM. Either:
  - Add a sentinel element to your script's `onload` and pass `waitForSelector: '#ready'`, or
  - Pad with `waitForTimeoutMs: 500` (cheap, less robust).
- **Emoji, RTL (Arabic/Hebrew), CJK glyphs, SVG, complex flexbox/grid, multi-page tables with repeating headers, `@page` rules, `displayHeaderFooter` with page numbers** all work out of the box (verified by the visual hard battery in `scripts/visual-hard.ts`).

## Configuration

All knobs are environment variables, validated at boot. See [`.env.example`](./.env.example).

### Feature toggles

| Var | Default | Effect |
|-----|---------|--------|
| `MODE` | `full` | `full` = all features. `minimal` = sync-only, no Redis, no storage, no auth. |
| `ENABLE_QUEUE` | derived from MODE | Mounts `/v1/jobs/*`; requires Redis. |
| `ENABLE_STORAGE` | derived from MODE | Mounts `/v1/files/:key` (local driver) or S3; required for async result downloads. |
| `ENABLE_RATE_LIMIT` | derived from MODE | Per-key rate limiting (Redis backend if queue is on, in-memory otherwise). |
| `AUTH_REQUIRED` | `true` (false in minimal) | API-key checks on protected routes. |

`/health/*`, `/metrics`, `/docs`, `/playground` are always public; the convert and jobs endpoints honor `AUTH_REQUIRED`.

## Security

- All routes (except `/health/*`, `/metrics`, `/docs`, `/playground`) require an API key in `Authorization: Bearer <key>` or `x-api-key`.
- API keys are compared with constant-time SHA-256-padded equality.
- **SSRF defense in depth**: every URL — top-level navigation *and* every subresource Chromium tries to fetch — passes through `assertSafeUrl` and is then **pinned to the resolved IP** in `route.continue()` (with the original `Host` header preserved). This closes the DNS-rebind window between the API check and Chromium's independent re-resolution.
- Non-`http(s)` schemes (`file:`, `javascript:`, `chrome:`, `view-source:`) are blocked at the same interceptor.
- Direct private-network access is denied unless `ALLOW_PRIVATE_NETWORKS=true`.
- **Render budget**: a wall-clock deadline races every awaited Playwright call (including `page.pdf`); on expiry the page is force-closed, surfacing as `RenderTimeoutError` (HTTP 504). An infinite-loop `customScript` cannot pin a worker.
- Webhooks are signed `X-Signature: t=<ts>,v1=<hmac>` over `${ts}.${body}`. Receivers MUST enforce a freshness window (suggested ±5 min) to prevent replay.
- Local storage download URLs are HMAC-signed with `SIGNED_URL_SECRET` and TTL-bounded; tampered signatures return 403.
- Sensitive request headers (Authorization, x-api-key) are redacted from logs.
- Browser runs with **Chromium site isolation enabled** (`IsolateOrigins,site-per-process` is no longer disabled). This is the renderer's primary defense against malicious HTML cross-origin reads.
- Browser is launched with `--no-sandbox` (required inside containers without user namespaces). The provided `docker-compose.yml` compensates with **read-only root filesystem**, **cap_drop:ALL**, and **no-new-privileges**. For Kubernetes, mirror these with `securityContext: {readOnlyRootFilesystem: true, capabilities: {drop: [ALL]}, allowPrivilegeEscalation: false, runAsNonRoot: true}` and add per-pod memory/CPU limits.
- The default `SIGNED_URL_SECRET` is rejected at boot when `NODE_ENV=production`.
- `TRUST_PROXY` accepts `true|false|<comma-separated CIDR list>` — never set `true` if your ingress isn't authoritative for `X-Forwarded-For`.

## Development

```bash
make install         # npm ci + playwright install
make local           # one-shot: redis + server + worker + playground
make dev             # API only
make worker          # worker only
make test            # unit + integration (Vitest)
make test-e2e        # real Chromium e2e tests
make loadtest        # quick autocannon-style load test (assumes server up)
make visual          # render the 8-sample visual battery to ./tmp/visual/
make openapi         # emit openapi.yaml
```

## License

MIT
