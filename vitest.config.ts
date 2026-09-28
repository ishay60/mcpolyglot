import { defineConfig } from 'vitest/config';

// Root config for `pnpm test:coverage`: one run across every package, one report.
export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**/*.ts'],
      exclude: ['**/__tests__/**', 'packages/testkit/**', 'packages/cli/src/bin.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
