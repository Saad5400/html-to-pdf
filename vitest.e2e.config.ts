import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/e2e/**/*.test.ts', 'test/integration/minimal-mode.test.ts'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
  resolve: {
    alias: { '@': new URL('./src', import.meta.url).pathname },
  },
});
