# @mcpolyglot/security

The non-bypassable security middleware for [mcpolyglot](https://github.com/ishay60/mcpolyglot). Implements every phase of the pipeline that wraps tool calls in `@mcpolyglot/core`.

## What's in here

- **`ScopeGuard`** — refuses tools whose required scopes aren't in the granted set.
- **`RateLimiter`** — token bucket per session per tool, plus a max-concurrent gate.
- **`Redactor`** — built-in regex set (emails, JWTs, AWS access keys, GitHub tokens, SSNs, credit-card numbers) plus per-table column deny lists.
- **`AuditLogger`**: append-only JSONL audit sink. See [Audit log](#audit-log).

## Audit log

Every tool call writes one entry, including calls that were denied or failed:

```json
{
  "ts": "…",
  "sessionId": "…",
  "agentId": "claude-code",
  "tool": "pg.main.query",
  "decision": "deny",
  "reason": "Table \"secrets\" is not accessible under this policy.",
  "argsHash": "3f9c…",
  "scopes": ["…"],
  "durationMs": 4,
  "rows": 0,
  "error": { "code": "forbidden.policy", "message": "…" }
}
```

- `agentId` is the `x-mcpolyglot-agent` request header (HTTP), else the MCP client's `clientInfo.name`.
- `decision`: `allow`, `deny` (policy, scope, rate limit or timeout), or `error` (anything else).
- Sinks:
  - console, on by default: stdout, or stderr under stdio (where stdout is the protocol).
  - `audit.path`: an append-only file.
  - `audit.webhookUrl`: a best-effort POST. Failures go to stderr, never fail the call, and never echo the URL.
- Never logged: raw args (only a 16-char sha256 prefix) and result rows. `reason` and error text are scrubbed of `scheme://user:pass@` credentials and the built-in redaction patterns (email, JWT, keys, …), then truncated to 500 chars.
- Limits:
  - "Append-only" means the process only opens the file with `O_APPEND`. Tamper-evidence (hash chains, WORM storage) is out of scope; ship to a webhook or your log pipeline for that.
  - Webhook posts still in flight when the process is killed are lost.

```ts
audit: { console: true, path: '~/.mcpolyglot/audit.log', webhookUrl: '${env:AUDIT_WEBHOOK}' }
```

Tests: `src/__tests__/audit.test.ts` (sinks, scrubbing) and `packages/core/src/__tests__/audit.test.ts` (decision, agent id, no raw args or rows).

- **`wrapUntrusted` / `enforceSize`** — `<mcpolyglot-data>` prompt-injection wrapper and a hard byte cap on serialized output.
- **`defaultSecurityHooks(opts)`** — composes all of the above into the `SecurityHooks` shape `McpolyglotServer` expects.
- **`composeHooks(...hooks)`** — chain custom hooks alongside the defaults.

## Why a separate package

Connectors, the CLI, and any embedding host all need to construct the security hooks the same way. Keeping them in one package makes that boring and reviewable.

## Docs

- Architecture → https://github.com/ishay60/mcpolyglot/blob/develop/ARCHITECTURE.md
- Pipeline overview → see "The security pipeline" section in ARCHITECTURE.md

MIT licensed.
