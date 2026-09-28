---
'@mcpolyglot/core': minor
'@mcpolyglot/config': minor
'@mcpolyglot/cli': minor
---

Per-agent HTTP auth: `agents: [{ id, tokens: [{ hash, revoked? }], scopes?, sources: { [id]: { policy? } } }]`. Tokens are stored as sha256 hashes and matched in constant time; the authenticated agent sees only its sources' tools that its scopes cover, gets its own policy per source, its own rate-limit bucket, and is the audit `agentId`. New `mcpolyglot token create|hash`; `doctor` lists each agent's tools. Without `agents` nothing changes.

**Fix:** the HTTP transport now serves more than one request per process (SDK 1.30 forbids reusing a stateless transport; every request after the first returned 500). **Breaking for custom transports:** `Transport.start` now receives a `() => Server` factory instead of a `Server`. Under HTTP, `clientInfo.name` no longer labels audit entries (each request has its own protocol server); use the header or `agents`.
