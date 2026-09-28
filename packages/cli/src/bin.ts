#!/usr/bin/env node
import { Command } from 'commander';
import pc from 'picocolors';
import { serveCommand } from './commands/serve.js';
import { initCommand } from './commands/init.js';
import { doctorCommand } from './commands/doctor.js';
import { toolsCommand } from './commands/tools.js';
import { tokenCreateCommand, tokenHashCommand } from './commands/token.js';

const VERSION = '0.0.1';

function bannerHeader(): string {
  const wordmark =
    pc.cyan('m') +
    pc.cyan('c') +
    pc.cyan('p') +
    pc.magenta('o') +
    pc.magenta('l') +
    pc.magenta('y') +
    pc.magenta('g') +
    pc.magenta('l') +
    pc.magenta('o') +
    pc.magenta('t');
  const tag = pc.bgCyan(pc.black(pc.bold(' MCP ')));
  return `\n  ${pc.cyan('▲')}  ${pc.bold(wordmark)}  ${tag}  ${pc.dim('v' + VERSION)}\n     ${pc.dim('one config, every database your agent needs')}\n`;
}

const program = new Command();
program
  .name('mcpolyglot')
  .description('Turn your databases and APIs into Model Context Protocol servers.')
  .version(VERSION, '-V, --version', 'output the version')
  .helpOption('-h, --help', 'display help')
  .addHelpText('beforeAll', bannerHeader())
  .addHelpText('afterAll', `\n  ${pc.dim('docs: github.com/ishay60/mcpolyglot')}\n`);

program
  .command('init')
  .description('Interactively scaffold an mcpolyglot.config.ts in the current directory.')
  .option('--cwd <dir>', 'Directory to scaffold into', process.cwd())
  .action(async (opts) => {
    await initCommand({ cwd: opts.cwd });
  });

program
  .command('serve')
  .description('Start the mcpolyglot MCP server.')
  .option('-c, --config <path>', 'Path to config file', 'mcpolyglot.config.ts')
  .option('--http', 'Use Streamable HTTP transport instead of stdio', false)
  .option('--port <number>', 'Port for HTTP transport', '7337')
  .option('--host <host>', 'Host for HTTP transport', '127.0.0.1')
  .action(async (opts) => {
    await serveCommand({
      config: opts.config,
      http: opts.http,
      host: opts.host,
      port: Number(opts.port),
    });
  });

program
  .command('doctor')
  .description('Validate config, resolve secrets, ping each source, and list generated tools.')
  .option('-c, --config <path>', 'Path to config file', 'mcpolyglot.config.ts')
  .action(async (opts) => {
    const ok = await doctorCommand({ config: opts.config });
    process.exit(ok ? 0 : 1);
  });

program
  .command('tools')
  .description('List all tools that mcpolyglot would expose for the current config.')
  .option('-c, --config <path>', 'Path to config file', 'mcpolyglot.config.ts')
  .action(async (opts) => {
    await toolsCommand({ config: opts.config });
  });

const token = program.command('token').description('Manage per-agent HTTP bearer tokens.');
token
  .command('create <agentId>')
  .description('Mint a new token; prints it once with its sha256 hash and a config snippet.')
  .action((agentId: string) => tokenCreateCommand(agentId));
token
  .command('hash')
  .description('Print the sha256 hash of a token read from stdin.')
  .action(async () => {
    await tokenHashCommand();
  });

program.parseAsync(process.argv).catch((err: Error) => {
  console.error(`mcpolyglot: ${err.message}`);
  process.exit(1);
});
