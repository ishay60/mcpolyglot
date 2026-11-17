import { McpolyglotError } from '@mcpolyglot/core';
import type { UpstreamBudget } from './limits.js';

/**
 * How the connector authenticates to Priority. This is the *upstream* credential, separate from
 * whatever the agent used to reach mcpolyglot: the MCP authorization spec says an MCP server
 * "MUST NOT pass through the token it received from the MCP client"
 * (https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization).
 */
export type PriorityAuth =
  /**
   * Personal Access Token. Priority docs: "the Authorization header should be set to Basic, the
   * username should be the PAT that was defined, and the password should be hardcoded to `PAT`."
   * Arrives already resolved from `${env:...}` / `${file:...}`; never read from env here.
   */
  { type: 'pat'; token: string };
// TODO(ishay): decision D2. Basic username/password is left out on purpose: Priority's OIDC
// migration guide lists it as "Deprecated". OAuth2/OIDC to Priority (Authorization Code + PKCE
// only, needs the External ID module) would be a second variant here if you build delegation.

/** Optional per-application license headers (Priority 18.3+). Without them: generic API licensing. */
export interface PriorityAppLicense {
  appId: string;
  appKey: string;
}

export interface PriorityClientOptions {
  /**
   * OData service root, `https://<host>/odata/Priority/<tabula.ini>/<company>`. Example from the
   * docs (public demo): `https://t.eu.priority-connect.online/odata/Priority/tabbtd38.ini/usdemo`.
   * Every request must stay under it (same host pinning as `@mcpolyglot/connector-openapi`).
   */
  serviceRoot: string;
  auth: PriorityAuth;
  appLicense?: PriorityAppLicense;
  budget: UpstreamBudget;
  /** For tests. */
  fetch?: typeof fetch;
}

/** One page of a collection read. */
export interface PriorityPage {
  records: Record<string, unknown>[];
  /**
   * Opaque cursor for the next page, or undefined when there is none. Priority documents
   * `$top` + `$skip` for paging and no next link, so "is there more?" has to be worked out by
   * the connector (e.g. ask for one more record than returned). See TODO in `query`.
   */
  nextCursor?: string;
}

/** A structured filter. Built into `$filter` by the client; the model never sends raw OData. */
export interface PriorityFilter {
  field: string;
  op: 'eq' | 'ne' | 'gt' | 'ge' | 'lt' | 'le' | 'startswith' | 'contains';
  value: string | number | boolean;
}

export interface PriorityQuery {
  entity: string;
  select?: string[];
  filter?: PriorityFilter[];
  orderBy?: Array<{ field: string; desc?: boolean }>;
  /** Already capped by the connector to min(policy cap, source rowCap). */
  top: number;
  skip: number;
  expand?: string[];
}

/** The HTTP surface the connector needs. Kept narrow so tests can fake it without a server. */
export interface PriorityClient {
  /** `GET serviceRoot/GetPriorityVersion()`, e.g. `"22.0-20.0.0.119"`. Used by health/doctor. */
  priorityVersion(signal: AbortSignal): Promise<string>;
  /** `GET serviceRoot/GetLoginName`: which Priority user the credential maps to. For doctor. */
  loginName(signal: AbortSignal): Promise<string>;
  /** `GET serviceRoot/`: entity sets the API exposes to this user. */
  listEntitySets(signal: AbortSignal): Promise<string[]>;
  /** Metadata for one entity (fields, keys, navigation properties). */
  describeEntity(entity: string, signal: AbortSignal): Promise<EntityDescription>;
  query(q: PriorityQuery, signal: AbortSignal): Promise<PriorityPage>;
  get(
    entity: string,
    key: Record<string, string | number>,
    expand: string[],
    signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined>;
  create(entity: string, body: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  update(
    entity: string,
    key: Record<string, string | number>,
    body: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
}

export interface EntityDescription {
  entity: string;
  keys: string[];
  fields: Array<{ name: string; type: string; nullable: boolean }>;
  /** Navigation properties, i.e. subforms such as `ORDERITEMS_SUBFORM`. */
  subforms: string[];
}

function notImplemented(what: string): never {
  throw new McpolyglotError('not_implemented', `${what} is not implemented yet (scaffold)`);
}

/**
 * `fetch`-based client. TODO(ishay): implement every method. Notes from the Priority docs to
 * carry into the code and tests:
 * - Requests are case-sensitive; forms and fields are usually UPPERCASE.
 * - Keys go in the path: `ORDERS('SO17000003')`. Escape quotes in string keys; composite keys
 *   exist ("Composite Keys" section of /restapi/modify/). Never let a key leave the service root.
 * - In `$filter`, spaces become `%20`, so `ge 2018-...` breaks if not encoded (docs call this
 *   out for dates). Semicolons inside `$expand(...)` must be URL-encoded.
 * - Errors are JSON from 19.1; the modify page's example is still XML (`InterfaceErrors`).
 *   Parse both, and pass Priority's message to the agent as a tool error.
 * - `redirect: 'error'` and `signal` on every request, like connector-openapi.
 * - Read at most `limits.maxBytes`; Priority's own cap is 350 MB, far above ours.
 * - Every request goes through `budget.acquire` / `budget.onResponse`.
 */
export class HttpPriorityClient implements PriorityClient {
  constructor(private readonly opts: PriorityClientOptions) {}

  /** The service root this client is pinned to. */
  get serviceRoot(): string {
    return this.opts.serviceRoot;
  }

  async priorityVersion(_signal: AbortSignal): Promise<string> {
    return notImplemented('priorityVersion');
  }
  async loginName(_signal: AbortSignal): Promise<string> {
    return notImplemented('loginName');
  }
  async listEntitySets(_signal: AbortSignal): Promise<string[]> {
    return notImplemented('listEntitySets');
  }
  async describeEntity(_entity: string, _signal: AbortSignal): Promise<EntityDescription> {
    return notImplemented('describeEntity');
  }
  async query(_q: PriorityQuery, _signal: AbortSignal): Promise<PriorityPage> {
    return notImplemented('query');
  }
  async get(
    _entity: string,
    _key: Record<string, string | number>,
    _expand: string[],
    _signal: AbortSignal,
  ): Promise<Record<string, unknown> | undefined> {
    return notImplemented('get');
  }
  async create(
    _entity: string,
    _body: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<unknown> {
    return notImplemented('create');
  }
  async update(
    _entity: string,
    _key: Record<string, string | number>,
    _body: Record<string, unknown>,
    _signal: AbortSignal,
  ): Promise<unknown> {
    return notImplemented('update');
  }
}
