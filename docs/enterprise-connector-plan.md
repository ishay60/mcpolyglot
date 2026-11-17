# Enterprise connector: Priority ERP over MCP, with permissions

Plan for project 5. Scaffold lives in [`packages/connector-priority/`](../packages/connector-priority). Nothing in it talks to Priority yet; every core rule is a `TODO(ishay)` and every guarantee is an `it.todo` in [`guarantees.test.ts`](../packages/connector-priority/src/__tests__/guarantees.test.ts).

**Goal.** An MCP server for a system large organisations run, built on mcpolyglot, that a corporate buyer or FDE lead recognises: read tools first, writes only for allow-listed entities and only after a human approves, per-agent tokens and roles, an audit line per call, the source system's limits respected, sign-in through the org's identity provider where supported, published with a setup guide.

**Done when** someone outside these projects installs and uses it, or it runs inside a client engagement.

---

## 1. What mcpolyglot already gives you

Checked against `develop` at `1cdf1ae` (27 Oct 2026). `pnpm install && pnpm build && pnpm test` on that commit: 8 packages build; 186 tests pass, 22 skipped (the Postgres/MySQL integration tests, which need `PG_TEST_URL` / `MYSQL_TEST_URL`). No in-progress guardrail branch: the 16 Nov push was Dependabot PR #74.

| Capability                            | Where                                                                                                                          | What it does                                                                                                                                                                                                             |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Fixed pipeline per call               | `packages/core/src/server.ts` (`executeTool`)                                                                                  | scope check → rate limit → timeout (races the handler) → handler → redact → size cap → untrusted-wrap → audit. Connectors can't skip a phase.                                                                            |
| Scopes                                | `packages/core/src/tool.ts` (`ALL_SCOPES`, `DEFAULT_SCOPES`), `packages/security/src/scope-guard.ts`                           | `schema:read`, `tables:read`, `tables:write`, `query:raw`, `http:call`. Default is read-only. Missing scope → `forbidden.scope` tool error.                                                                              |
| Per-agent tokens                      | `packages/core/src/transports/streamable-http.ts` (`matchAgent`, `hashToken`), `packages/config/src/schema.ts` (`AgentSchema`) | sha256-hashed tokens, constant-time match, several tokens per agent for rotation, `revoked` flag (needs restart). Agent id reaches handlers as `authInfo.clientId`, so audit `agentId` comes from the token.             |
| Per-agent sources, scopes, policy     | `packages/cli/src/factory.ts` (`buildAgents`, `agentScopes`), `packages/connector-sql/src/policy.ts` (`narrowPolicy`)          | Each agent sees only its sources; scopes capped at the sources' scopes; a per-agent policy can only narrow the source's. **SQL sources only**: `buildAgents` throws for `mongo`/`openapi` with a policy.                 |
| Allow-list for writes (SQL)           | `packages/connector-sql/src/policy.ts`, `connector.ts`                                                                         | Per-table `read`/`write`/`none`, `denyColumns`, `maxWritesPerCall` (rolls back), dry-run, idempotency keys; `execute` exists only when a table is `write`; DB connection read-only otherwise.                            |
| Allow-list for HTTP APIs              | `packages/connector-openapi/src/connector.ts`                                                                                  | Only spec operations; `allowMethods` default GET/HEAD/OPTIONS; host pinned to `baseUrl`; redirects refused; undeclared params refused; response read capped at `maxBytes`. One scope (`http:call`) for reads and writes. |
| Audit                                 | `packages/security/src/audit.ts`, `AuditEntry` in `server.ts`                                                                  | One JSONL line per call (allowed, denied, errored): ts, sessionId, agentId, tool, decision, reason, argsHash, scopes, durationMs, rows, truncated, redactionsApplied, error. Console / file / webhook (best-effort).     |
| Rate limit                            | `packages/security/src/rate-limiter.ts`                                                                                        | Token bucket + concurrency cap keyed by `agent-or-session :: tool`. In-process.                                                                                                                                          |
| Limits per source                     | `server.ts` (`toolLimits`), `config/src/schema.ts` (`LimitsSchema`)                                                            | `rowCap` (≤10 000), `timeoutMs` (≤60 s), `maxBytes` (≤8 MiB) per source.                                                                                                                                                 |
| Redaction + untrusted wrap            | `packages/security/src/redactor.ts`, `wrap.ts`                                                                                 | Emails, JWTs, AWS keys, GitHub tokens, SSNs, card numbers; column deny lists; every result inside `<mcpolyglot-data trusted="false">`.                                                                                   |
| OAuth (inbound)                       | `packages/core/src/transports/oauth.ts`                                                                                        | JWT verified against the issuer's JWKS: signature, `iss`, `aud`, `exp`/`nbf`.                                                                                                                                            |
| Secrets                               | `packages/config/src/secrets.ts`                                                                                               | `${env:}`, `${file:}`, `${keychain:}`; literal credentials flagged by `doctor`.                                                                                                                                          |
| Claim → test map, examples under test | `SECURITY.md`, `packages/cli/src/__tests__/examples.test.ts`                                                                   | Every guardrail claim has a test; example README tables are executed.                                                                                                                                                    |

Small things noticed while reading (not fixed, outside this branch's scope):

- `tools/list` sends `name`, `description`, `inputSchema` only (`server.ts`, `ListToolsRequestSchema` handler). `ToolDefinition.readOnly` is never sent as the MCP `annotations.readOnlyHint`.
- `ToolExecCtx` has no `agentId`, so a handler can't tell which agent is calling. Per-agent behaviour today comes from per-agent connector instances built in `factory.ts`.
- The JSDoc example in `packages/security/src/hooks.ts` uses `rateLimit: { defaultPerMinute }`; the option is `perMinute`.

## 2. Gap per checklist item

| Checklist item                                        | Already there                                                              | Missing for this project                                                                                                                                                                                                                                                                                         |
| ----------------------------------------------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read tools first, writes behind an explicit allowlist | SQL per-table policy; OpenAPI method allow-list; `tables:write` scope      | Per-**entity** allow-list for Priority (`EntityPolicySchema` drafted), denied fields, write tools registered only with a `write` entity, write count checked **before** sending (Priority can't roll back), per-agent narrowing for this source kind.                                                            |
| Human approval for writes, survives restart (added)   | Nothing. Idempotency keys and rate counters are in memory (SECURITY.md)    | Durable approval store, out-of-band approve/reject (not an MCP tool), exactly-once execution after restart, expiry. Interfaces in `approval.ts`.                                                                                                                                                                 |
| Per-agent tokens and role-based permissions           | Per-agent tokens, sources, scopes, narrowed SQL policy                     | **Roles**: today every agent is configured one by one; no "role → scopes + policy" template. Upstream identity: one Priority credential per source means Priority can't tell agents apart (decision D2).                                                                                                         |
| Audit of every call (who, what, when, result)         | Who (token-derived agentId), when, tool, decision, reason, args hash, rows | "What" for an ERP: entity, operation, record key, Priority status, transactions used. Core has no slot for connector detail (decision D5). Approval events. Optional: tamper evidence (hash chain) on the file sink.                                                                                             |
| Rate limiting and pagination respecting the source    | Per agent×tool bucket; per-source row/time/byte caps                       | One budget **per Priority tenant** shared by every agent and tool (decision D4); 429 → `rate_limited` without retry; stop after a 401 (login lock). Pagination: `$top`/`$skip` with a cursor the connector issues, capped at MAXAPILINES.                                                                        |
| Sign-in through the org's IdP                         | OAuth JWT verification (iss/aud/exp)                                       | OAuth mode can't be combined with `agents`, doesn't map claims to agent or scopes, doesn't set `authInfo` (so audit `agentId` is client-asserted there), and serves no Protected Resource Metadata (RFC 9728), which the MCP auth spec makes a MUST. Upstream, the agent's token must not be passed to Priority. |
| Published open source with a setup guide              | npm publishing via changesets, MCP Registry listing, tested examples       | Priority example, setup guide (PAT creation, API Forms, service root), SECURITY.md rows. Package is `"private": true` until the guarantees are real, so the release workflow can't publish a stub.                                                                                                               |

## 3. What Priority's docs say

All from the official Priority developer portal, read on 17 Nov 2026 from the live site and its source repo (`prioritysoftware/prioritysoftware.github.io`, commit `d348636`, 15 Nov 2026). Quotes are verbatim.

**Priority already ships an official MCP server.** This changes the pitch more than anything else on this list. From <https://prioritysoftware.github.io/mcp/> (docs first released August 2026):

- "The MCP server is currently available only on Priority's cloud platform"; "Priority ERP version 26.0 or above"; needs the API module, transaction buckets and an API license per user.
- 12 tools: `companies`, `entity_search`, `form_columns`, `form_tree`, `form_fetch`, `form_update`, `procedure_start`, `procedure_continue`, `enterprise_search`, `help`, `skill_list`, `skill_fetch`. `form_update` creates and updates records.
- Auth: PAT (`Authorization: Basic <encoded_token>`) or "OAuth2 (OIDC)". Endpoint `https://<host>/mcp/erp/<tenant_name>` (<https://prioritysoftware.github.io/mcp/setup/>).
- "All operations respect Priority's permission model -- the AI agent can only access data and perform actions that the authenticated user is authorized for."
- `form_fetch`: "When `top` is omitted, results are limited to **100 records** by default"; "There is no indicator in the response when results are truncated".
- The MCP pages do not mention per-agent allow-lists narrower than the Priority user, write approval, an audit log of agent calls, or rate controls. That is "not documented", not "doesn't exist".

So the honest positioning is not "the first MCP server for Priority". It is: (a) a governance layer that is narrower than the Priority user (entity/field allow-list, writes only after a human approves, per-agent tokens, audit on the customer's side), and (b) on-prem and pre-26.0 installations, which the official server doesn't cover.

**REST API** (<https://prioritysoftware.github.io/restapi/>):

- "The Priority REST API is based on the Open Data Protocol (OData)". `GetODataVersion()` returns `"4.0"` (<https://prioritysoftware.github.io/restapi/request/>).
- Prerequisite: "upper level forms must be made available for API in the **Limited Access/API Forms** form by the Priority administrator. Sublevels are automatically included with their upper-level forms."
- Service root example (public demo): `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini/usdemo`. Format seen in examples: `.../odata/Priority/<tabula.ini>/<company>`; language code can follow the ini name (`tabula.ini,3`).
- "Requests are case sensitive." "Responses are capped at 350MB in size."
- "Starting with version 25.1, the maximum amount of results is governed by the MAXAPILINES system constant (default value 2,000 records) ... we strongly recommend you implement pagination." Before 25.1: MAXFORMLINES.
- Status codes: 200, "201 OK, no content - response to a DELETE request", 400, 404, 409 (POST to an existing record), "429 Too many requests - the user has been throttled by the fair use policy or locked out by the login lock mechanism", 500.
- Optional app license headers `X-App-Id`, `X-App-Key`; "Requests that do not contain these headers will be treated as using generic API licensing."
- Transactions: "Whenever a user updates a form ... via the API, the system counts it as a transaction. Transactions are purchased in packages of 10,000 and renewed monthly." "Creating an order (1 record in ORDERS) with 5 lines (5 records in ORDERITEMS) would be counted as 6 transactions." 25.1+: one shared pool for all API users.

**Rate limits** ("Priority Cloud - Fair Use Policy", same page). "While throttled, requests will be rejected with a standard HTTP error 429." "Each tenant is limited to a maximum of 100 API calls per minute." "Up to 15 requests can be queued at once. The system handles up to 10 requests at the same time, with another 5 in the queue." "requests that take longer than 3 minutes to process will be dropped and generate an error." "5,000 requests per 300 s sliding window (≈1,000 req/min sustained)." Note the two numbers disagree (100/min vs ≈1,000/min sustained); the docs don't explain how they combine. Design for 100/min.

**Login lock** (26.1): "After **3 failed login attempts** within a **10-minute window**, the account is locked." Locked "for **30 minutes**", every attempt rejected with 429, "enforced across all API pods", applies to "Basic Authentication, Personal Access Tokens, and OAuth2". So: never retry a 401.

**Pagination and query** (<https://prioritysoftware.github.io/restapi/query/>): `$filter` (logic operators; v4 string functions `contains`, `startswith`, `endswith`, `tolower`; `substringof` not supported), `$orderby`, `$top`, `$skip` ("Combine `$skip` with `$top` to divide your entities into pages"), `$select`, `$expand` (nested), `$since` (only entities with BPM; `UDATE` filter on some lookup forms instead). No `@odata.nextLink` is documented, so the connector must decide "more pages?" itself.

**Writes** (<https://prioritysoftware.github.io/restapi/modify/>): create (POST), update, delete, `$batch` — "Batch commands are limited to 100 operations in one batch call" and "batch operations do not support rollback". Errors: "any errors generated by the screens are included in the response"; the example there is XML (`InterfaceErrors`), while the intro says JSON since 19.1.

**Authentication** (<https://prioritysoftware.github.io/restapi/authenticate/>):

- Basic: API user name from the Personnel File. "You cannot use Basic Authentication (method 1) while External ID access is enabled."
- PAT (19.1+): "the Authorization header should be set to Basic, the username should be the PAT that was defined, and the password should be hardcoded to `PAT`." Several PATs per user, revocable independently.
- OAuth2: "requires the purchase of the External ID module". "OAuth2 is intended for scenarios where end-users are interacting with your application using a browser or mobile app. To authenticate automated server-to-server communications ... use the Personal Access Token (PAT) method instead." "Only the Authorization code (with PKCE) flow is supported." Discovery: `https://(PRIORITY_DOMAIN)/accounts/.well-known/openid-configuration`. That guide is "relevant only for on-prem (non-SaaS) installations".
- OIDC migration (<https://prioritysoftware.github.io/OIDC_Authentication_Migration>): "Priority is transitioning to OpenID Connect (OIDC)"; "Basic Authentication (username/password) - Deprecated"; register the app (26.0+: External Applications form); "If you are concerned you will not be able to migrate to OIDC in time, you should migrate existing users to personal access token (PAT) authentication in the interim." No deadline is given on that page.

**Sandbox.** The docs publish a demo service root and Postman credentials (user `apidemo`). It's shared and public: use it read-only, and keep the credentials in `${env:}` like any other.

## 4. Decisions for you

**D1. First target: Priority ERP or a CRM?**

| Option                           | For                                                                                                                              | Against                                                                                                                                                               |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Priority REST (OData)            | Your Notion plan names it; Israeli enterprise buyers know it; on-prem gap is real; public docs, limits and a demo sandbox exist. | Vendor's own MCP server exists (cloud, 26.0+), so "governance + on-prem" has to carry the pitch; outside Israel fewer reviewers know it; real tenant access is gated. |
| A CRM (e.g. HubSpot, Salesforce) | Recognised everywhere; bigger audience for "someone outside installs it".                                                        | Not researched in this pass (APIs, limits, vendor MCP servers unverified). Many CRMs also ship official MCP servers; same positioning problem, more competition.      |

**Recommendation: Priority**, positioned as the governed, on-prem-capable connector, with the comparison to the official server written into the README. Reason: it matches the job targets (KO AI's "ERP ... through custom connectors and MCP servers"), the docs are public and specific, and the governance story is something the vendor's docs don't claim. Check before committing: can you get a real (non-demo) tenant, or a client willing to try it? Without one, "done when" depends on the demo sandbox plus outreach.

**D2. How auth works** — two separate hops; never pass the agent's token to Priority (MCP spec: "The MCP server MUST NOT pass through the token it received from the MCP client").

- Inbound (agent → mcpolyglot): (a) existing per-agent tokens — works today; (b) org IdP via OAuth: map a claim (`sub`/`azp`/group) to an agent id, set `authInfo`, serve Protected Resource Metadata, let it coexist with `agents`. (b) is core work in `streamable-http.ts`/`oauth.ts` with its own tests.
- Upstream (mcpolyglot → Priority): (a) one PAT per agent (each agent is its own Priority API user, so Priority's permissions also apply per agent); (b) one shared PAT (simplest, Priority sees one user); (c) user-delegated OAuth to Priority (External ID module, browser Authorization Code + PKCE, the MCP server becomes an OAuth client with its own consent flow).
- **Recommendation:** inbound (a) now and (b) as a later step; upstream (a). (c) only if a client asks for "the agent acts as me". PAT is what Priority itself recommends for server-to-server.

**D3. New package, or extend `connector-openapi`?** Priority publishes OData `$metadata`, not an OpenAPI spec, and needs entity/field policy, tenant budget, transaction counting and approval, none of which fit `call(operationId)`. **Recommendation: new package** `@mcpolyglot/connector-priority` (scaffolded), depending on core only. Sub-decision: add `'priority'` to `ConnectorKind` in core (one line, display only) or keep `'openapi'` (scaffold does this for now).

**D4. Where the per-tenant budget lives.** CONTRIBUTING.md: "Connectors must not perform their own auth, redaction, audit, or rate-limit logic." But the existing limiter is per agent×tool, and the SQL connector already has its own `maxConcurrentQueries`. Options: (a) add a per-source budget to `@mcpolyglot/security` + `SecurityHooks` (generic, helps OpenAPI too, touches the pipeline); (b) connector-internal `UpstreamBudget` (local, but bends the rule). **Recommendation: (a)** as its own PR, because "the pipeline is the only place limits live" is a stronger interview answer than an exception.

**D5. Audit detail.** Add an optional `metadata.audit` on `ToolResult` that the server copies into `AuditEntry.detail` (core PR + tests), or keep only tool + argsHash. **Recommendation: add it**, with a rule that detail carries names and counts, never field values. Sub-decision: record key raw or hashed.

**D6. Approval mechanics.** Store: JSONL file vs SQLite (SQLite gives compare-and-set for free; better-sqlite3 is already a dependency of connector-sql). Who executes after approval: the agent via `approval_status`, or a worker on startup. Approval channel: a CLI command (`mcpolyglot approvals list|approve|reject`) is the smallest; Slack/email later. **Recommendation:** SQLite store, CLI channel, execution on the agent's next `approval_status` call (no background worker, nothing runs unattended), every write requires approval by default.

## 5. Steps

Ordered; no dates. Each step is one PR (or a small group of commits) with its tests.

**1. Make the decisions.** Write D1–D6 answers into this file.
Done when: every decision has a chosen option and one sentence of why.

**2. Client basics against the sandbox.** `HttpPriorityClient`: PAT header, app-license headers, service-root pinning, `priorityVersion`, `loginName`, `listEntitySets`; `init` and `health` call them. Record demo responses as test fixtures (read-only calls only).
Done when: `doctor` on a config pointing at the demo prints the Priority version and login name, and the client tests run offline from fixtures.

**3. Entity policy.** Implement `entityAccess`, `isFieldDenied`, `checkRead`, `checkWrite`, `narrowEntityPolicy`; decide subform inheritance.
Done when: the "policy (allow-list)" todos are real passing tests.

**4. Read tools.** `list_entities`, `describe_entity` (from `$metadata`), `query` (structured filters → escaped `$filter`, `$select`, `$orderby`, capped `$top`, signed/validated cursor over `$skip`), `get_record` (escaped keys, `$expand` of allowed subforms), denied fields stripped.
Done when: an MCP client (Claude Code or the MCP Inspector) lists and reads demo entities through `serve`, and the read/pagination todos pass.

**5. Upstream budget.** Per D4: one budget per source, `maxInFlight`, 429 → `rate_limited`, stop after 401.
Done when: a test with 3 agents × 4 tools never exceeds the configured per-minute and in-flight limits, and a 401 fixture stops further calls.

**6. Audit detail.** Per D5, core PR first, then the connector fills `PriorityAuditDetail`.
Done when: each tool's audit line names entity and op, the audit tests still assert no values/tokens, and SECURITY.md has the row.

**7. Durable approval + write tools.** `ApprovalStore` (per D6), `create_record`/`update_record` return pending, CLI approve/reject, execution checks the stored hash and transitions `approved → executed` with compare-and-set, expiry. Write tools registered only with a `write` entity and an approval store.
Done when: the "write tools" and "human approval" todos pass, including: kill the server with a pending approval, restart, approve, the write runs once; kill it between approve and execute, restart, it still runs once.

**8. Config and CLI wiring.** `kind: 'priority'` source in `config/src/schema.ts`, `buildConnector` + per-agent policy in `factory.ts`, `diagnose()` for doctor, roles (named scope + policy templates agents reference).
Done when: a config with two agents of different roles serves the right tools to each (`agents.test.ts`-style test), and `doctor` flags a policy entity the API doesn't expose.

**9. IdP sign-in (if D2 picked it).** OAuth claims → agent id and `authInfo`, Protected Resource Metadata endpoint, `resource_metadata` in `WWW-Authenticate`, audience check, works alongside `agents`.
Done when: tests cover claim mapping, wrong audience → 401, metadata served at `/.well-known/oauth-protected-resource[/<path>]`, and an MCP client completes sign-in against a test IdP.

**10. Example, guide, release.** `examples/priority/` (read-only demo config + a write-with-approval config), README table run by `examples.test.ts`, setup guide (create a PAT, list API forms, find the service root, choose limits below other integrations on the tenant), README comparison with the official Priority MCP server, SECURITY.md rows, changeset, remove `"private": true`.
Done when: a fresh machine goes from `npx` to a working read in Claude Desktop by following only the guide, and CI is green with zero skipped tests.

**11. Get it used.** Offer it to one Priority shop or client (on-prem or pre-26.0 first), or run it in a client engagement.
Done when: someone outside your projects has installed it and used it, or it runs in an engagement.

**CI note.** The integration job fails if `numPendingTests > 0`. Checked in vitest 2.1.9 (source and a run): `it.todo` counts as `numTodoTests`, not pending, so the scaffold's 31 todos don't break CI. Don't turn them into `it.skip`.

## 6. Security

Mapped to the [OWASP Top 10 for LLM Applications 2025](https://genai.owasp.org/llm-top-10/?cat=253) (verified as the current list on genai.owasp.org on 17 Nov 2026).

- **Prompt injection through tool results (LLM01).** ERP text fields (customer notes, order remarks, item descriptions) are written by people outside the agent's control and can contain instructions. Wrapping every result in `<mcpolyglot-data trusted="false">` helps but doesn't stop a model from being steered. The real limit is what the agent is _allowed_ to do next: injected text can't make a write happen, because writes need a human approval outside MCP and the approver sees the exact payload.
- **Tool abuse / excessive agency (LLM06).** No delete tool, no `$batch`, no raw OData, no approve tool; write tools only for listed entities; `maxWritesPerCall` checked before sending because Priority can't roll back; per-agent narrowing.
- **Permissions enforced in code, not in the prompt.** Tool descriptions and MCP `annotations` are hints (the spec: "Clients should never make tool use decisions based on ToolAnnotations received from untrusted servers"). Every rule here is a check in the handler or pipeline with a test, and an agent that ignores its instructions still gets `forbidden.*`.
- **Sensitive information disclosure (LLM02).** Field deny lists, built-in redaction, PAT never logged, audit carries names and counts, not values; approval store holds raw payloads, so it needs file permissions (D6).
- **Improper output handling (LLM05).** Agent-supplied values go into `$filter` and key paths: escape them, keep requests under the service root, refuse undeclared fields.
- **Unbounded consumption (LLM10).** Per-tenant budget, `$top` caps, response byte cap, timeouts; transactions are paid, so writes are counted.

## 7. Interview questions to be ready for

1. Walk through one `query` call from the agent to Priority and back. Where can it be refused, and what does the agent see each time?
2. Why structured filters instead of letting the model write `$filter`?
3. Priority's limit is per tenant. Why doesn't the existing per-agent rate limiter handle it, and where did you put the budget?
4. What happens on a 401? Why not retry?
5. Why does a write need a human, and how do you guarantee it runs exactly once after a crash?
6. Why can't the agent approve its own write?
7. Your MCP server gets the user's IdP token. Why not forward it to Priority?
8. Priority already has an official MCP server. Why does this exist?
9. What does the audit line contain, what does it deliberately leave out, and why is the args hash not enough for an ERP auditor?
10. A per-agent policy says `ORDERS: write` but the source says `read`. What does the agent get?
11. What does prompt injection look like here, and what still stops damage if wrapping fails?
12. Pagination: Priority gives you `$top`/`$skip` and no next link. How do you know there's another page, and what stops a forged cursor?
13. How would you run this for two companies of the same tenant? Two tenants?

## 8. Sources opened (all on 17 Nov 2026)

- Priority Developer Portal, live: <https://prioritysoftware.github.io/restapi/>, <https://prioritysoftware.github.io/mcp/>
- Same portal, source repo `github.com/prioritysoftware/prioritysoftware.github.io` at `d348636` (15 Nov 2026): `_restapi/1.introduction.md`, `2.Release notes.md`, `3.restAuthenticate.md`, `4.restRequest.md`, `5.restQuery.md`, `6.restModify.md`, `_general/OIDC_Authentication_Migration.md`, `_mcp/1.introduction.md`, `2.setup.md`, `3.tools-reference.md`, `8.release-notes.md` (published as `/restapi/`, `/restapi/authenticate/`, `/restapi/request/`, `/restapi/query/`, `/restapi/modify/`, `/OIDC_Authentication_Migration`, `/mcp/`, `/mcp/setup/`, `/mcp/tools/`)
- MCP spec 2025-11-25: <https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization>, <https://modelcontextprotocol.io/specification/2025-11-25/server/tools>, <https://modelcontextprotocol.io/specification/2025-11-25/schema> (`ToolAnnotations`, `CallToolResult`)
- MCP TypeScript SDK: `github.com/modelcontextprotocol/typescript-sdk` branch `v1.x` at `3b73021` (23 Oct 2026, version 1.32.2): `src/server/auth/middleware/bearerAuth.ts` (`requireBearerAuth`, `resourceMetadataUrl`, `expectedResource`), `src/server/auth/router.ts` (`mcpAuthMetadataRouter`, `getOAuthProtectedResourceMetadataUrl`; the router imports Express). The repo's installed SDK is 1.32.1 (`AuthInfo` with `clientId`, `scopes`, `resource`, `extra`; `ToolAnnotationsSchema`; `LATEST_PROTOCOL_VERSION = '2025-11-25'`). `main` is SDK v2 (split packages `@modelcontextprotocol/server` / `client`); this repo is on v1.
- OWASP: <https://genai.owasp.org/llm-top-10/?cat=253> (2025 list), <https://owasp.org/projects/top-10-for-large-language-model-applications> (no edition newer than 2025 mentioned)

## 9. Not verified

- Any live call to Priority: the demo sandbox wasn't contacted (docs were read through the source repo and a web fetch tool; direct HTTP from this environment to prioritysoftware.github.io was refused by its proxy, and the sandbox host wasn't tried). Whether the demo is up, what its version is, and whether it sends `Retry-After` on 429 are unknown.
- How "100 calls per minute" and "5,000 per 300 s" combine.
- Whether the official Priority MCP server has governance features beyond what its docs say.
- CRM APIs, limits and vendor MCP servers (D1's CRM row is not researched).
- <https://genai.owasp.org/llm-top-10/> (the main page) didn't load; the list was read from its 2025 category page. Any OWASP agentic-specific list was not checked.
- SDK v2 auth APIs (only v1.x was checked, which is what this repo uses).
