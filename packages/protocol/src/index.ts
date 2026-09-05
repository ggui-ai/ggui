export * from "./version";
export * from "./types/auth";
export * from "./types/events";
export * from "./types/render";
export * from "./types/ggui-session-event";
export * from "./types/thread";
// Live-channel contract payload types — SubscribePayload / AckPayload /
// StreamEnvelope / etc. The WHAT each live-channel message carries,
// independent of how the wire frames it.
export * from "./types/live-channel";
// WebSocket transport envelope (WebSocketMessage / WebSocketMessageType
// / ConnectionStatus) is NOT re-exported at root. Transport implementors
// import it from the dedicated subpath: `@ggui-ai/protocol/transport/
// websocket`. That keeps `@ggui-ai/protocol`'s root surface free of
// wire-framing baggage — consumers that only need contract shapes don't
// pay the transport types' weight.
export * from "./types/ui-generator";
export * from "./types/mcp";
export * from "./schemas/mcp";
export * from "./schemas/interface-context";
export * from "./schemas/runtime-telemetry-limits";
export * from "./schemas/public-env-key";
export * from "./schemas/render-input-envelope";
export type { DeepReadonly } from "./types/readonly";
export * from "./schemas/invoke";
export * from "./schemas/data-contract";
// Per-app theme overlay — `AppTheme` + injection-safe `appThemeSchema`
// (`--ggui-*` css-var map). Consumed by the deploy/persist path (ggui.json
// → managed cloud app) and projected into the rendered iframe's `:root`.
export * from "./schemas/app-theme";
// Registry-side helpers — pure utilities for computing the canonical
// identity hash of a DataContract shape. Consumed by the Tier 1
// exact-match path of the blueprint registry.
export { canonicalizeContracts, canonicalizeValue } from "./registry/canonicalize-contract";
// `blueprintKey` lives at `@ggui-ai/protocol/blueprint-key` (server-only).
// It pulls in `node:crypto`, which browsers can't bundle. Same convention
// as `./content-hash`. Server consumers import from the subpath:
//   import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
export { summarizeContract } from "./registry/summarize-contract";
// Enforced props schema — the schema-precise render wire artifact
// (P1): the exact schema ggui_render enforces for a handshake, in
// emission form, plus the grammar-safe profile classifier and the
// RFC 8785 canonical serializer. Browser-safe (pure). The sha256
// hash helper is server-only at `@ggui-ai/protocol/props-schema-hash`
// (node:crypto — same convention as `./blueprint-key`).
export {
  buildEnforcedPropsSchema,
  canonicalPropsSchemaBytes,
  classifyPropsSchemaProfile,
  GRAMMAR_SAFE_FORMATS,
  GRAMMAR_SAFE_KEYWORDS,
  type PropsSchemaProfile,
} from "./validation/enforced-props-schema";
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
  // Events
  InvokeEvent,
  InvokeErrorCode,
  // Request
  InvokeTurn,
} from "./types/invoke";
export * from "./types/llm";
// Pre-generation refusal registry (ggui#786) — the closed `code`
// namespace every refusing surface reads from. Browser-safe pure data,
// so it rides the root barrel (unlike ./blueprint-key, which is
// subpathed only because it pulls node:crypto).
export * from "./types/refusal-codes";
export * from "./types/llm-route";
export * from "./types/interface-context";
export * from "./types/host-context";
export * from "./types/lifecycle";
export * from "./types/data-contract";
export * from "./types/blueprint";
export * from "./types/blueprint-source";
export * from "./types/portable-blueprint";
export * from "./schemas/blueprint";
export * from "./types/handshake-suggestion";
export * from "./schemas/handshake-suggestion";
// Operator-class blueprint tool schemas. Lives alongside the blueprint
// type schemas so handlers + a hosted deployment + console + fixtures all import
// the wire shape from one place.
export * from "./schemas/ops-blueprint";
export * from "./types/contract-inference";
export * from "./types/gadget";
export * from "./types/app-config";
// Canonical externally-issued user-id namespace (`'<providerId>:<subject>'`).
// Shared by the OAuth-login routes and the OIDC verify adapter (which
// can't import upward from mcp-server), so every consumer computes the
// same id from one definition.
export { composeOAuthUserId } from "./types/oauth-user-id.js";
export * from "./iframe-bridge";
export * from "./envelope-adapters";
export * from "./envelopes/builders";
export * from "./envelopes/render-refusal";
export * from "./errors/version-mismatch";
export * from "./errors/unknown-permission-name";
// Typed `resources/read` failures → JSON-RPC. The single exit for every
// non-mount outcome of a render-locator read.
export * from "./errors/resource-read";
export * from "./validation/contract-validator";
export * from "./validation/cross-references";
export * from "./validation/is-record";
export * from "./validation/hygiene-rules";
export * from "./validation/lint-contract";
export * from "./validation/name-invariants";
export * from "./validation/schema-compat-invariants";
export * from "./validation/schema-meta-validation";
export * from "./validation/resolve-stream-channel";
export * from "./validation/reserved-channels";
export * from "./validation/sanitize-error";
export * from "./validation/schema-subset";
export * from "./validation/zod-to-json-schema";
export * from "./validation/ui-security";
export * from "./schema-learning/merge";
export * from "./schema-learning/derive-contract";
export * from "./screen-blueprints/index";
export { GGUI_AGENT_SYSTEM_PROMPT } from "./recommended-prompts";
export {
  STDLIB_GADGETS,
  STDLIB_GADGETS_PACKAGE,
  STDLIB_GADGETS_VERSION,
  STDLIB_GADGET_HOOKS,
} from "./gadgets/stdlib-gadgets";
export { resolveAppGadgets } from './gadgets/resolve-app-gadgets';
export {
  filterDescriptorsToContract,
  gadgetIdentityKey,
  gadgetExportName,
  listContractGadgets,
} from "./gadgets/resolve-contract-gadgets";
