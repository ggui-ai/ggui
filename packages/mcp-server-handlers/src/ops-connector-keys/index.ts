/**
 * Operator-class connector-keys handler family.
 *
 * Three MCP tools, all `audience: ['ops']`, all served on `/ops`. Pure
 * over the {@link ConnectorKeysSource} seam.
 *
 *   - `createListConnectorKeysHandler` → `ggui_ops_list_connector_keys`
 *   - `createIssueConnectorKeyHandler` → `ggui_ops_issue_connector_key`
 *   - `createRevokeConnectorKeyHandler` → `ggui_ops_revoke_connector_key`
 */

export type {
  ConnectorKeySummary,
  ConnectorKeysSource,
  IssueConnectorKeyResult,
} from './types.js';
export {
  ConnectorKeyAccessDeniedError,
  ConnectorKeyNotFoundError,
} from './types.js';

export { createListConnectorKeysHandler } from './list-connector-keys.js';
export type {
  ListConnectorKeysDeps,
  ListConnectorKeysOutput,
} from './list-connector-keys.js';

export { createIssueConnectorKeyHandler } from './issue-connector-key.js';
export type {
  IssueConnectorKeyDeps,
  IssueConnectorKeyOutput,
} from './issue-connector-key.js';

export { createRevokeConnectorKeyHandler } from './revoke-connector-key.js';
export type {
  RevokeConnectorKeyDeps,
  RevokeConnectorKeyOutput,
} from './revoke-connector-key.js';
