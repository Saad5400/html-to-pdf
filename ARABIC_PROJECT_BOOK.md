# شرح عربي مختصر لمشروع `html-to-pdf`

هذا الملف شرح مضغوط مبني على الكود الفعلي في المشروع.  
الفكرة الأساسية: المشروع خدمة تحويل **HTML أو URL إلى PDF** مبنية على **Fastify + Playwright/Chromium + BullMQ/Redis**، وفيها أيضًا **CLI** مستقل، **تخزين محلي أو S3**، **حماية SSRF**، **metrics**، و**اختبارات**.

---

## 1. فكرة المشروع

المشروع يقدم 3 واجهات لنفس محرك الرندر:

1. `POST /v1/convert` لتحويل متزامن وإرجاع PDF مباشرة.
2. `POST /v1/jobs` مع `GET /v1/jobs/:id` لتحويل غير متزامن عبر queue + worker.
3. `./bin/htp` كأداة CLI بدون HTTP server.

الوصف في [package.json](./package.json):

```json
"description": "Production-grade HTML/URL to PDF conversion service"
```

---

## 2. أهم المكتبات المستخدمة

من [package.json](./package.json):

- `fastify`: خادم HTTP.
- `playwright`: تشغيل Chromium وتنفيذ الرندر.
- `bullmq` و`ioredis`: إدارة الـ jobs والطوابير.
- `zod`: التحقق من env والـ request body.
- `pino`: logging.
- `prom-client`: Prometheus metrics.
- `@aws-sdk/client-s3` و`@aws-sdk/s3-request-presigner`: دعم S3/MinIO.
- `nanoid`: توليد IDs.
- `argon2`: hashing للمفاتيح عند الحاجة.

المشروع يعمل على Node 22 حسب [.nvmrc](./.nvmrc) و`engines.node`.

---

## 3. هيكل المشروع

البنية الأساسية:

```text
src/
  app.ts
  server.ts
  config/
  lib/
  plugins/
  routes/
  schemas/
  security/
  services/
    auth/
    pdf/
    queue/
    storage/
  types/
  worker/
test/
scripts/
bin/
public/
```

التقسيم واضح:

- `routes`: الـ API endpoints
- `services/pdf`: الرندر والمتصفح
- `services/queue`: jobs + Redis + webhooks
- `services/storage`: local/S3
- `security`: limits + SSRF
- `worker`: تنفيذ الـ jobs

---

## 4. نقطة التشغيل

في [src/server.ts](/home/saad/PhpstormProjects/html-to-pdf/src/server.ts):

```ts
const config = getConfig();
const app = await buildApp(config);
await app.pool.start();
await app.server.listen({ host: config.HOST, port: config.PORT });
```

المعنى:

- قراءة الإعدادات
- بناء التطبيق
- تسخين Chromium مسبقًا
- بدء الاستماع

كما يوجد shutdown نظيف عبر `SIGTERM` و`SIGINT`.

---

## 5. بناء التطبيق

في [src/app.ts](/home/saad/PhpstormProjects/html-to-pdf/src/app.ts) يتم تركيب كل شيء:

- إنشاء `pino` logger مع إخفاء:

```ts
paths: ['req.headers.authorization', 'req.headers["x-api-key"]']
```

- إنشاء Fastify وتحديد `bodyLimit`.
- تسجيل `helmet`, `cors`, `sensible`.
- تفعيل `rate-limit` عند الحاجة.
- تفعيل Swagger على `/docs`.
- إنشاء:

```ts
const pool = new BrowserPool(...)
const renderer = new PdfRenderer(pool, config, loggerInstance);
```

- إنشاء storage وjobs وjob store حسب الـ feature toggles.
- تسجيل routes:
  - `/v1/convert`
  - `/v1/jobs`
  - `/v1/files`
  - `/health/*`
  - `/metrics`
  - `/playground`

---

## 6. الإعدادات

في [src/config/index.ts](/home/saad/PhpstormProjects/html-to-pdf/src/config/index.ts) يتم:

- parsing للأرقام والبوليانات من env
- تحديد defaults
- تفعيل/تعطيل features عبر `MODE=full|minimal`
- التحقق من صحة الإعدادات

أمثلة مهمة:

```ts
if (parsed.data.STORAGE_DRIVER === 's3' && !parsed.data.S3_BUCKET) {
  throw new Error('STORAGE_DRIVER=s3 requires S3_BUCKET');
}
```

و:

```ts
if (
  parsed.data.NODE_ENV === 'production' &&
  parsed.data.SIGNED_URL_SECRET === 'change-me-please-32-chars-min-secret'
) {
  throw new Error('SIGNED_URL_SECRET must be set to a real value in production');
}
```

الملف المرجعي للإعدادات هو [.env.example](./.env.example).

---

## 7. schema والأنواع

في [src/schemas/convert.ts](/home/saad/PhpstormProjects/html-to-pdf/src/schemas/convert.ts) يتم تعريف body الخاص بالتحويل.

القاعدة الأساسية:

```ts
.refine((v) => Boolean(v.url) !== Boolean(v.html), {
  message: 'Provide exactly one of `url` or `html`',
});
```

أي يجب إرسال **واحد فقط** من:

- `url`
- `html`

والخيارات تشمل:

- `format`
- `landscape`
- `printBackground`
- `margin`
- `waitUntil`
- `waitForSelector`
- `customCss`
- `customScript`
- `cookies`
- `extraHttpHeaders`

أما [src/types/index.ts](/home/saad/PhpstormProjects/html-to-pdf/src/types/index.ts) فيعرّف العقود الأساسية مثل:

- `ConvertRequest`
- `RenderResult`
- `JobRecord`
- `StorageAdapter`

---

## 8. أدوات المساعدة

### `src/lib/hash.ts`

يوفر:

- `sha256Hex`
- `hmacSign`
- `hmacVerify`
- `canonicalJson`

مثال:

```ts
export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
```

### `src/lib/id.ts`

يولد IDs مثل:

```ts
export function newJobId(): string {
  return `job_${nano()}`;
}
```

### `src/lib/semaphore.ts`

يوفر `KeyedSemaphore` لتقييد التوازي لكل host أو key معين.

---

## 9. المصادقة

في [src/plugins/auth.ts](/home/saad/PhpstormProjects/html-to-pdf/src/plugins/auth.ts):

```ts
const m = /^Bearer\s+(.+)$/i.exec(header);
const token = m?.[1] ?? (req.headers['x-api-key'] as string | undefined);
```

المشروع يدعم:

- `Authorization: Bearer ...`
- `x-api-key`

وفي [src/services/auth/api-key.ts](/home/saad/PhpstormProjects/html-to-pdf/src/services/auth/api-key.ts) يتم التحقق من مفاتيح `API_KEYS` القادمة من env مع مقارنة ثابتة زمنيًا:

```ts
return timingSafeEqual(ha, hb);
```

---

## 10. الحماية

### limits

في [src/security/limits.ts](/home/saad/PhpstormProjects/html-to-pdf/src/security/limits.ts):

- `assertHtmlSize`
- `assertContentSize`
- `assertPageCount`

وكلها ترمي `LimitExceededError`.

### SSRF

في [src/security/ssrf.ts](/home/saad/PhpstormProjects/html-to-pdf/src/security/ssrf.ts) يتم:

- السماح فقط بـ `http:` و`https:`
- رفض private/loopback/link-local/multicast/CGNAT
- دعم allowlist وblocklist
- تنفيذ DNS lookup قبل السماح

مثال:

```ts
const records = await dns.lookup(host, { all: true, verbatim: true });
addresses = records.map((r) => r.address);
```

ثم:

```ts
if (isPrivateAddress(addr)) {
  throw new SsrfError(`Resolves to private/reserved address: ${addr}`);
}
```

---

## 11. الرندر: قلب المشروع

### `src/services/pdf/browser-pool.ts`

هذا الملف يدير pool من `BrowserContext` بدل تشغيل Chromium جديد لكل طلب.

أهم النقاط:

- `chromium.launch(...)` مرة واحدة
- reuse للـ contexts
- queue للمنتظرين
- `PoolBackpressureError` عند امتلاء الانتظار
- تنظيف cookies/permissions بين الطلبات

مثال:

```ts
await entry.context.clearCookies().catch(() => {});
await entry.context.clearPermissions().catch(() => {});
```

### `src/services/pdf/options.ts`

يحوّل خيارات الـ API إلى صيغة Playwright PDF options.

مثال:

```ts
return typeof v === 'number' ? `${v}px` : v;
```

### `src/services/pdf/renderer.ts`

هذا هو الملف الأهم في المشروع.  
هو الذي:

1. يطبّق default options.
2. يفحص limits وSSRF.
3. يحصل على context من pool.
4. ينشئ `page`.
5. يركّب route interception لكل subresource.
6. ينفذ `goto` أو `setContent`.
7. يضيف CSS/JS مخصصين إن وُجدا.
8. ينفذ `page.pdf(...)`.
9. يتحقق من الحجم وعدد الصفحات.

من أهم الأسطر:

```ts
const pdfBuffer = await withBudget(page.pdf(buildPdfOptions(opts)));
```

وآلية timeout:

```ts
setTimeout(() => {
  timedOut = true;
  page!.close({ runBeforeUnload: false }).catch(() => {});
  reject(new RenderTimeoutError());
}, remaining());
```

وهذا مهم لأن المشروع لا يكتفي بتوقيت API، بل يغلق الصفحة نفسها إذا تجاوزت الميزانية الزمنية.

ومن أقوى النقاط الأمنية اعتراض كل request داخل الصفحة:

```ts
await page.route('**/*', async (route: Route) => {
```

ثم فحص SSRF وربط الـ host بـ IP resolved لمنع DNS rebind.

---

## 12. الراوترات

### `src/routes/convert.ts`

المسار:

```ts
f.post('/v1/convert', ...)
```

بعد المصادقة:

```ts
const result = await deps.renderer.render(req.body);
```

ويعيد PDF مع headers مثل:

- `x-pdf-pages`
- `x-pdf-sha256`
- `x-render-ms`

### `src/routes/jobs.ts`

المسارات:

- `POST /v1/jobs`
- `GET /v1/jobs/:id`

هذا الجزء:

```ts
const { jobId, deduped } = await deps.jobs.enqueue(candidateId, data);
```

يعني أن الطلب يدخل BullMQ، مع دعم `idempotency-key`.

وعند قراءة الحالة:

```ts
const url = await deps.storage.signedUrl(
  rec!.result.storageKey,
  deps.config.SIGNED_URL_TTL_SECONDS,
);
```

أي أن النتيجة النهائية تتضمن download URL موقّعًا.

### `src/routes/files.ts`

هذا route خاص بالتخزين المحلي، ويتحقق من:

- `exp`
- `sig`
- صلاحية التوقيع HMAC

### `src/routes/health.ts`

يوفر:

- `/health/live`
- `/health/ready`

والـ readiness يفحص Redis والمتصفح.

### `src/routes/playground.ts`

يقدّم ملف [public/playground.html](./public/playground.html) على `/playground`.

---

## 13. الطوابير والـ worker

### `src/services/queue/index.ts`

يحتوي:

- `getRedis`
- `JobsService`
- `idempotencyHash`

فكرة idempotency:

```ts
return createHash('sha256').update(`${apiKeyId}|${key}|${bodyDigest}`).digest('hex');
```

أي أن التطابق يعتمد على:

- tenant
- idempotency key
- request body

### `src/services/queue/job-store.ts`

يحفظ النتيجة النهائية في Redis حتى لو أزال BullMQ الـ job لاحقًا.

وهو لا يحفظ الـ HTML نفسه، بل فقط:

- status
- storage key
- sha256
- bytes
- pages

### `src/services/queue/webhook.ts`

يرسل webhooks موقعة:

```ts
const sig = `t=${ts},v1=${hmacSign(opts.secret, `${ts}.${body}`)}`;
```

مع retries وbackoff.

### `src/worker/index.ts`

هذا الملف يشغل Worker حقيقي:

- يقرأ config
- يبني pool وrenderer
- يبني storage وjobStore
- يحدّ concurrency لكل host عبر `KeyedSemaphore`
- يرندر
- يخزن PDF
- يكتب النتيجة
- يرسل webhook عند الحاجة

المفتاح التخزيني مبني على SHA:

```ts
const key = `pdfs/${tenant}/${sha.slice(0, 2)}/${sha.slice(2, 4)}/${sha}.pdf`;
```

وهذا يعني deduplication طبيعي للملفات المتطابقة.

---

## 14. التخزين

### `src/services/storage/local.ts`

هذا adapter يخزن الملفات على filesystem المحلي، مع حماية قوية ضد path traversal:

```ts
if (
  key.startsWith('/') ||
  key.includes('//') ||
  key.includes('..')
) {
  throw new Error('Invalid storage key');
}
```

كما يولد signed URLs محلية:

```ts
const path = `/v1/files/${encodeURIComponent(key)}?exp=${exp}&sig=${sig}`;
```

### `src/services/storage/s3.ts`

يدعم S3 أو MinIO عبر:

- `PutObjectCommand`
- `GetObjectCommand`
- `HeadObjectCommand`
- `DeleteObjectCommand`

ويولّد روابط presigned download.

---

## 15. المراقبة والأخطاء

### `src/plugins/metrics.ts`

يوفر:

- `http_requests_total`
- `http_request_duration_seconds`
- `pdf_render_bytes`
- `pdf_render_pages`
- `pdf_render_errors_total`

وكلها تُعرض على `/metrics`.

### `src/plugins/error-handler.ts`

يحوّل الأخطاء إلى HTTP responses واضحة:

- `validation_error`
- `ssrf_blocked`
- `limit_exceeded`
- `backpressure`
- `render_timeout`
- `render_failed`
- `internal_error`

---

## 16. الـ CLI والـ scripts

### `bin/htp.ts`

CLI مباشر لتحويل HTML/URL إلى PDF بدون API server.

يدعم:

- `--url`
- `--html`
- `--out`
- `--format`
- `--landscape`
- `--margin`
- `--wait-for`
- `--wait-ms`
- `--header`
- `--footer`
- `--json`

ويعيد استخدام نفس `PdfRenderer`.

### `scripts/emit-openapi.ts`

يبني التطبيق ثم يخرج swagger JSON.

### `scripts/loadtest.ts`

مولد حمل بسيط لقياس:

- RPS
- p50/p90/p95/p99
- الأخطاء

### `scripts/visual-render.ts`

بطارية رندر حقيقية تنتج PDFs مرجعية داخل `tmp/visual/`.

### `scripts/local.sh`

يشغل Redis محليًا، ثم worker، ثم API، ثم يفتح `/playground`.

---

## 17. التشغيل والبنية التحتية

### `Dockerfile`

ملف multi-stage:

- مرحلة build على `node:22-bookworm-slim`
- مرحلة runtime على `mcr.microsoft.com/playwright:v1.47.2-noble`

مع healthcheck على:

```text
/health/ready
```

### `docker-compose.yml`

يشغل:

- `app`
- `worker`
- `redis`
- `minio` عبر profile `s3`

### `Makefile`

يوفّر أوامر مختصرة مثل:

- `make local`
- `make dev`
- `make worker`
- `make test`
- `make test-e2e`
- `make loadtest`
- `make visual`

---

## 18. الاختبارات

المشروع يغطي 3 مستويات:

### Unit

يغطي:

- config parsing
- semaphore
- webhook signing
- browser pool
- files route
- job store
- hash utils
- options/schema
- idempotency
- SSRF
- limits
- local storage
- page count

### Integration

في `test/integration/http.test.ts` يتم اختبار HTTP API مع mocking لبعض الاعتمادات.

### E2E

في `test/e2e/render.e2e.test.ts` و`test/e2e/hostile.e2e.test.ts` يتم اختبار:

- رندر HTML حقيقي
- page breaks
- private IP blocking
- subresource SSRF blocking
- infinite JS loop timeout
- oversized HTML
- `javascript:` navigation blocking

ومن [vitest.config.ts](./vitest.config.ts) توجد thresholds للتغطية:

```ts
lines: 80,
functions: 80,
branches: 75,
statements: 80,
```

---

## 19. الواجهة التجريبية

ملف [public/playground.html](./public/playground.html) هو عميل بسيط يرسل الطلب إلى:

```js
const res = await fetch('/v1/convert', {
  method:'POST',
  headers:{ 'content-type':'application/json', 'x-api-key': $('key').value },
  body: JSON.stringify(body),
});
```

ثم يعرض الـ PDF داخل `iframe`.

---

## 20. الخلاصة

المشروع مصمم بعقلية إنتاجية واضحة:

- محرك رندر واحد reused بين API وworker وCLI
- فصل جيد بين routes والخدمات والبنية التحتية
- حماية قوية ضد SSRF
- queue + worker + storage للمسارات الثقيلة
- مراقبة وتشغيل جيدان
- اختبارات متعددة المستويات

أهم ملفين لفهم المشروع بسرعة:

1. [src/app.ts](/home/saad/PhpstormProjects/html-to-pdf/src/app.ts)
2. [src/services/pdf/renderer.ts](/home/saad/PhpstormProjects/html-to-pdf/src/services/pdf/renderer.ts)

ثم بعدهما:

1. [src/routes/jobs.ts](/home/saad/PhpstormProjects/html-to-pdf/src/routes/jobs.ts)
2. [src/worker/index.ts](/home/saad/PhpstormProjects/html-to-pdf/src/worker/index.ts)
3. [src/security/ssrf.ts](/home/saad/PhpstormProjects/html-to-pdf/src/security/ssrf.ts)

