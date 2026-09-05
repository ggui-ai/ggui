/**
 * Bounds the browser runtime shares with the server — its own module
 * (ggui#819) so `@ggui-ai/protocol/wire` carries the number, not the tool
 * schemas that enforce it.
 */
/**
 * Per-batch event cap on `ggui_runtime_telemetry` — a bounded
 * fire-and-forget diagnostic channel, never a data plane.
 */
export const RUNTIME_TELEMETRY_MAX_EVENTS = 40;
