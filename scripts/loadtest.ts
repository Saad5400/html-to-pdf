/**
 * Simple load generator for the sync /v1/convert endpoint. No external deps —
 * spawns N concurrent in-flight requests and reports throughput + latency
 * percentiles. Run against an already-running server.
 *
 *   API_KEY=dev-key-change-me TARGET=http://localhost:3000 \
 *   CONCURRENCY=8 DURATION_MS=15000 npx tsx scripts/loadtest.ts
 */

const TARGET = process.env.TARGET ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? 'dev-key-change-me';
const CONCURRENCY = Number(process.env.CONCURRENCY ?? '4');
const DURATION_MS = Number(process.env.DURATION_MS ?? '10000');
const PAYLOAD = JSON.stringify({
  html: `<!doctype html><html><body style="font-family:sans-serif;padding:24px"><h1>Load test</h1>${'<p>x</p>'.repeat(50)}</body></html>`,
});

interface SampleStat {
  ms: number;
  ok: boolean;
  status: number;
  bytes: number;
}

async function worker(stop: { value: boolean }, samples: SampleStat[]): Promise<void> {
  while (!stop.value) {
    const start = performance.now();
    try {
      const res = await fetch(`${TARGET}/v1/convert`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': API_KEY,
        },
        body: PAYLOAD,
      });
      const buf = await res.arrayBuffer();
      samples.push({
        ms: performance.now() - start,
        ok: res.ok,
        status: res.status,
        bytes: buf.byteLength,
      });
    } catch (err) {
      samples.push({
        ms: performance.now() - start,
        ok: false,
        status: 0,
        bytes: 0,
      });
      void err;
    }
  }
}

function percentile(sorted: number[], p: number): number {
  if (!sorted.length) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return sorted[idx]!;
}

async function main(): Promise<void> {
  const samples: SampleStat[] = [];
  const stop = { value: false };
  const workers = Array.from({ length: CONCURRENCY }, () => worker(stop, samples));
  setTimeout(() => {
    stop.value = true;
  }, DURATION_MS).unref?.();
  await Promise.all(workers);

  const ok = samples.filter((s) => s.ok);
  const lat = ok.map((s) => s.ms).sort((a, b) => a - b);
  const errors = samples.length - ok.length;
  process.stdout.write(
    JSON.stringify(
      {
        target: TARGET,
        concurrency: CONCURRENCY,
        durationMs: DURATION_MS,
        totalRequests: samples.length,
        successes: ok.length,
        errors,
        rps: ok.length / (DURATION_MS / 1000),
        latencyMs: {
          p50: Number(percentile(lat, 50).toFixed(1)),
          p90: Number(percentile(lat, 90).toFixed(1)),
          p95: Number(percentile(lat, 95).toFixed(1)),
          p99: Number(percentile(lat, 99).toFixed(1)),
          max: Number(percentile(lat, 100).toFixed(1)),
        },
        avgBytes:
          ok.length > 0 ? Math.round(ok.reduce((a, s) => a + s.bytes, 0) / ok.length) : 0,
      },
      null,
      2,
    ) + '\n',
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
