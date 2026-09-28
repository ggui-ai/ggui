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
  createSessionRowReads,
  defineHandler,
  handlerFailure,
  isHandlerFailure,
  readSessionRow,
  viewProofUseFor,
} from "./types.js";
export type {
  AudienceTag,
  EnvelopedHandlerDefinition,
  EnvelopeFor,
  HandlerContext,
  HandlerDefinition,
  HandlerFailure,
  SessionRowReads,
  ShapeOutput,
  SharedHandler,
  SharedHandlerOutputBound,
  SharedHandlerOutputData,
  SharedHandlerResult,
  ViewProofDeclaration,
  ViewProofUse,
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
// served on the `/control` plane. Available under
// `@ggui-ai/mcp-server-handlers/ops-blueprint` subpath too.
export * from "./ops-blueprint/index.js";
// Operator-class apps handler family — `ggui_ops_*` tools that
// manage a deployment's apps, pure over the `AppsSource` seam the
// deployment binds. Available under
// `@ggui-ai/mcp-server-handlers/ops-apps` subpath too.
export * from "./ops-apps/index.js";
