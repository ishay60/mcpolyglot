import { z } from 'zod';
import type {
  CollectionSchema,
  Connector,
  ConnectorInitCtx,
  ToolDefinition,
} from '@mcpolyglot/core';
import { McpolyglotError } from '@mcpolyglot/core';

type MongoClient = import('mongodb').MongoClient;
type Db = import('mongodb').Db;

export interface MongoConnectorOptions {
  id: string;
  url: string;
  database?: string;
}

const MONGO_OP_BUDGET_MS = 60_000;

export class MongoConnector implements Connector {
  readonly id: string;
  readonly kind = 'mongo' as const;
  private readonly url: string;
  private readonly explicitDb?: string;
  private client?: MongoClient;
  private db?: Db;
  private logger?: ConnectorInitCtx['logger'];
  private cachedCollections?: CollectionSchema[];

  constructor(opts: MongoConnectorOptions) {
    this.id = opts.id;
    this.url = opts.url;
    this.explicitDb = opts.database;
  }

  async init(ctx: ConnectorInitCtx): Promise<void> {
    this.logger = ctx.logger;
    const mongo = await loadMongo();
    this.client = new mongo.MongoClient(this.url, {
      serverSelectionTimeoutMS: 5_000,
      connectTimeoutMS: 5_000,
      maxPoolSize: 4,
      appName: 'mcpolyglot',
    });
    await this.client.connect();
    const dbName = this.explicitDb ?? extractDbFromUri(this.url) ?? 'admin';
    this.db = this.client.db(dbName);
    await this.db.command({ ping: 1 });
    this.logger.info('connector.mongo.connected', { id: this.id, db: dbName });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = undefined;
    this.db = undefined;
  }

  async health(): Promise<{ ok: boolean; latencyMs: number; details?: string }> {
    const t0 = Date.now();
    try {
      await this.requireDb().command({ ping: 1 });
      return { ok: true, latencyMs: Date.now() - t0 };
    } catch (err) {
      return { ok: false, latencyMs: Date.now() - t0, details: (err as Error).message };
    }
  }

  listPrimitiveTools(): ToolDefinition[] {
    const id = this.id;
    return [
      {
        name: `${id}.list_collections`,
        description: `List all collections in the ${id} MongoDB database with a sampled-field schema for each.`,
        inputSchema: z.object({}).strict(),
        scopes: ['schema:read'],
        readOnly: true,
        handler: async () => {
          const cols = await this.cachedOrFetchCollections();
          return {
            content: [{ type: 'json', data: cols }],
            metadata: { rows: cols.length },
          };
        },
      },
      {
        name: `${id}.describe_collection`,
        description: `Describe a collection's sampled-field schema.`,
        inputSchema: z
          .object({
            name: z.string().min(1).describe('Collection name'),
          })
          .strict(),
        scopes: ['schema:read'],
        readOnly: true,
        handler: async ({ name }) => {
          const cols = await this.cachedOrFetchCollections();
          const found = cols.find((c) => c.name.toLowerCase() === name.toLowerCase());
          if (!found)
            throw new McpolyglotError('not_found', `Collection "${name}" not found in ${id}`);
          return { content: [{ type: 'json', data: found }] };
        },
      },
      {
        name: `${id}.find`,
        description: `Run a read-only \`find\` query on a collection. Filter / projection / sort are passed straight to MongoDB.`,
        inputSchema: z
          .object({
            collection: z.string().min(1),
            filter: z.record(z.string(), z.unknown()).default({}),
            projection: z.record(z.string(), z.union([z.literal(0), z.literal(1)])).optional(),
            sort: z.record(z.string(), z.union([z.literal(1), z.literal(-1)])).optional(),
            limit: z.number().int().positive().max(1000).optional(),
          })
          .strict(),
        scopes: ['tables:read'],
        readOnly: true,
        handler: async ({ collection, filter, projection, sort, limit }, ctx) => {
          const rowCap = Math.min(limit ?? ctx.limits.rowCap, ctx.limits.rowCap);
          const cursor = this.requireDb()
            .collection(collection)
            .find(filter, { projection, sort, limit: rowCap + 1 })
            .maxTimeMS(Math.min(ctx.limits.timeoutMs, MONGO_OP_BUDGET_MS));
          const docs = await cursor.toArray();
          const truncated = docs.length > rowCap;
          const sliced = truncated ? docs.slice(0, rowCap) : docs;
          return {
            content: [
              { type: 'json', data: { documents: sliced, truncated, rowCount: sliced.length } },
            ],
            metadata: { rows: sliced.length, truncated },
          };
        },
      },
      {
        name: `${id}.aggregate`,
        description: `Run a read-only aggregation pipeline. Stages that mutate data (\`$out\`, \`$merge\`) are rejected.`,
        inputSchema: z
          .object({
            collection: z.string().min(1),
            pipeline: z.array(z.record(z.string(), z.unknown())).min(1),
            limit: z.number().int().positive().max(1000).optional(),
          })
          .strict(),
        scopes: ['tables:read', 'query:raw'],
        readOnly: true,
        handler: async ({ collection, pipeline, limit }, ctx) => {
          for (const stage of pipeline) {
            for (const op of Object.keys(stage)) {
              if (op === '$out' || op === '$merge') {
                throw new McpolyglotError(
                  'forbidden.read_only',
                  `Aggregation stage "${op}" mutates data and is not allowed`,
                );
              }
            }
          }
          const rowCap = Math.min(limit ?? ctx.limits.rowCap, ctx.limits.rowCap);
          const cursor = this.requireDb()
            .collection(collection)
            .aggregate([...pipeline, { $limit: rowCap + 1 }], {
              maxTimeMS: Math.min(ctx.limits.timeoutMs, MONGO_OP_BUDGET_MS),
            });
          const docs = await cursor.toArray();
          const truncated = docs.length > rowCap;
          const sliced = truncated ? docs.slice(0, rowCap) : docs;
          return {
            content: [{ type: 'json', data: { documents: sliced, truncated } }],
            metadata: { rows: sliced.length, truncated },
          };
        },
      },
    ];
  }

  private async cachedOrFetchCollections(): Promise<CollectionSchema[]> {
    if (!this.cachedCollections) this.cachedCollections = await this.discoverCollections();
    return this.cachedCollections;
  }

  private async discoverCollections(): Promise<CollectionSchema[]> {
    const db = this.requireDb();
    const list = await db.listCollections({}, { nameOnly: true }).toArray();
    const out: CollectionSchema[] = [];
    for (const { name } of list) {
      if (name.startsWith('system.')) continue;
      const sample = (await db
        .collection(name)
        .aggregate([{ $sample: { size: 25 } }], { maxTimeMS: 5_000 })
        .toArray()) as Array<Record<string, unknown>>;
      out.push({ name, sampledFields: inferFields(sample) });
    }
    return out;
  }

  private requireDb(): Db {
    if (!this.db)
      throw new McpolyglotError('connector.not_initialized', 'MongoConnector not connected');
    return this.db;
  }
}

function inferFields(sample: Array<Record<string, unknown>>): CollectionSchema['sampledFields'] {
  const acc = new Map<string, { types: Set<string>; nullCount: number }>();
  const visit = (obj: Record<string, unknown>, prefix: string): void => {
    for (const [k, v] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${k}` : k;
      const slot = acc.get(path) ?? { types: new Set<string>(), nullCount: 0 };
      const t = v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;
      slot.types.add(t);
      if (v === null) slot.nullCount += 1;
      acc.set(path, slot);
      if (t === 'object' && v && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, path);
      }
    }
  };
  for (const doc of sample) visit(doc, '');
  return Array.from(acc.entries())
    .map(([path, slot]) => ({
      path,
      types: Array.from(slot.types),
      nullable: slot.nullCount > 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

function extractDbFromUri(uri: string): string | undefined {
  // mongodb://host[:port][,host:port,...]/dbname?options
  try {
    const u = new URL(uri.replace(/^mongodb\+srv:/, 'https:').replace(/^mongodb:/, 'https:'));
    const dbName = u.pathname.replace(/^\//, '');
    return dbName || undefined;
  } catch {
    return undefined;
  }
}

async function loadMongo(): Promise<typeof import('mongodb')> {
  try {
    return await import('mongodb');
  } catch {
    throw new McpolyglotError(
      'connector.missing_dep',
      'The "mongodb" package is required for the mongo connector. Install it with: pnpm add mongodb',
    );
  }
}
