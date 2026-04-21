import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/unit/**/*.test.ts', 'test/integration/**/*.test.ts'],
    exclude: ['test/e2e/**', 'test/integration/minimal-mode.test.ts', 'node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      // Excluded from unit coverage (covered separately):
      //   server.ts / worker/index.ts — process entry points
      //   pdf/renderer.ts            — fully exercised by test/e2e (real Chromium)
      //   storage/s3.ts              — exercised against MinIO in CI; no local stub
      //   types/index.ts             — type-only, zero runtime
      exclude: [
        'src/**/*.d.ts',
        'src/server.ts',
        'src/worker/index.ts',
        'src/services/pdf/renderer.ts',
        'src/services/storage/s3.ts',
        'src/types/index.ts',
      ],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 80,
        statements: 85,
      },
    },
    testTimeout: 20_000,
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
