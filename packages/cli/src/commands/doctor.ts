import pc from 'picocolors';
import { loadConfig, looksLikeLiteralCredential } from '@mcpolyglot/config';
import type { TableSchema } from '@mcpolyglot/core';
import {
  isColumnDenied,
  PolicySchema,
  tableAccess,
  type SqlConnector,
} from '@mcpolyglot/connector-sql';
import { buildServerFromConfig } from '../factory.js';
import { doctorAgents } from './doctor-agents.js';
import {
  headerBar,
  section,
  ok,
  err,
  warn,
  bullet,
  footerBar,
  stdoutSink,
  sym,
  chip,
} from '../ui.js';

export interface DoctorOptions {
  config: string;
}

export async function doctorCommand(opts: DoctorOptions): Promise<boolean> {
  let allOk = true;

  headerBar(
    {
      version: '0.0.1',
      command: 'doctor',
      subtitle: 'validate config, resolve secrets, ping each source',
    },
    stdoutSink,
  );

  let cfg;
  try {
    cfg = await loadConfig(opts.config);
    section('Config', stdoutSink);
    ok(`parsed`, opts.config, stdoutSink);
  } catch (e) {
    section('Config', stdoutSink);
    err(`failed to parse`, (e as Error).message, stdoutSink);
    return false;
  }

  // Credential heuristic
  const literalUrls = cfg.sources.filter((s) => 'url' in s && looksLikeLiteralCredential(s.url));
  if (literalUrls.length > 0) {
    for (const s of literalUrls) {
      warn(
        `${s.id}: url looks like a literal credential`,
        'use ${env:NAME}, ${file:./path}, or ${keychain:item}',
        stdoutSink,
      );
    }
  }

  // An invalid policy stops the server from starting, so report it before building one.
  for (const s of cfg.sources) {
    const parsed = 'policy' in s ? PolicySchema.safeParse(s.policy ?? {}) : undefined;
    if (parsed && !parsed.success) {
      section('Policy', stdoutSink);
      err(
        `${s.id}: invalid policy`,
        parsed.error.issues.map((i) => i.message).join('; '),
        stdoutSink,
      );
      return false;
    }
  }

  section('Sources', stdoutSink);
  const { connectors, server } = await buildServerFromConfig(cfg);
  for (const [i, c] of connectors.entries()) {
    try {
      await c.init({
        logger: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
      });
      const h = await c.health();
      if (h.ok) {
        ok(c.id, `${c.kind} · ${h.latencyMs} ms`, stdoutSink);
      } else {
        allOk = false;
        err(c.id, h.details ?? 'unhealthy', stdoutSink);
      }
      const tools = c.listPrimitiveTools();
      bullet(pc.dim('tools'), pc.cyan(`${tools.length}`) + pc.dim(` registered`), stdoutSink);
      for (const t of tools) {
        process.stdout.write(
          `      ${sym.bullet} ${pc.bold(t.name)}  ${pc.dim('[')}${pc.cyan(t.scopes.join(', '))}${pc.dim(']')}\n`,
        );
      }
      const src = cfg.sources[i];
      if (c.kind === 'sql' && src && src.kind !== 'mongo' && src.kind !== 'openapi') {
        const snap = await c.introspect();
        if (snap.kind === 'sql' && !printPolicyReport(checkPolicy(src.policy, snap.tables))) {
          allOk = false;
        }
        // The classifier is defense-in-depth; the DB grant is the control. A user that can
        // read server files or is superuser makes the policy advisory, so doctor fails.
        const privs = await (c as SqlConnector).auditPrivileges();
        for (const p of privs) {
          allOk = false;
          err('privileges', p, stdoutSink);
        }
      }
      await c.close();
    } catch (e) {
      allOk = false;
      err(c.id, (e as Error).message, stdoutSink);
    }
  }

  doctorAgents(cfg, connectors);
  await server.stop().catch(() => {});

  section('Summary', stdoutSink);
  if (allOk) {
    stdoutSink(`  ${chip('READY', 'ready')}  mcpolyglot is ready to serve`);
  } else {
    err('one or more checks failed', 'see errors above', stdoutSink);
  }
  footerBar(
    [`run: ${pc.cyan('mcpolyglot serve')}`, `docs: ${pc.cyan('github.com/ishay60/mcpolyglot')}`],
    stdoutSink,
  );
  return allOk;
}

export interface PolicyReport {
  problems: string[];
  readable: string[];
  writable: string[];
  hidden: string[];
  hiddenColumns: string[];
}

/** Check a source's policy against its live schema. `policy` must already parse. */
export function checkPolicy(raw: unknown, tables: TableSchema[]): PolicyReport {
  const policy = PolicySchema.parse(raw ?? {});
  const name = (t: TableSchema) => (t.schema ? `${t.schema}.${t.name}` : t.name);
  const matches = (key: string, t: TableSchema) => {
    const k = key.toLowerCase();
    return k === t.name.toLowerCase() || k === name(t).toLowerCase();
  };
  const report: PolicyReport = {
    problems: [],
    readable: [],
    writable: [],
    hidden: [],
    hiddenColumns: [],
  };

  for (const key of Object.keys(policy.tables)) {
    if (!tables.some((t) => matches(key, t))) {
      report.problems.push(`policy.tables names "${key}", which is not in the schema`);
    }
  }
  for (const entry of policy.denyColumns) {
    const dot = entry.lastIndexOf('.');
    const [table, column] = [entry.slice(0, dot), entry.slice(dot + 1).toLowerCase()];
    const bare = table.split('.').pop()!.toLowerCase();
    const candidates = table === '*' ? tables : tables.filter((t) => t.name.toLowerCase() === bare);
    if (!candidates.some((t) => t.columns.some((c) => c.name.toLowerCase() === column))) {
      report.problems.push(`denyColumns has "${entry}", which matches no column in the schema`);
    }
  }
  for (const t of tables) {
    const access = tableAccess(policy, t.schema ?? 'null', t.name);
    const bucket = access === 'write' ? 'writable' : access === 'read' ? 'readable' : 'hidden';
    report[bucket].push(name(t));
    if (access !== 'none') {
      for (const c of t.columns) {
        if (isColumnDenied(policy, t.name, c.name))
          report.hiddenColumns.push(`${name(t)}.${c.name}`);
      }
    }
  }
  return report;
}

function printPolicyReport(r: PolicyReport): boolean {
  const list = (xs: string[]) => (xs.length ? xs.join(', ') : pc.dim('none'));
  bullet(pc.dim('readable'), list(r.readable), stdoutSink);
  bullet(pc.dim('writable'), list(r.writable), stdoutSink);
  bullet(pc.dim('hidden'), list(r.hidden), stdoutSink);
  bullet(pc.dim('hidden columns'), list(r.hiddenColumns), stdoutSink);
  for (const p of r.problems) err('policy', p, stdoutSink);
  return r.problems.length === 0;
}
