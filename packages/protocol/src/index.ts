export * from './version';
export * from './types/auth';
export * from './types/capabilities';
export * from './types/events';
export * from './types/region';
export * from './types/render';
export * from './types/ggui-session-event';
export * from './types/thread';
// Live-channel contract payload types — SubscribePayload / AckPayload /
// StreamEnvelope / etc. The WHAT each live-channel message carries,
// independent of how the wire frames it.
export * from './types/live-channel';
// WebSocket transport envelope (WebSocketMessage / WebSocketMessageType
// / ConnectionStatus) is NOT re-exported at root. Transport implementors
// import it from the dedicated subpath: `@ggui-ai/protocol/transport/
// websocket`. That keeps `@ggui-ai/protocol`'s root surface free of
// wire-framing baggage — consumers that only need contract shapes don't
// pay the transport types' weight.
export * from './types/ui-generator';
export * from './types/mcp';
export * from './schemas/mcp';
export * from './schemas/invoke';
export * from './schemas/data-contract';
// Registry-side helpers — pure utilities for computing the canonical
// identity hash of a DataContract shape. Consumed by the Tier 1
// exact-match path of the blueprint registry.
export {
  canonicalizeContracts,
  canonicalizeValue,
} from './registry/canonicalize-contract';
// `blueprintKey` lives at `@ggui-ai/protocol/blueprint-key` (server-only).
// It pulls in `node:crypto`, which browsers can't bundle. Same convention
// as `./content-hash`. Server consumers import from the subpath:
//   import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
export { summarizeContract } from './registry/summarize-contract';
// Explicit type re-exports — `export *` from a types-only file does not always
// surface re-exported types in the generated .d.ts root index when the source
// uses `export type` (TS's emit elides them in some configurations). Listing
// each type here guarantees consumers can `import type { InvokeEvent } from
// '@ggui-ai/protocol'` regardless of how the bundler lifts the namespace.
export type {
  // Content blocks
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ContentBlock,
  // Deltas
  TextDelta,
  InputJsonDelta,
  ContentBlockDeltaPayload,
  // Events
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  PingEvent,
  ErrorEvent,
  InvokeEvent,
  InvokeErrorCode,
  // Request
  InvokeTurn,
  InvokeRequest,
} from './types/invoke';
export * from './types/llm';
export * from './types/llm-route';
export * from './types/openrouter-models';
export * from './types/interface-context';
export * from './types/host-context';
export * from './types/canvas-lifecycle';
export * from './types/data-bindings';
export * from './types/feedback';
export * from './types/data-contract';
export * from './types/blueprint';
export * from './types/portable-blueprint';
export * from './schemas/blueprint';
export * from './types/handshake-suggestion';
export * from './schemas/handshake-suggestion';
// Operator-class blueprint tool schemas. Lives alongside the blueprint
// type schemas so handlers + cloud pod + console + fixtures all import
// the wire shape from one place.
export * from './schemas/ops-blueprint';
export * from './types/contract-inference';
export * from './types/gadget';
export * from './types/app-config';
export * from './iframe-bridge';
export * from './envelope-adapters';
export * from './envelopes/builders';
export * from './errors/version-mismatch';
export * from './errors/unknown-permission-name';
export * from './validation/contract-validator';
export * from './validation/cross-references';
export * from './validation/hygiene-rules';
export * from './validation/lint-contract';
export * from './validation/name-invariants';
export * from './validation/schema-compat-invariants';
export * from './validation/schema-meta-validation';
export * from './validation/resolve-stream-channel';
export * from './validation/reserved-channels';
export * from './validation/sanitize-error';
export * from './validation/schema-subset';
export * from './validation/zod-to-json-schema';
export * from './validation/ui-security';
export * from './stream/stream-parser';
export * from './bridge/invoke-agent';
export * from './schema-learning/merge';
export * from './schema-learning/derive-contract';
export * from './screen-blueprints/index';
export * from './types/credential';
export { GGUI_AGENT_SYSTEM_PROMPT } from './recommended-prompts';
export * from './types/mcp-proxy';
export {
  STDLIB_GADGETS,
  STDLIB_GADGETS_PACKAGE,
  STDLIB_GADGETS_VERSION,
  STDLIB_GADGET_HOOKS,
} from './gadgets/stdlib-gadgets';
export {
  filterDescriptorsToContract,
  gadgetIdentityKey,
  gadgetExportName,
  listContractGadgets,
} from './gadgets/resolve-contract-gadgets';
