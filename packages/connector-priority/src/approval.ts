/**
 * Human approval for write tools, surviving a server restart.
 *
 * Flow (to build, see "Approval" step in docs/enterprise-connector-plan.md):
 * 1. An agent calls `<id>.create_record` / `<id>.update_record`. The policy check passes.
 * 2. Nothing is sent to Priority. The connector stores a `PendingApproval` and returns a tool
 *    result telling the agent the write is waiting, with the approval id.
 * 3. A human approves or rejects out of band — never through a tool the agent can call, or the
 *    agent can approve its own write. (E.g. a CLI command reading the same store.)
 * 4. After approval, the write is executed exactly once, by whoever resumes it (the agent calling
 *    `<id>.approval_status`, or a worker on startup — decision D6).
 *
 * "Survives a restart" means the store is durable (a file or SQLite next to the audit log, not
 * process memory like today's idempotency keys and rate-limit counters, see SECURITY.md) and
 * that execution after a crash cannot run the same write twice.
 */
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'executed' | 'failed' | 'expired';

export interface PendingApproval {
  /** Random, unguessable. Shown to the agent and the human. */
  id: string;
  /** Agent that requested the write (from the authenticated token, not a header). */
  agentId?: string;
  sourceId: string;
  tool: string;
  entity: string;
  op: 'create' | 'update';
  /**
   * The exact request that will be sent if approved. Stored so the human approves *this*
   * payload and execution cannot be swapped for a different one. TODO(ishay): this is raw
   * ERP data at rest. Decide file permissions / encryption, and keep it out of the audit log.
   */
  request: { key?: Record<string, string | number>; body: Record<string, unknown> };
  /** sha256 of `request`, checked again just before execution. */
  requestHash: string;
  state: ApprovalState;
  createdAt: string;
  /** Pending approvals expire; a stale approval should not execute weeks later. */
  expiresAt: string;
  decidedBy?: string;
  decidedAt?: string;
  /** Set once Priority answered, so a resumed run never sends the write a second time. */
  result?: { upstreamStatus: number; message?: string };
}

/**
 * Durable store for pending writes. TODO(ishay): implement (file-backed JSONL or SQLite), and
 * make every state change a compare-and-set so two processes cannot both execute one approval.
 */
export interface ApprovalStore {
  create(p: Omit<PendingApproval, 'state'>): Promise<PendingApproval>;
  get(id: string): Promise<PendingApproval | undefined>;
  list(filter?: { state?: ApprovalState; sourceId?: string }): Promise<PendingApproval[]>;
  /**
   * Move `id` from `from` to `to` only if it is still in `from`; returns false otherwise.
   * This is the one primitive that prevents double execution after a restart.
   */
  transition(
    id: string,
    from: ApprovalState,
    to: ApprovalState,
    patch?: Partial<PendingApproval>,
  ): Promise<boolean>;
}

/** Which writes need a human. TODO(ishay): decide default (recommend: every write). */
export interface ApprovalPolicy {
  /** Entities whose writes need approval. `'*'` = all write entities. */
  require: string[] | '*';
  /** How long a pending approval stays valid. */
  ttlMinutes: number;
}
