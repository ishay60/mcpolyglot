import { randomBytes } from 'node:crypto';
import { text } from 'node:stream/consumers';
import { hashToken } from '@mcpolyglot/core/transports/streamable-http';

/** Mint a token. The only place mcpolyglot ever prints one; config stores just the hash. */
export function tokenCreateCommand(agentId: string): void {
  const token = `mcpg_${randomBytes(32).toString('base64url')}`;
  const hash = hashToken(token);
  const label = new Date().toISOString().slice(0, 10);
  process.stdout.write(
    `token (shown once, give it to the agent): ${token}\n` +
      `sha256: ${hash}\n\n` +
      `add to the agent in your config:\n` +
      `  agents: [{ id: '${agentId}', tokens: [{ hash: '${hash}', label: '${label}' }], sources: { … } }]\n` +
      `rotate: add this hash next to the old one, move clients over, then set the old one's revoked: true.\n` +
      `restart \`mcpolyglot serve\` to apply.\n`,
  );
}

/** Hash a token read from stdin (trailing newline ignored). */
export async function tokenHashCommand(): Promise<void> {
  const token = (await text(process.stdin)).replace(/\r?\n$/, '');
  if (!token) throw new Error('no token on stdin');
  process.stdout.write(hashToken(token) + '\n');
}
