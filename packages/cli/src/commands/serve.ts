import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { extname, basename } from 'node:path';
import pc from 'picocolors';
import { loadConfig, type McpolyglotConfig } from '@mcpolyglot/config';
import { StdioTransport } from '@mcpolyglot/core/transports/stdio';
import { StreamableHttpTransport } from '@mcpolyglot/core/transports/streamable-http';
import { buildServerFromConfig } from '../factory.js';
import { headerBar, section, kv, ready, footerBar, sym, link } from '../ui.js';

type HttpTransportConfig = Extract<McpolyglotConfig['transport'], { kind: 'http' }>;
type HttpAuthConfig = HttpTransportConfig['auth'];

export interface ServeOptions {
  config: string;
  http: boolean;
  host: string;
  port: number;
}

export async function serveCommand(opts: ServeOptions): Promise<void> {
  const startedAt = Date.now();

  if (extname(opts.config) === '.ts' || extname(opts.config) === '.mts') {
    try {
      register('tsx/esm', pathToFileURL('./'));
    } catch {
      // tsx unavailable — config loader will throw a clear error if it tries.
    }
  }

  headerBar({
    version: '0.0.1',
    command: 'serve',
    subtitle: 'one config, every database your agent needs',
  });

  const cfg = await loadConfig(opts.config);
  const { server, connectors } = await buildServerFromConfig(cfg);

  section('Sources');
  for (const c of connectors) {
    const tools = c.listPrimitiveTools().length;
    process.stderr.write(
      `  ${sym.bullet} ${pc.bold(c.id)}  ${pc.dim(`(${c.kind})`)}  ${pc.dim('—')}  ${pc.cyan(`${tools} tools`)}\n`,
    );
  }

  section('Transport');
  // --http flag overrides config; otherwise honor cfg.transport.kind.
  const wantHttp = opts.http || cfg.transport.kind === 'http';
  const httpHost = cfg.transport.kind === 'http' && !opts.http ? cfg.transport.host : opts.host;
  const httpPort = cfg.transport.kind === 'http' && !opts.http ? cfg.transport.port : opts.port;
  const httpAuth: HttpAuthConfig =
    cfg.transport.kind === 'http' ? cfg.transport.auth : { type: 'bearer' };

  let transport: StdioTransport | StreamableHttpTransport;
  if (wantHttp) {
    const httpTransport = new StreamableHttpTransport({
      host: httpHost,
      port: httpPort,
      auth:
        httpAuth.type === 'oauth'
          ? {
              kind: 'oauth',
              issuer: httpAuth.issuer,
              audience: httpAuth.audience,
              ...(httpAuth.jwksUri ? { jwksUri: httpAuth.jwksUri } : {}),
            }
          : { kind: 'bearer', ...(httpAuth.token ? { token: httpAuth.token } : {}) },
    });
    transport = httpTransport;
    kv('Mode', pc.cyan('streamable-http'));
    kv('URL', link(`http://${httpHost}:${httpPort}/mcp`));
    kv('Health', link(`http://${httpHost}:${httpPort}/healthz`));
    if (httpTransport.authKind === 'oauth' && httpAuth.type === 'oauth') {
      kv('Auth', pc.cyan(`oauth · ${httpAuth.issuer}`));
      kv('Audience', pc.dim(httpAuth.audience));
    } else if (httpTransport.bearerToken) {
      kv('Token', pc.yellow(httpTransport.bearerToken));
    }
    kv('Config', pc.dim(basename(opts.config)));
  } else {
    transport = new StdioTransport();
    kv('Mode', pc.cyan('stdio'));
    kv('Config', pc.dim(basename(opts.config)));
  }

  await server.start(transport);

  ready(Date.now() - startedAt);
  const auditSinks = [
    cfg.audit.console && (cfg.transport.kind === 'stdio' ? 'stderr' : 'stdout'),
    cfg.audit.path,
    cfg.audit.webhookUrl && 'webhook',
  ].filter(Boolean);
  footerBar(['Ctrl+C to stop', `audit: ${auditSinks.join(', ') || 'off'}`]);

  const shutdown = async () => {
    process.stderr.write(pc.dim('\n  shutting down…\n'));
    await server.stop().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
