import { defineConfig } from 'vitest/config';

// Root config for `pnpm test:coverage`: one run across every package, one report.
export default defineConfig({
  test: {
    // Relative globs so per-package `vitest run` (cwd = package) also matches.
    include: ['**/src/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '.claude/**'],
    coverage: {
      provider: 'v8',
      include: ['**/src/**/*.ts'],
      exclude: ['**/__tests__/**', 'packages/testkit/**', 'packages/cli/src/bin.ts'],
      reporter: ['text-summary', 'json-summary'],
    },
  },
});
