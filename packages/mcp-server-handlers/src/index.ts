/**
 * @ggui-ai/mcp-server-handlers — shared MCP tool-handler logic.
 *
 * Pure over `@ggui-ai/mcp-server-core` seams. `@ggui-ai/mcp-server`
 * runs these handlers with in-memory adapters by default; other hosts
 * bind the same handlers to their own context and storage backends.
 *
 * Never imports AWS, Express, MCP-SDK transports, or CLI concerns.
 *
 * This package is additive — handlers land subpath by subpath. The root
 * barrel re-exports the stable `HandlerContext` + `SharedHandler` shape.
 * Handler families live behind subpath exports (e.g.
 * `@ggui-ai/mcp-server-handlers/blueprints`) to make it obvious when
 * consumers are reaching for a specific family vs. the core contract.
 */

export * from "./blueprints/index.js";
export * from "./renders/index.js";
export {
  AuthRequiredError,
  HANDLER_FAILURE_MARKER,
  handlerFailure,
  isHandlerFailure,
} from "./types.js";
export type {
  AudienceTag,
  HandlerContext,
  HandlerFailure,
  SharedHandler,
  SharedHandlerResult,
} from "./types.js";
// Persistent-chat handler family — thread storage and message
// history MCP tools. Thin over @ggui-ai/mcp-server-core ThreadStore.
// Available under `@ggui-ai/mcp-server-handlers/threads` subpath too.
export * from "./threads/index.js";
// Credit handler family — read-only MCP tools for the prepaid
// credit system. Available under
// `@ggui-ai/mcp-server-handlers/credits` subpath too.
export * from "./credits/index.js";
// App-discovery handler family — per-app metadata lookups, including
// `ggui_list_gadgets`. Available under
// `@ggui-ai/mcp-server-handlers/app-discovery` subpath too.
export * from "./app-discovery/index.js";
// Operator-class blueprint handler family — `ggui_ops_*` tools
// served on the `/ops` route. Available under
// `@ggui-ai/mcp-server-handlers/ops-blueprint` subpath too.
export * from "./ops-blueprint/index.js";
// Operator-class apps, orgs, connector-keys, and coupon handler
// families — `ggui_ops_*` tools backing the console's management
// surfaces, each pure over a deps seam. Subpaths:
// `@ggui-ai/mcp-server-handlers/ops-apps`, `…/ops-orgs`,
// `…/ops-connector-keys`, `…/ops-coupon`.
export * from "./ops-apps/index.js";
export * from "./ops-connector-keys/index.js";
export * from "./ops-coupon/index.js";
export * from "./ops-orgs/index.js";
