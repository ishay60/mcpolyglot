// Drive `mcpolyglot serve` the way an agent would: an MCP client over stdio.
// Usage: node docs/demo/agent-call.mjs <path-to-cli-bin> <config>
// Called by regenerate.sh; prints what the agent sends and what it gets back.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [cli, config] = process.argv.slice(2);
const require = createRequire(fileURLToPath(new URL('../../packages/core/package.json', import.meta.url)));
const load = (p) => import(pathToFileURL(require.resolve(p)).href);
const { Client } = await load('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = await load('@modelcontextprotocol/sdk/client/stdio.js');

const client = new Client({ name: 'demo-agent', version: '0.0.0' });
await client.connect(
  new StdioClientTransport({ command: 'node', args: [cli, 'serve', '--config', config], stderr: 'ignore' }),
);

async function call(name, args) {
  console.log(`agent → ${name} ${JSON.stringify(args)}`);
  try {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content.map((c) => c.text ?? JSON.stringify(c)).join('\n');
    console.log(`server ← ${res.isError ? '[error] ' : ''}${text}\n`);
  } catch (err) {
    console.log(`server ← [rejected] ${err.message}\n`);
  }
}

await call('sqlite.demo.query', {
  sql: 'SELECT u.name, u.email, u.password_hash, o.total_cents FROM users u JOIN orders o ON o.user_id = u.id',
});
await call('sqlite.demo.query', { sql: "UPDATE users SET email = 'pwned@example.com'" });
await client.close();
