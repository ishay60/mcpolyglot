import type { ToolResult } from '@mcpolyglot/core';

export interface RedactionRule {
  name: string;
  regex: RegExp;
  replacement?: string;
}

export interface ColumnDenyEntry {
  /** "schema.table.column" or "table.column" or "collection.field" */
  path: string;
}

const BUILT_IN_RULES: RedactionRule[] = [
  {
    name: 'email',
    regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
  },
  {
    name: 'jwt',
    regex: /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g,
  },
  {
    name: 'aws-access-key',
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  },
  {
    name: 'github-token',
    regex: /\bgh[opsu]_[A-Za-z0-9]{36,}\b/g,
  },
  {
    name: 'us-ssn',
    regex: /\b\d{3}-\d{2}-\d{4}\b/g,
  },
  {
    name: 'credit-card',
    regex: /\b(?:\d[ -]*?){13,19}\b/g,
  },
];

export class Redactor {
  private readonly rules: RedactionRule[];
  private readonly denyColumns: Set<string>;

  constructor(opts: { customRules?: RedactionRule[]; denyColumns?: ColumnDenyEntry[] } = {}) {
    this.rules = [...BUILT_IN_RULES, ...(opts.customRules ?? [])];
    this.denyColumns = new Set((opts.denyColumns ?? []).map((c) => c.path.toLowerCase()));
  }

  apply(_toolName: string, result: ToolResult): { result: ToolResult; redactionsApplied: number } {
    let count = 0;
    const next: ToolResult = {
      ...result,
      content: result.content.map((block) => {
        if (block.type === 'text' && typeof block.text === 'string') {
          const { text, redactions } = this.redactString(block.text);
          count += redactions;
          return { ...block, text };
        }
        if (block.type === 'json') {
          const { value, redactions } = this.redactJson(block.data);
          count += redactions;
          return { ...block, data: value };
        }
        return block;
      }),
    };
    return { result: next, redactionsApplied: count };
  }

  /** Apply the text rules (no column denies) to one string. */
  redactText(input: string): string {
    return this.redactString(input).text;
  }

  private redactString(input: string): { text: string; redactions: number } {
    let redactions = 0;
    let text = input;
    for (const rule of this.rules) {
      text = text.replace(rule.regex, () => {
        redactions += 1;
        return rule.replacement ?? `[REDACTED:${rule.name}]`;
      });
    }
    return { text, redactions };
  }

  private redactJson(value: unknown): { value: unknown; redactions: number } {
    let redactions = 0;
    const visit = (v: unknown, path: string[]): unknown => {
      if (v === null || v === undefined) return v;
      if (typeof v === 'string') {
        const r = this.redactString(v);
        redactions += r.redactions;
        return r.text;
      }
      if (Array.isArray(v)) return v.map((x) => visit(x, path));
      if (typeof v === 'object') {
        const out: Record<string, unknown> = {};
        for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
          const child = [...path, k].join('.').toLowerCase();
          if (this.isDenied(child, k)) {
            redactions += 1;
            continue;
          }
          // Query results list column names alongside rows; don't leak a denied column's name.
          if (k === 'columns' && Array.isArray(val)) {
            out[k] = val.filter((c) => typeof c !== 'string' || !this.isDenied(c.toLowerCase(), c));
            continue;
          }
          out[k] = visit(val, [...path, k]);
        }
        return out;
      }
      return v;
    };
    return { value: visit(value, []), redactions };
  }

  private isDenied(fullPath: string, leaf: string): boolean {
    if (this.denyColumns.has(fullPath)) return true;
    for (const denied of this.denyColumns) {
      if (denied.endsWith(`.${leaf.toLowerCase()}`)) return true;
    }
    return false;
  }
}
