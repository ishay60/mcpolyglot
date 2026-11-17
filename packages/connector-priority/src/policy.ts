import { z } from 'zod';
import { McpolyglotError } from '@mcpolyglot/core';

/**
 * Access to one Priority entity (an API-exposed form such as `CUSTOMERS`, or a subform such as
 * `ORDERITEMS_SUBFORM`). Same three values as the SQL connector's per-table access.
 */
export const EntityAccessSchema = z.enum(['read', 'write', 'none']);
export type EntityAccess = z.infer<typeof EntityAccessSchema>;

/** Priority form and field names: "usually in UPPERCASE ... and must be matched exactly". */
const EntityName = z.string().regex(/^[A-Za-z0-9_]+$/, 'expected a Priority form name');

/**
 * The allow-list. Modelled on `PolicySchema` in `@mcpolyglot/connector-sql` (policy.ts) so the
 * two read the same way in config, with two deliberate differences:
 *
 * - `defaultAccess` defaults to `'none'`, not `'read'`: an ERP has hundreds of forms, and an
 *   entity added to the API later should stay hidden until someone lists it.
 * - Names are case-sensitive. Priority says "Requests are case sensitive", so `customers` is
 *   not `CUSTOMERS`; matching them loosely would make the policy say something it doesn't do.
 *
 * Priority has its own gate in front of this one: an upper-level form is reachable only if the
 * Priority admin lists it in "Limited Access/API Forms", and sublevels come with it. This
 * policy can only narrow that, never widen it.
 */
export const EntityPolicySchema = z
  .object({
    /** Per-entity access. Subforms are listed under their own name, e.g. `ORDERITEMS_SUBFORM`. */
    entities: z.record(EntityName, EntityAccessSchema).default({}),
    /** Access for entities not listed. Never `write`: writes are opt-in per entity. */
    defaultAccess: z.enum(['read', 'none']).default('none'),
    /** Fields no call may read, filter, sort, select or write, as `ENTITY.FIELD` or `*.FIELD`. */
    denyFields: z.array(z.string()).default([]),
    /** Cap on records per read call. Priority's own cap is MAXAPILINES (default 2,000). */
    maxRecordsPerCall: z.number().int().positive().max(2_000).optional(),
    /**
     * Records one write call may create or change, counting subform lines. Priority counts each
     * as one license transaction (an order with 5 lines = 6) and cannot roll back, so this has
     * to be checked before the request is sent, not after.
     */
    maxWritesPerCall: z.number().int().positive().default(1),
  })
  .strict();
export type EntityPolicy = z.infer<typeof EntityPolicySchema>;

/** Why a call was refused. Always has a reason the agent can read. */
export interface EntityDecision {
  allow: boolean;
  reason: string;
}

function notImplemented(what: string): never {
  throw new McpolyglotError('not_implemented', `${what} is not implemented yet (scaffold)`);
}

/**
 * Effective access for one entity.
 *
 * TODO(ishay): implement. Rules to decide and test:
 * - listed entity -> its value; unlisted -> `defaultAccess`.
 * - a subform with no entry: inherit the parent's access, or `defaultAccess`? (Priority itself
 *   includes sublevels with their parent.) Write the rule down in the README either way.
 */
export function entityAccess(_policy: EntityPolicy, _entity: string): EntityAccess {
  return notImplemented('entityAccess');
}

/**
 * Whether `ENTITY.FIELD` is denied (exact entity, or `*.FIELD`).
 *
 * TODO(ishay): implement. A denied field must be refused in `select`, `filter`, `orderBy` and
 * write payloads, and stripped from results, including inside `$expand`ed subforms.
 */
export function isFieldDenied(_policy: EntityPolicy, _entity: string, _field: string): boolean {
  return notImplemented('isFieldDenied');
}

/**
 * Decide a read before any request is built.
 *
 * TODO(ishay): implement. Deny when the entity is `none`, when any requested, filtered or sorted
 * field is denied, and when an expanded subform is `none`.
 */
export function checkRead(
  _policy: EntityPolicy,
  _req: { entity: string; fields: string[]; expand: string[] },
): EntityDecision {
  return notImplemented('checkRead');
}

/**
 * Decide a write before any request is built.
 *
 * TODO(ishay): implement. Deny unless the entity (and every subform written) is `write`, no
 * denied field is set, and the record count (parent + subform lines) <= `maxWritesPerCall`.
 */
export function checkWrite(
  _policy: EntityPolicy,
  _req: { entity: string; fields: string[]; subforms: Record<string, number> },
): EntityDecision {
  return notImplemented('checkWrite');
}

/**
 * Per-agent policy, narrowed by the source policy: the result can never grant more than either.
 *
 * TODO(ishay): implement, mirroring `narrowPolicy` in `@mcpolyglot/connector-sql` (policy.ts):
 * most-restrictive access per entity, union of `denyFields`, smaller of each cap. Then lift the
 * "policy is only supported on SQL sources" refusal in `packages/cli/src/factory.ts`
 * (`buildAgents`) for this source kind.
 */
export function narrowEntityPolicy(_base: EntityPolicy, _override: EntityPolicy): EntityPolicy {
  return notImplemented('narrowEntityPolicy');
}
