/**
 * What an ERP auditor asks after "who called which tool, when, allowed or not": which entity,
 * which operation, which record, and what Priority answered.
 *
 * The core audit line (`AuditEntry` in `packages/core/src/server.ts`) already records: ts,
 * sessionId, agentId, tool, decision, reason, argsHash, scopes, durationMs, rows, truncated,
 * redactionsApplied, error. It has no place for connector-supplied detail, and a connector
 * cannot write audit lines itself (CONTRIBUTING.md: "Connectors must not perform their own
 * auth, redaction, audit, or rate-limit logic").
 *
 * TODO(ishay): decision D5 in docs/enterprise-connector-plan.md. Likely shape: an optional
 * `metadata.audit` on `ToolResult` that the server copies into `AuditEntry.detail`, in a
 * separate core PR with its own tests. Until then, this type is only the contract.
 */
export interface PriorityAuditDetail {
  /** Entity the call touched, e.g. `ORDERS`. */
  entity: string;
  op: 'list_entities' | 'describe' | 'query' | 'get' | 'create' | 'update';
  /**
   * Record key of a get/create/update. TODO(ishay): decide raw vs. hashed. A key like a
   * customer number can be personal data; a hash keeps "same record?" answerable without it.
   */
  recordKey?: string;
  /** HTTP status Priority returned. */
  upstreamStatus?: number;
  /** Records returned (reads) or written (writes, including subform lines). */
  records?: number;
  /** For writes: license transactions this call consumed (one per record written). */
  transactions?: number;
}
