# @saad5400/html-to-pdf

## ⚠️ FULLY VIBE CODDED ⚠️

[![npm version](https://img.shields.io/npm/v/@saad5400/html-to-pdf.svg)](https://www.npmjs.com/package/@saad5400/html-to-pdf)
[![CI](https://github.com/Saad5400/html-to-pdf/actions/workflows/ci.yml/badge.svg)](https://github.com/Saad5400/html-to-pdf/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Node >=22](https://img.shields.io/badge/node-%3E%3D22-brightgreen)](./.nvmrc)

Convert **HTML strings** or **URLs** to **PDF**. A hardened, Chromium-backed service with sync and async HTTP APIs, a one-shot CLI, pluggable storage, and first-class Docker support.

Built on **Fastify 5**, **Playwright (Chromium)**, **BullMQ**, and strict TypeScript.

- [Install](#install)
- [Quick start](#quick-start)
- [Run modes](#run-modes)
- [Usage](#usage)
- [CLI reference](#cli-reference)
- [API reference](#api-reference)
- [Render options](#render-options)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Security](#security)
- [Deployment](#deployment)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Install

Requires **Node.js ≥ 22**.

### From npm (CLI)

```bash
npm install -g @saad5400/html-to-pdf
npx playwright install chromium          # one-time Chromium download

htp --html '<h1>Hi</h1>' --out hi.pdf
htp --url https://example.com --landscape --out wide.pdf
```

Prefer no global install? `npx @saad5400/html-to-pdf --url https://example.com > out.pdf` works the same.

### From source (server + worker)

```bash
git clone https://github.com/Saad5400/html-to-pdf.git
cd html-to-pdf
npm install                              # installs deps + Chromium via Playwright
cp .env.example .env                     # rotate API_KEYS and SIGNED_URL_SECRET before leaving localhost
```

### Docker

```bash
docker compose up --build                # production-shaped API + worker + Redis
```

---

## Quick start

Pick the mode that fits your use case:

```bash
# One-shot CLI — no server, no infra
htp --html '<h1>Hi</h1>' --out hi.pdf

# Minimal HTTP — sync /v1/convert only, no Redis, no auth
npm run minimal
curl -X POST http://localhost:3000/v1/convert \
  -H 'content-type: application/json' \
  -d '{"html":"<h1>Hi</h1>"}' -o out.pdf

# Full local stack — sync + async + storage + playground UI (needs Docker for Redis)
make local                               # opens http://localhost:3000/playground

# Docker compose — production-shaped full stack
docker compose up --build
```

---

## Run modes

| Mode | Command | Endpoints | Needs |
|------|---------|-----------|-------|
| **CLI** | `htp ...` (or `npx @saad5400/html-to-pdf ...`) | — | Node + Chromium |
| **Minimal HTTP** | `npm run minimal` | `POST /v1/convert` only | Node + Chromium |
| **Local full stack** | `make local` | `convert` + `jobs` + `files` + `playground` | + Docker (Redis) |
| **Docker compose** | `docker compose up --build` | same as full stack, worker replicas | Docker |

The mode is selected by `MODE=full|minimal` in `.env`. Individual toggles (`ENABLE_QUEUE`, `ENABLE_STORAGE`, `ENABLE_RATE_LIMIT`, `AUTH_REQUIRED`) override the mode-derived defaults.

`/health/live`, `/health/ready`, `/metrics`, `/docs`, and `/playground` are always public.

---

## Usage

### CLI

```bash
# Piped HTML
echo '<h1>Hi</h1>' | htp --out hi.pdf

# Render a URL in landscape
htp --url https://example.com --landscape --out wide.pdf

# Read HTML from a file and add a header
htp --html @report.html \
  --header '<div style="font-size:9px">Report</div>' \
  --margin 20mm --out report.pdf

# Emit metadata as JSON (no PDF on stdout)
htp --url https://example.com --json --quiet

# Bypass install: one-shot via npx
npx @saad5400/html-to-pdf --url https://example.com > out.pdf
```

See [CLI reference](#cli-reference) for every flag. `htp --help` prints the same.

### Synchronous HTTP render

```bash
curl -sS -X POST http://localhost:3000/v1/convert \
  -H 'x-api-key: dev-key-change-me' \
  -H 'content-type: application/json' \
  -d '{"html":"<h1>Hello</h1>","options":{"format":"A4"}}' \
  -o out.pdf
```

The response body is the raw `application/pdf`. Use this for documents that render in under a few seconds.

### Asynchronous job

For long renders, large documents, or webhook delivery:

```bash
JOB=$(curl -sS -X POST http://localhost:3000/v1/jobs \
  -H 'x-api-key: dev-key-change-me' \
  -H 'idempotency-key: invoice-2026-0142' \
  -H 'content-type: application/json' \
  -d '{
        "url": "https://example.com",
        "webhookUrl": "https://my.app/webhooks/pdf",
        "metadata": {"tenant": "acme"}
      }' | jq -r .jobId)

curl -sS http://localhost:3000/v1/jobs/$JOB \
  -H 'x-api-key: dev-key-change-me' | jq
```

On completion, the job response contains a signed `downloadUrl`; a webhook POST is fired if `webhookUrl` was supplied.

### Webhooks

Delivered as a signed POST:

```
POST https://my.app/webhooks/pdf
X-Signature: t=1713700000,v1=<hex-hmac-sha256>
content-type: application/json

{ "jobId": "...", "status": "completed", "downloadUrl": "...", "metadata": {...} }
```

Signature covers `${t}.${rawBody}` with `WEBHOOK_SECRET`. Receivers **must** enforce a freshness window (±5 min suggested) and reject stale timestamps to prevent replay.

---

## CLI reference

```
htp [options]
echo "<html>...</html>" | htp [options]
```

The CLI spawns its own Chromium (via the Playwright install), runs a single render, and exits. No Redis, no queue, no auth.

### Source (exactly one)

| Flag | Description |
|---|---|
| `--url <URL>` | Render a remote URL. Subject to SSRF checks. |
| `--html <STRING\|@file>` | Render an inline HTML string, or `@path/to/file.html` to load from disk. |
| *(stdin)* | If neither flag is passed and stdin is piped, the CLI reads HTML from stdin. |

### Output

| Flag | Default | Description |
|---|---|---|
| `--out <path>` | — | Write PDF to a file. If omitted, the raw PDF is written to stdout. |
| `--json` | off | Print metadata JSON (`bytes`, `pages`, `durationMs`, `sha256`) instead of the PDF body. |
| `--quiet` | off | Suppress `[htp] ...` progress messages on stderr. |
| `-h`, `--help` | — | Print usage and exit. |

### Page geometry

| Flag | Default | Description |
|---|---|---|
| `--format <name>` | `A4` | Page size: `Letter`, `Legal`, `Tabloid`, `Ledger`, `A0`…`A6`. |
| `--landscape` | off | Landscape orientation. |
| `--margin <value>` | none | Applied to all four sides (e.g. `10mm`, `1in`, `20px`). For per-side margins, use the HTTP API. |
| `--scale <0.1..2>` | `1` | CSS zoom applied before paginating. |
| `--no-print-background` | on | Disable background graphics (colors, images). |
| `--base-url <URL>` | — | Base URL for relative `href`/`src` inside `--html` input. |
| `--emulate-media <screen\|print>` | `print` | CSS `@media` to emulate. |

### Content & timing

| Flag | Default | Description |
|---|---|---|
| `--wait-for <selector>` | — | Wait for a CSS selector to appear before rendering (sentinel for JS-rendered content). |
| `--wait-ms <ms>` | — | Extra wait after navigation completes. Capped at 15000. |
| `--header <html>` | — | Header template. Uses Chromium's `<span class="pageNumber">`, `"title"`, `"date"`, `"totalPages"` tokens. |
| `--footer <html>` | — | Footer template (same tokens as `--header`). |
| `--timeout-ms <ms>` | `30000` | Total render wall-clock budget. On expiry the page is force-closed and the CLI exits with code `3`. |

### Network

| Flag | Default | Description |
|---|---|---|
| `--allow-private` | off | Allow private / loopback / link-local target URLs. **Do not** pass this against untrusted input — it disables SSRF protection. |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Success |
| `1` | Fatal (unexpected crash) |
| `2` | Bad arguments |
| `3` | Render error (timeout, SSRF rejection, oversized output, etc.) |

For the full render option surface (per-side margins, cookies, extra headers, resource blocking, custom CSS/JS, viewport, `pageRanges`, `preferCSSPageSize`, `colorScheme`, `waitUntil`), use [`POST /v1/convert`](#api-reference) or `POST /v1/jobs` — the CLI exposes the most common subset.

---

## API reference

OpenAPI 3 is auto-generated and served live at `http://localhost:3000/docs` (Swagger UI). Emit a static spec with `make openapi`.

| Method | Path              | Purpose |
| ------ | ----------------- | ------- |
| POST   | `/v1/convert`     | Render PDF inline (sync). |
| POST   | `/v1/jobs`        | Enqueue async render. Supports `Idempotency-Key` header and `webhookUrl`. |
| GET    | `/v1/jobs/:id`    | Poll job status; returns signed `downloadUrl` when `status=completed`. |
| GET    | `/v1/files/:key`  | HMAC-signed download (local storage driver). |
| GET    | `/health/live`    | Liveness probe. |
| GET    | `/health/ready`   | Readiness — checks Redis + browser pool. |
| GET    | `/metrics`        | Prometheus exposition. |
| GET    | `/docs`           | Swagger UI. |
| GET    | `/playground`     | Interactive HTML→PDF editor (dev convenience). |

### Authentication

Protected routes require an API key via either header:

```
Authorization: Bearer <key>
x-api-key: <key>
```

Keys are listed in `API_KEYS` (comma-separated). Comparison is constant-time SHA-256-padded.

---

## Render options

All options live under `options` in the request body. Full schema in `src/schemas/convert.ts`.

```jsonc
{
  // Exactly one source:
  "url":     "https://example.com",
  "html":    "<h1>Hi</h1>",
  "baseUrl": "https://example.com/",  // resolve relative refs inside `html`

  "options": {
    // Page geometry
    "format":     "A4",               // Letter|Legal|Tabloid|Ledger|A0..A6
    "landscape":  false,
    "scale":      1,
    "margin":     { "top": "10mm", "bottom": "10mm" },
    "pageRanges": "1-3,5",
    "preferCSSPageSize": false,

    // Header/footer
    "displayHeaderFooter": false,
    "headerTemplate": "<div></div>",
    "footerTemplate": "<div style='font-size:8px'><span class='pageNumber'/></div>",

    // Content & timing
    "printBackground":  true,
    "waitUntil":        "networkidle",   // load|domcontentloaded|networkidle|commit
    "waitForSelector":  "#ready",
    "waitForTimeoutMs": 1000,
    "emulateMedia":     "print",
    "colorScheme":      "light",
    "viewport":         { "width": 1280, "height": 1024, "deviceScaleFactor": 1 },

    // Network & customization
    "blockResources":   ["image", "media", "font"],
    "extraHttpHeaders": { "Authorization": "Bearer ..." },
    "cookies":          [{ "name": "session", "value": "...", "domain": ".example.com" }],
    "customCss":        "body { font-family: sans-serif; }",
    "customScript":     "document.title = 'rendered';"
  },

  "webhookUrl": "https://my.app/webhooks/pdf",  // /v1/jobs only
  "metadata":   { "tenant": "acme" }            // echoed back in responses/webhooks
}
```

### Notes on render fidelity

- **Web fonts** (`@font-face`, Google Fonts `@import`) are awaited automatically — the renderer resolves `document.fonts.ready` after `networkidle`, so headings in remote faces always land correctly.
- **JS-rendered content** (KaTeX, MathJax, CDN-loaded charts) requires an explicit signal. `networkidle` only tracks the network, not DOM mutation. Either:
  - emit a sentinel element in your script's `onload` and pass `waitForSelector: '#ready'`, or
  - pad with `waitForTimeoutMs: 500` (cheaper, less robust).
- **Emoji, RTL (Arabic/Hebrew), CJK glyphs, SVG, complex flexbox/grid, multi-page tables with repeating headers, `@page` rules, headers/footers with page numbers** all work out of the box. See `scripts/visual-hard.ts` for the visual-regression battery.

---

## Configuration

Settings live in two places depending on how you run the tool:

- **Server / worker:** environment variables, validated at boot via Zod. Full list: [`.env.example`](./.env.example).
- **CLI (`htp`):** command-line flags. See the [CLI reference](#cli-reference) for the full list — the CLI does not read `.env` except for two escape hatches, `--timeout-ms` (overrides `RENDER_TIMEOUT_MS`) and `--allow-private` (overrides `ALLOW_PRIVATE_NETWORKS`).

### CLI flags at a glance

| Concern | Flag(s) |
|---|---|
| Source | `--url`, `--html` (or stdin) |
| Output | `--out`, `--json`, `--quiet` |
| Page | `--format`, `--landscape`, `--margin`, `--scale`, `--no-print-background`, `--base-url`, `--emulate-media` |
| Timing | `--wait-for`, `--wait-ms`, `--timeout-ms` |
| Chrome | `--header`, `--footer` |
| Network | `--allow-private` |

### Feature toggles

| Variable | Default | Effect |
|---|---|---|
| `MODE` | `full` | `full` = everything. `minimal` = sync `/v1/convert`, no Redis/storage/auth. |
| `ENABLE_QUEUE` | derived | Mounts `/v1/jobs/*`. Requires Redis. |
| `ENABLE_STORAGE` | derived | Mounts `/v1/files/:key` and enables async downloads. |
| `ENABLE_RATE_LIMIT` | derived | Per-key rate limiting (Redis-backed when available). |
| `AUTH_REQUIRED` | `true` (`false` in minimal) | Enforces API-key checks on protected routes. |

### Key settings

| Variable | Purpose |
|---|---|
| `API_KEYS` | Comma-separated list of valid keys. Rotate before production. |
| `SIGNED_URL_SECRET` | HMAC secret for local download URLs. Rejected at boot if default in `NODE_ENV=production`. |
| `WEBHOOK_SECRET` | HMAC secret for webhook signatures. |
| `STORAGE_DRIVER` | `local` \| `s3`. |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | S3-compatible (MinIO works). |
| `REDIS_URL`, `QUEUE_NAME`, `QUEUE_CONCURRENCY` | BullMQ. |
| `BROWSER_POOL_SIZE`, `BROWSER_IDLE_TTL_MS` | Chromium pool sizing. |
| `RENDER_TIMEOUT_MS`, `NAVIGATION_TIMEOUT_MS` | Render-time deadlines. |
| `MAX_CONTENT_BYTES`, `MAX_HTML_BYTES`, `MAX_PAGES_PER_DOC` | Hard safety caps. |
| `ALLOWED_URL_HOSTS`, `BLOCKED_URL_HOSTS`, `ALLOW_PRIVATE_NETWORKS` | SSRF allow/block. |
| `RATE_LIMIT_PER_MIN`, `REQUEST_BODY_LIMIT_MB` | Request shaping. |
| `TRUST_PROXY` | `true` \| `false` \| CSV of CIDRs. Never `true` unless ingress is authoritative for `X-Forwarded-For`. |

---

## Architecture

```
┌────────┐  POST /v1/convert       ┌──────────┐   pool    ┌──────────┐
│ client │ ──────────────────────► │  Fastify │ ────────► │ Chromium │
└────────┘                         │   API    │ ◄──────── │  pages   │
    │                              └────┬─────┘           └──────────┘
    │ POST /v1/jobs                     │
    ▼                                   ▼
┌────────┐                          Redis (BullMQ)
│ queue  │ ───────────────────────► ┌──────────┐
└────────┘                          │  worker  │ ──► storage (local | S3)
                                    └────┬─────┘
                                         │ signed POST
                                         ▼
                                   user webhook
```

Key modules:

- `src/services/pdf/browser-pool.ts` — fixed-capacity pool of Chromium `BrowserContext`s with idle TTL eviction and FIFO waiters.
- `src/services/pdf/renderer.ts` — orchestrates SSRF check, navigation, resource blocking, content-size accounting, page count, and PDF emission.
- `src/services/queue/index.ts` — BullMQ producer. `src/worker/index.ts` — consumer with content-addressed dedupe and webhook delivery.
- `src/security/ssrf.ts` — DNS-resolves the URL host, rejects private / loopback / link-local / multicast / CGNAT IPs unless explicitly allowed. Applied to **every** request Chromium makes, not just top-level navigation.

---

## Security

- **API auth** on everything except `/health/*`, `/metrics`, `/docs`, `/playground`. Keys compared in constant time.
- **SSRF defense in depth.** Every URL — top-level nav *and* every subresource Chromium tries to fetch — passes through `assertSafeUrl` and is then **pinned to the resolved IP** in `route.continue()` (Host header preserved). Closes the DNS-rebind window between the API check and Chromium's independent re-resolution.
- **Scheme allowlist.** `file:`, `javascript:`, `chrome:`, `view-source:` blocked at the same interceptor.
- **Private-network access** is denied unless `ALLOW_PRIVATE_NETWORKS=true`.
- **Render budget.** A wall-clock deadline races every awaited Playwright call, including `page.pdf`; on expiry the page is force-closed, surfacing as `RenderTimeoutError` (HTTP 504). An infinite-loop `customScript` cannot pin a worker.
- **Webhooks** are signed `X-Signature: t=<ts>,v1=<hmac>` over `${ts}.${body}`. Receivers must enforce a freshness window (±5 min).
- **Signed local downloads.** HMAC-signed with `SIGNED_URL_SECRET`, TTL-bounded; tampered signatures return 403.
- **Log redaction.** `Authorization` and `x-api-key` are redacted from structured logs.
- **Site isolation.** Chromium runs with `IsolateOrigins,site-per-process` enabled — the renderer's primary defense against malicious cross-origin reads in user-supplied HTML.
- **`--no-sandbox`** is required inside containers without user namespaces. `docker-compose.yml` compensates with read-only root filesystem, `cap_drop: ALL`, and `no-new-privileges`. For Kubernetes:
  ```yaml
  securityContext:
    readOnlyRootFilesystem: true
    allowPrivilegeEscalation: false
    runAsNonRoot: true
    capabilities: { drop: [ALL] }
  ```
- **Production guard.** Boot fails when `NODE_ENV=production` and `SIGNED_URL_SECRET` is still the default.

---

## Deployment

The provided `docker-compose.yml` is production-shaped: read-only root FS, dropped capabilities, separate API and worker services, Redis, optional MinIO.

```bash
cp .env.example .env
# Rotate API_KEYS, SIGNED_URL_SECRET, WEBHOOK_SECRET.
# Set NODE_ENV=production.
docker compose up --build -d
```

Scale workers horizontally — each worker reuses a Chromium pool and pulls from the same BullMQ queue. For Kubernetes, deploy API and worker as separate Deployments sharing the Redis Service; mirror the compose securityContext; add HPA on queue depth or CPU.

---

## Development

```bash
make install     # npm ci + playwright install
make local       # redis + server + worker + playground in one shot
make dev         # API only (watch mode)
make worker      # worker only (watch mode)
make test        # unit + integration (Vitest)
make test-e2e    # real-Chromium e2e suite
make loadtest    # quick autocannon-style load test (server must be up)
make visual      # render the visual battery to ./tmp/visual/
make openapi     # emit openapi.yaml
```

Code quality:

```bash
npm run lint
npm run lint:fix
npm run typecheck
npm run format
```

---

## Contributing

Bug reports and PRs welcome.

1. File an issue using the **Bug report** or **Feature request** template.
2. Fork, branch (`feat/...` or `fix/...`), commit.
3. Run `npm run lint && npm run typecheck && npm test` before opening the PR.
4. The PR template prompts for a description, test plan, and checklist.

Dependabot keeps npm, GitHub Actions, and the Docker base image current.

---

## License

[MIT](./LICENSE) © 2026 Saad5400
