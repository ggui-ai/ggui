/**
 * @ggui-ai/mcp-server-core — core server-side contracts and storage seams.
 *
 * Core contracts shared by:
 *   - `@ggui-ai/mcp-server` — binds SQLite / in-memory / file adapters
 *   - `@ggui-ai/ui-gen` — the generation harness, which implements `UiGenerator`
 *   - Community adapters (Postgres/pgvector, Redis, Neo4j, etc.) against
 *     the negotiator / embedding / vector / kv seams.
 *
 * Each seam is a narrow interface so storage backends and hosting
 * environments can be swapped independently. The cross-cutting seams
 * `TelemetrySink`, `AuditSink`, `RateLimiter`, and `QuotaStore` are all
 * re-exported here; `Notifier` and `BillingAdapter` are not yet.
 */

export * from './ui-generator.js';
// Generator registry seam. Operators register multiple `UiGenerator`
// impls (default + advanced + future cohorts) under stable
// `ui-gen-<tier>-<model>` slugs. The registry is the addressable seam
// blueprints, benchmarks, and the console all hang off of.
export * from './generator-registry.js';
// Multi-variant blueprint persistence + selector seams. Multiple
// `Blueprint` rows MAY share `(appId, contractHash)`; the selector
// picks one at runtime via a deterministic fallback ladder (an
// optional LLM-driven pick can layer on top). The code body lives in
// S3 in cloud adapters; in-memory holds it inline via `Map<codeHash, string>`.
export * from './blueprint-store.js';
export * from './blueprint-selector.js';
// Multi-axis blueprint search across `(appId, *)`. Sister of
// BlueprintStore: the store is a byte-exact key lookup; search finds
// the closest match by hash + embedding + structure + variance +
// intent across the entire app. The three-step handshake is the
// load-bearing consumer (parallel search + validate).
export * from './blueprint-search.js';
// LLM-driven variant selector seam. Layers an LLM-pick step ahead of
// the deterministic ladder, with a `(contractHash, persona,
// context-hash)`-keyed cache and graceful fall-through to the ladder
// on low confidence, errors, or no LLM bound. The deterministic
// ladder remains the load-bearing floor.
export * from './variant-selection.js';
export * from './variant-selector-with-llm.js';
export * from './session-store.js';
export * from './session-stream-buffer.js';
export * from './stream-fanout.js';
export * from './pending-event-consumer.js';
// Optional active-consumer awareness seam. Tracks which stack items
// currently have an in-flight `ggui_consume` long-poll so
// `submit-action.ts` can surface `consumerPresent` on its response.
// Absent → graceful degradation (iframe falls back to 10s claim timer).
// See `active-consumer-registry.ts` for the wiring contract.
export * from './active-consumer-registry.js';
// Persistent-chat store seam. Protocol wire shapes live in
// `@ggui-ai/protocol` (`types/thread.ts`); this barrel exposes the
// server-side storage contract and its errors.
export * from './thread-store.js';
export * from './blueprint-provider.js';
export * from './auth-adapter.js';
export * from './pairing.js';
// The `ggui.json` schema lives in `@ggui-ai/protocol`. It is a
// protocol-layer portability primitive, not a server-side interface,
// so it belongs on the protocol barrel rather than here.

// Negotiator / embedding / vector / kv seams.
export * from './negotiator.js';
export * from './embedding-provider.js';
export * from './vector-store.js';
export * from './kv-store.js';

// Live-channel bootstrap/session token primitives — transport-level
// credential mint + verify. General (not MCP-Apps-specific); MCP Apps
// outbound delivery is today's only consumer.
export * from './bootstrap-tokens.js';

// Stable-identity registry for external MCP servers. General seam;
// MCP Apps inbound hosting is today's primary consumer.
export * from './connector-registry.js';

// Key-management seams.
//
//   - `ProviderKeyStore`  : outbound BYOK (server → LLM provider).
//   - `ApiKeyProvider`    : inbound API keys (agent → server).
//
// Two distinct problems; keep them separate by construction.
export * from './provider-key-store.js';
export * from './api-key-provider.js';

// Cross-cutting sinks.
//
//   - `TelemetrySink` : operational/product signals (lossy, sync, non-throwing).
//   - `AuditSink`     : durable change-history (async, throwing, append-only).
//
// Distinct by design — do NOT collapse them into a single sink. See
// per-file module comments for the boundary rule.
export * from './telemetry-sink.js';
export * from './audit-sink.js';

// Admission + accounting seams.
//
//   - `RateLimiter` : admission decision (yes/no + retry hint).
//   - `QuotaStore`  : fixed-window counter storage.
//
// Composed one direction only: limiters MAY wrap stores. Do NOT
// collapse them into a single "limits" abstraction. See per-file
// module comments for the boundary rule.
export * from './rate-limiter.js';
export * from './quota-store.js';

// shortCode → session binding store. Narrow-purpose lookup for
// same-origin `/s/<shortCode>` viewer resolution; the push handler
// in `@ggui-ai/mcp-server-handlers` is the only writer today.
export * from './short-code-index.js';

// Scoped blob storage seam, so hosted (S3) and OSS (filesystem)
// deployments bind one primitive.
export * from './scoped-file-store.js';

// Content-addressable code delivery. One channel for compiled
// componentCode: `GET /code/<hash>.js` with immutable caching.
export * from './code-store.js';

// Per-app metadata seam backing the `ggui_list_gadgets` tool. Lives
// alongside the other per-app primitives (`ProviderKeyStore`,
// `ApiKeyProvider`) and shares the same `appId` namespace handlers
// thread through `ctx.appId`.
export * from './app-metadata-store.js';

// `GadgetCatalogAdapter` impl backed by an `AppMetadataStore`.
// Validates + lints `App.gadgets` on every read so
// `createUiGenerator({ gadgetCatalog })` (and any direct consumer)
// never sees a corrupt catalog.
export {
  AppMetadataGadgetCatalog,
  GadgetCatalogIntegrityError,
  type GadgetCatalogViolation,
} from './app-metadata-gadget-catalog.js';
