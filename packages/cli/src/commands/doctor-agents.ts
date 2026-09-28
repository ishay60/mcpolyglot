import pc from 'picocolors';
import type { Connector } from '@mcpolyglot/core';
import type { McpolyglotConfig } from '@mcpolyglot/config';
import { agentScopes } from '../factory.js';
import { section, ok, warn, stdoutSink, sym } from '../ui.js';

/** Per agent: which sources and tools it can use over HTTP, and which it can't. */
export function doctorAgents(cfg: McpolyglotConfig, connectors: Connector[]): void {
  if (!cfg.agents) return;
  section('Agents', stdoutSink);
  for (const a of cfg.agents) {
    const listed = cfg.sources.filter((s) => s.id in a.sources);
    const scopes = agentScopes(a, listed);
    const active = a.tokens.filter((t) => !t.revoked).length;
    const detail = `${active} active token(s) · scopes: ${scopes.join(', ') || 'none'}`;
    if (active === 0) warn(a.id, `${detail} — every token is revoked`, stdoutSink);
    else ok(a.id, detail, stdoutSink);
    for (const c of connectors) {
      const policy = a.sources[c.id]?.policy ? pc.dim(' (own policy)') : '';
      if (!(c.id in a.sources)) {
        process.stdout.write(`      ${sym.err} ${pc.dim(c.id)}  ${pc.dim('not listed')}\n`);
        continue;
      }
      for (const t of c.listPrimitiveTools()) {
        const missing = t.scopes.filter((s) => !scopes.includes(s));
        process.stdout.write(
          missing.length === 0
            ? `      ${sym.ok} ${pc.bold(t.name)}${policy}\n`
            : `      ${sym.err} ${t.name}  ${pc.dim(`missing ${missing.join(', ')}`)}\n`,
        );
      }
    }
  }
}
