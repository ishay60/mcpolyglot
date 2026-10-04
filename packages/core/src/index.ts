export type {
  Connector,
  ConnectorInitCtx,
  ConnectorKind,
  SchemaSnapshot,
  TableSchema,
  CollectionSchema,
  OperationSchema,
  ColumnSchema,
} from './connector.js';

export type {
  ToolDefinition,
  ToolHandler,
  ToolExecCtx,
  ToolExecLimits,
  ToolResult,
  ContentBlock,
  Scope,
} from './tool.js';

export { ALL_SCOPES, DEFAULT_SCOPES } from './tool.js';

export {
  McpolyglotServer,
  type McpolyglotServerOptions,
  type AgentGrant,
  type SecurityServices,
  type SecurityHooks,
} from './server.js';

export type { Transport } from './transport.js';

export {
  McpolyglotError,
  ScopeError,
  RateLimitError,
  TimeoutError,
  ConfigError,
} from './errors.js';
