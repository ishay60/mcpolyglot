# @mcpolyglot/connector-priority (scaffold)

Priority ERP connector for [mcpolyglot](https://github.com/ishay60/mcpolyglot), over the Priority REST (OData) API. **Not functional yet**: types, tool contracts and the list of guarantees only. The package is `private` so it can't be published by accident.

Plan, decisions and the facts from Priority's docs: [docs/enterprise-connector-plan.md](../../docs/enterprise-connector-plan.md).

## Tools (contracts)

Registered now (handlers return `not_implemented`):

- `<id>.list_entities`, `<id>.describe_entity` — `schema:read`
- `<id>.query` (structured filters, `select`, `orderBy`, `top`, `cursor`, `expand`), `<id>.get_record` — `tables:read`

Defined but not registered until the allow-list and approval store exist (fail closed):

- `<id>.create_record`, `<id>.update_record`, `<id>.approval_status` — `tables:write`, human approval required

No delete, no `$batch`, no raw OData, and no tool that approves a write.

## Files

- `src/connector.ts` — `PriorityConnector` and tool definitions
- `src/policy.ts` — `EntityPolicySchema` (entity allow-list, denied fields, caps) and the checks to implement
- `src/client.ts` — `PriorityClient` HTTP surface and `PriorityAuth` (PAT)
- `src/limits.ts` — Priority's documented limits and the `UpstreamBudget` contract
- `src/approval.ts` — durable human approval for writes
- `src/audit.ts` — audit detail the connector wants to record
- `src/__tests__/guarantees.test.ts` — what passes today, and `it.todo` for every guarantee

MIT licensed.
