import pc from 'picocolors';
import { loadConfig, looksLikeLiteralCredential } from '@mcpolyglot/config';
import { PolicySchema } from '@mcpolyglot/connector-sql';
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
  for (const c of connectors) {
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
      const diagnosis = await c.diagnose?.();
      if (diagnosis) {
        for (const [label, items] of Object.entries(diagnosis.facts)) {
          bullet(pc.dim(label), items.length ? items.join(', ') : pc.dim('none'), stdoutSink);
        }
        for (const p of diagnosis.problems) {
          allOk = false;
          err(p.check, p.message, stdoutSink);
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
