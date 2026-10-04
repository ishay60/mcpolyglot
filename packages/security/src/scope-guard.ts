import { ScopeError, type Scope } from '@mcpolyglot/core';

export function checkScopes(
  toolName: string,
  required: readonly Scope[],
  granted: ReadonlySet<Scope>,
): void {
  const missing = required.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new ScopeError(`Tool "${toolName}" requires scopes: ${missing.join(', ')}`, {
      toolName,
      required,
      granted: Array.from(granted),
      missing,
    });
  }
}
