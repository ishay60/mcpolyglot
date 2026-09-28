# @mcpolyglot/cli

## 0.2.0

### Minor Changes

- b98aaf6: Refresh CLI UI in a Copilot-CLI flavor and bump zod to v4.

  - New UI primitives in `@mcpolyglot/cli`: a boxed `headerBar` with a sub-command pill, pill-chip status indicators (`[ OK ]`, `[ ERR ]`, `[ READY ]`), section dividers, a `panel` for "next steps" callouts, a `footerBar` for hints, and a `step(n/total)` indicator for the `init` wizard.
  - `doctor`, `serve`, `tools`, and `init` adopt the new layout. The light `banner` is retained for compatibility.
  - `@mcpolyglot/core` now uses zod v4's built-in `z.toJSONSchema()` instead of the `zod-to-json-schema` package, dropping one dep.
  - `@mcpolyglot/config`, `@mcpolyglot/connector-sql`, and `@mcpolyglot/connector-mongo` upgraded to zod 4. `ZodTypeAny` was replaced with a permissive `AnyZodSchema` alias in core so existing connector handlers keep working without explicit generic annotations.
  - `@mcpolyglot/cli` upgraded `@clack/prompts` to v1 (validate signatures now allow `undefined`).

- 6f8b1d2: Wire OAuth (JWT + JWKS) verification into the Streamable HTTP transport.

  When `auth.type: 'oauth'` is set in the config, the transport now verifies bearer JWTs against the configured issuer/audience and a remote JWKS (cached + rotated by `jose`). The default JWKS path is `${issuer}/.well-known/jwks.json`, matching the convention used by Auth0, Okta, Keycloak, Cognito, and most OIDC providers.

  - New module: `@mcpolyglot/core` exposes `createOAuthVerifier({ issuer, audience, jwksUri? })` from `@mcpolyglot/core/transports/streamable-http`.
  - `StreamableHttpTransport` now accepts a discriminated `auth: { kind: 'bearer' | 'oauth', ... }` option. The legacy `bearerToken` field is preserved for back-compat.
  - 401 responses include an RFC 6750 `WWW-Authenticate` challenge with `error="invalid_token"` and an `error_description` mapped from a small, stable set of reasons (`token_expired`, `signature_invalid`, `claim_validation_failed`, `unknown_key`, `invalid_token`).
  - `mcpolyglot serve` now renders `Auth: oauth · <issuer>` and `Audience: <aud>` instead of the bearer token line when running in OAuth mode.
  - `examples/http/README.md` documents the OAuth setup with a curl + client-credentials walkthrough.

  Adds `jose` (^5.9.6) as a direct dependency of `@mcpolyglot/core`.

### Patch Changes

- Updated dependencies [b98aaf6]
- Updated dependencies [6f8b1d2]
- Updated dependencies [e7251dd]
  - @mcpolyglot/core@0.2.0
  - @mcpolyglot/config@0.1.0
  - @mcpolyglot/connector-sql@0.2.0
  - @mcpolyglot/connector-mongo@0.2.0
  - @mcpolyglot/security@0.0.3

## 0.1.0

### Minor Changes

- aec2cdb: Wave 2: multi-DB + remote.
  - **@mcpolyglot/connector-sql**: add **MySQL/MariaDB dialect** with read-only enforcement. The session is opened with `SET TRANSACTION READ ONLY`, every `SELECT` gets a `MAX_EXECUTION_TIME` hint, and a `node-sql-parser` AST gate rejects any non-read top-level statement before it reaches the server.
  - **@mcpolyglot/connector-mongo**: new package. Sample-based schema inference, `list_collections` / `describe_collection` / `find` / `aggregate` primitives, `$out` and `$merge` aggregation stages rejected.
  - **@mcpolyglot/core**: new `StreamableHttpTransport` (`@mcpolyglot/core/transports/streamable-http`) wrapping the SDK's `StreamableHTTPServerTransport`. Bearer-token auth via constant-time comparison, `WWW-Authenticate` challenge on 401, `/healthz` endpoint, loud warning when bound to a non-loopback host.
  - **@mcpolyglot/cli**: `mcpolyglot serve --http` boots the HTTP transport, prints the URL/token banner, and respects `cfg.transport` when no flag is passed. Auto-generates a bearer token if none is configured.
  - **@mcpolyglot/config**: MySQL/MariaDB and Mongo source kinds are now wired through to real connectors instead of throwing.

### Patch Changes

- Updated dependencies [aec2cdb]
  - @mcpolyglot/connector-sql@0.1.0
  - @mcpolyglot/connector-mongo@0.1.0
  - @mcpolyglot/core@0.1.0
  - @mcpolyglot/config@0.0.2
  - @mcpolyglot/security@0.0.2
