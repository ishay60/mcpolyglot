import pc from 'picocolors';

/** Where to write display output. Stdio MCP servers must keep stdout clean. */
export type Sink = (s: string) => void;
export const stderrSink: Sink = (s) => {
  process.stderr.write(s + '\n');
};
export const stdoutSink: Sink = (s) => {
  console.log(s);
};

/* ────────────────────────────────────────────────────────────────────── */
/*  Symbols                                                               */
/* ────────────────────────────────────────────────────────────────────── */

export const sym = {
  ok: pc.green('✓'),
  err: pc.red('✗'),
  warn: pc.yellow('!'),
  info: pc.cyan('›'),
  arrow: pc.dim('➜'),
  bullet: pc.dim('•'),
  pipe: pc.dim('│'),
  hor: pc.dim('─'),
  dot: pc.dim('·'),
  branch: pc.dim('└'),
};

/* ────────────────────────────────────────────────────────────────────── */
/*  Width                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

const MAX_WIDTH = 78;
const MIN_WIDTH = 56;

/** Width of the visual column we paint into. Prefers stderr (where banners go). */
function termWidth(): number {
  const cols = (process.stderr as { columns?: number }).columns ?? process.stdout.columns ?? 80;
  return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, cols - 4));
}

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function visibleLength(s: string): number {
  return stripAnsi(s).length;
}

function padRightAnsi(s: string, width: number): string {
  return s + ' '.repeat(Math.max(0, width - visibleLength(s)));
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Wordmark + gradient                                                   */
/* ────────────────────────────────────────────────────────────────────── */

/** Duotone "mcpolyglot" — cyan → magenta. */
function wordmark(): string {
  return (
    pc.cyan('m') +
    pc.cyan('c') +
    pc.cyan('p') +
    pc.magenta('o') +
    pc.magenta('l') +
    pc.magenta('y') +
    pc.magenta('g') +
    pc.magenta('l') +
    pc.magenta('o') +
    pc.magenta('t')
  );
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Chips                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

export type ChipKind = 'ok' | 'err' | 'warn' | 'info' | 'ready' | 'neutral';

/**
 * Pill-chip status indicator, e.g. ` OK ` on a green background. Inspired
 * by GitHub Actions / Copilot CLI status pills. Falls back gracefully on
 * terminals without color.
 */
export function chip(label: string, kind: ChipKind = 'neutral'): string {
  const text = ` ${label} `;
  switch (kind) {
    case 'ok':
      return pc.bgGreen(pc.black(pc.bold(text)));
    case 'err':
      return pc.bgRed(pc.white(pc.bold(text)));
    case 'warn':
      return pc.bgYellow(pc.black(pc.bold(text)));
    case 'info':
      return pc.bgCyan(pc.black(pc.bold(text)));
    case 'ready':
      return pc.bgGreen(pc.black(pc.bold(text)));
    case 'neutral':
    default:
      return pc.inverse(pc.bold(text));
  }
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Header bar                                                            */
/* ────────────────────────────────────────────────────────────────────── */

export interface HeaderOptions {
  version: string;
  /** Sub-command name shown as a pill on the right (e.g. "doctor"). */
  command?: string;
  /** Single-line subtitle rendered under the wordmark. */
  subtitle?: string;
}

/**
 * Boxed banner with rounded corners, the duotone wordmark, an optional
 * sub-command pill on the right, and an optional subtitle line. This is the
 * one piece every command opens with — it sets the visual frame.
 */
export function headerBar(opts: HeaderOptions, sink: Sink = stderrSink): void {
  const w = termWidth();
  const inner = w - 2; // account for │ on each side

  const left = `${pc.cyan('▲')}  ${pc.bold(wordmark())}`;
  const versionTag = pc.dim(`v${opts.version}`);
  const cmdPill = opts.command ? `${chip(opts.command, 'info')}  ` : '';
  const right = `${cmdPill}${versionTag}`;

  const gap = Math.max(2, inner - visibleLength(left) - visibleLength(right) - 2);
  const top = pc.dim('╭' + '─'.repeat(inner) + '╮');
  const titleLine = pc.dim('│ ') + left + ' '.repeat(gap) + right + pc.dim(' │');
  const bottom = pc.dim('╰' + '─'.repeat(inner) + '╯');

  sink('');
  sink(`  ${top}`);
  sink(`  ${titleLine}`);
  if (opts.subtitle) {
    const subPad = Math.max(0, inner - visibleLength(opts.subtitle) - 2);
    sink(`  ${pc.dim('│ ')}${pc.dim(opts.subtitle)}${' '.repeat(subPad)}${pc.dim(' │')}`);
  }
  sink(`  ${bottom}`);
  sink('');
}

/**
 * Minimal banner without the box — kept for callers that want the older,
 * lighter look (e.g. nested output). New code should prefer `headerBar`.
 */
export function banner(opts: { version: string; tagline?: string }, sink: Sink = stderrSink): void {
  const triangle = pc.cyan('▲');
  const ver = pc.dim(`v${opts.version}`);
  sink('');
  sink(`  ${triangle}  ${pc.bold(wordmark())}  ${ver}`);
  if (opts.tagline) sink(`     ${pc.dim(opts.tagline)}`);
  sink('');
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Status lines                                                          */
/* ────────────────────────────────────────────────────────────────────── */

function status(
  k: ChipKind,
  glyph: string,
  label: string,
  detail: string | undefined,
  sink: Sink,
): void {
  const tag = chip(glyph, k);
  const main = k === 'err' ? pc.red(label) : k === 'warn' ? pc.yellow(label) : label;
  sink(`  ${tag}  ${main}${detail ? '  ' + pc.dim(detail) : ''}`);
}

export function ok(label: string, detail?: string, sink: Sink = stderrSink): void {
  status('ok', 'OK', label, detail, sink);
}
export function err(label: string, detail?: string, sink: Sink = stderrSink): void {
  status('err', 'ERR', label, detail, sink);
}
export function warn(label: string, detail?: string, sink: Sink = stderrSink): void {
  status('warn', '!!', label, detail, sink);
}
export function info(label: string, detail?: string, sink: Sink = stderrSink): void {
  status('info', 'i', label, detail, sink);
}
export function bullet(label: string, detail?: string, sink: Sink = stderrSink): void {
  sink(`  ${sym.bullet} ${label}${detail ? '  ' + pc.dim(detail) : ''}`);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Layout                                                                */
/* ────────────────────────────────────────────────────────────────────── */

/** Section title with a thin underline beneath it. */
export function section(title: string, sink: Sink = stderrSink): void {
  sink('');
  sink(`  ${pc.bold(title)}`);
  sink(`  ${pc.dim('─'.repeat(Math.max(4, visibleLength(title))))}`);
}

/** Vite-style "Local / Network" key/value column. Right-pads keys for alignment. */
export function kv(label: string, value: string, sink: Sink = stderrSink): void {
  const pad = label.padEnd(8);
  sink(`  ${sym.arrow}  ${pc.bold(pad)} ${value}`);
}

export function divider(sink: Sink = stderrSink): void {
  sink(`  ${pc.dim('─'.repeat(termWidth()))}`);
}

/** "ready in 123 ms" — Copilot-style ready chip + dim duration. */
export function ready(ms: number, sink: Sink = stderrSink): void {
  sink('');
  sink(`  ${chip('READY', 'ready')}  ${pc.dim(`in ${ms} ms`)}`);
}

export function hint(text: string, sink: Sink = stderrSink): void {
  sink(`  ${pc.dim(text)}`);
}

/**
 * Footer bar — separated row of keybinding / docs hints, each separated by
 * a dim middle dot. Mirrors the bottom strip in modern TUIs.
 */
export function footerBar(items: string[], sink: Sink = stderrSink): void {
  const sep = `  ${sym.dot}  `;
  sink('');
  sink(`  ${pc.dim(items.join(sep))}`);
  sink('');
}

/**
 * Step indicator for multi-step flows like `init`. Renders as
 * `[2/3] Pick a source`.
 */
export function step(n: number, total: number, label: string, sink: Sink = stderrSink): void {
  sink('');
  sink(`  ${chip(`${n}/${total}`, 'info')}  ${pc.bold(label)}`);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Panel                                                                 */
/* ────────────────────────────────────────────────────────────────────── */

export interface PanelOptions {
  title?: string;
  lines: string[];
}

/**
 * Bordered panel with rounded corners. Use sparingly — best for "next steps"
 * or "wire into your agent" callouts where the visual frame helps the reader
 * spot the actionable block.
 */
export function panel(opts: PanelOptions, sink: Sink = stderrSink): void {
  const w = termWidth();
  const inner = w - 2;

  const top = pc.dim('╭' + '─'.repeat(inner) + '╮');
  const bottom = pc.dim('╰' + '─'.repeat(inner) + '╯');

  sink('');
  if (opts.title) {
    const t = ` ${pc.bold(opts.title)} `;
    const pad = Math.max(0, inner - visibleLength(t) - 2);
    sink(`  ${pc.dim('╭─')}${t}${pc.dim('─'.repeat(pad) + '╮')}`);
  } else {
    sink(`  ${top}`);
  }
  for (const line of opts.lines) {
    const pad = Math.max(0, inner - visibleLength(line) - 2);
    sink(`  ${pc.dim('│ ')}${line}${' '.repeat(pad)}${pc.dim(' │')}`);
  }
  sink(`  ${bottom}`);
}

/* ────────────────────────────────────────────────────────────────────── */
/*  Tables                                                                */
/* ────────────────────────────────────────────────────────────────────── */

export interface Column {
  header: string;
  width?: number;
  color?: (s: string) => string;
}

export function table(columns: Column[], rows: string[][], sink: Sink = stderrSink): void {
  const widths = columns.map((c, i) =>
    Math.max(c.width ?? 0, c.header.length, ...rows.map((r) => visibleLength(r[i] ?? ''))),
  );
  const head = columns.map((c, i) => pc.bold(pc.dim(c.header.padEnd(widths[i]!)))).join('  ');
  sink(`  ${head}`);
  sink(`  ${widths.map((w) => pc.dim('─'.repeat(w))).join('  ')}`);
  for (const row of rows) {
    const line = columns
      .map((c, i) => {
        const cell = row[i] ?? '';
        const padded = padRightAnsi(cell, widths[i]!);
        return c.color ? c.color(padded) : padded;
      })
      .join('  ');
    sink(`  ${line}`);
  }
}

/** Styled URL — cyan + underline, the Vite/Astro/Wrangler look. */
export function link(url: string, label = url): string {
  return pc.cyan(pc.underline(label === url ? url : label));
}
