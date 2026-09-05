/**
 * `@ggui-ai/protocol/wire` — the browser entry (ggui#819).
 *
 * What a renderer running inside an iframe validates and types against:
 * the contract's shapes and their inference, the live-channel frames, the
 * action envelope, the host-context projection, the reserved-channel
 * guard, the interface-context snapshot, the invoke event, the permission
 * grammar and the two limits the runtime shares with the server. Nothing
 * a SERVER registers or validates — no tool input/output schema, no ops
 * tool, no LLM route table, no contract zod schema — is reachable from
 * here at runtime: a bundler cannot drop a module whose top level builds
 * zod schemas, so the iframe pays for every module its entry reaches
 * (`wire.test.ts` walks the graph and pins that). The root barrel keeps
 * every name; this entry is the same names, fewer modules.
 */
export * from './types/contract-inference';
export * from './types/data-contract';
export * from './types/live-channel';
export * from './types/render';
export * from './types/invoke';
export * from './types/events';
export * from './types/ggui-session-event';
export * from './types/host-context';
export * from './types/interface-context';
export * from './validation/contract-validator';
export * from './validation/reserved-channels';
export * from './validation/hygiene-rules';
export * from './errors/unknown-permission-name';
export * from './envelopes/builders';
export * from './schemas/invoke';
export * from './schemas/interface-context';
export * from './schemas/runtime-telemetry-limits';
export * from './schemas/public-env-key';
export * from './version';
// The gadget family: the stdlib hooks bundled into the iframe validate a
// descriptor draft at runtime (`createGguiGadget`), so the contract-schema
// module comes along — it is what the browser validates there.
export * from './schemas/data-contract';
export * from './types/gadget';
export * from './gadgets/stdlib-gadgets';
export * from './gadgets/resolve-contract-gadgets';
// The iframe bridge vocabulary (`BRIDGE_EVENTS`) — what the RN WebView bridge
// and the web runtime agree on; browser data, not a tool schema.
export * from './iframe-bridge';
export type { ValidateFunction } from './validation/ajv-runtime';
export type { AppTheme } from './schemas/app-theme';
export type { AppDisplayConfig } from './types/app-config';
export type { EndUserIdentity } from './types/auth';
export type {
  GguiRuntimePullInput,
  GguiConsumeOutput,
  ConsumeEventEntry,
  GguiEmitOutput,
  GguiSessionStatus,
} from './types/mcp';
