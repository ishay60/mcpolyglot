# Contributing to mcpolyglot

Thanks for considering a contribution.

## Quickstart

```bash
corepack enable
pnpm install
pnpm build
pnpm test
```

## Project layout

This is a pnpm + Turborepo monorepo. Each package under `packages/` is published independently. See the [README](./README.md#repository-layout) for the package map.

## Conventions

- TypeScript strict mode, ESM only.
- Public types live in each package's `src/index.ts`.
- The security pipeline in `@mcpolyglot/core/server.ts` is non-bypassable. Connectors must not perform their own auth, redaction, audit, or rate-limit logic.
- Tests use [vitest](https://vitest.dev). Postgres and MySQL integration tests run when `PG_TEST_URL` / `MYSQL_TEST_URL` are set; CI sets both with service containers and fails if any test is skipped. Locally:

  ```bash
  docker run -d --rm --name pg -e POSTGRES_PASSWORD=test -p 55432:5432 postgres:16-alpine
  docker run -d --rm --name my -e MYSQL_ROOT_PASSWORD=test -e MYSQL_DATABASE=test -p 53306:3306 mysql:8.4
  PG_TEST_URL=postgres://postgres:test@localhost:55432/postgres \
  MYSQL_TEST_URL=mysql://root:test@localhost:53306/test pnpm test:coverage
  ```

- **Every guardrail claim needs a test.** If you add or change something the README or SECURITY.md promises, add the test and a row to the [claim → test table](./SECURITY.md#where-each-claim-is-tested). Example READMEs are checked by `packages/cli/src/__tests__/examples.test.ts`; keep their tables and that test in sync.
- Run `pnpm lint`, `pnpm typecheck` and `pnpm format:check` before pushing.
- Conventional commits.

## Adding a connector

1. Create `packages/connector-<kind>/` mirroring `packages/connector-sql/`.
2. Implement `Connector` from `@mcpolyglot/core`.
3. Expose `listPrimitiveTools()` only — leave per-entity generation for a follow-up.
4. Use the supplied `ToolExecCtx.signal` for cancellation. The server also cuts a call off at the timeout if the handler ignores it, but the work keeps running, so stop it.
5. Never read secrets directly — accept them as already-resolved strings; the `@mcpolyglot/cli` factory resolves `${env:...}` etc.

## Filing security issues

See [SECURITY.md](./SECURITY.md). **Do not** open public issues for vulnerabilities.

## Releasing

We use [changesets](https://github.com/changesets/changesets). Every PR with a behavior change must include a changeset (`pnpm changeset`).
