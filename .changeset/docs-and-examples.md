---
'@mcpolyglot/cli': patch
---

`init` now writes a config with a type-only import, so it loads under `npx` without `@mcpolyglot/config` installed (previously `doctor`/`serve` failed on a freshly generated config). New examples: `readonly-analytics`, `spend-policy`, `multi-agent`, each checked by a test.
