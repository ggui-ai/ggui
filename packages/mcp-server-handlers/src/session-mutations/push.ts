/**
 * `ggui_push` — OSS handler for outbound UI delivery.
 *
 * Handshake-first only. The wire input is `{handshakeId, contract? |
 * contractHash?, props?}`; the generator input (intent, context,
 * schema, adapters, forceCreate) is read from the handshake record
 * the agent already wrote in the prior `ggui_handshake` round-trip.
 *
 * The handler stamps declaration-level `_meta.ui.resourceUri` +
 * `_meta.ui.visibility` so MCP Apps hosts know to fetch
 * `ui://ggui/session` on a tool call, and (when `mintWsToken` is
 * wired) emits per-result `_meta["ai.ggui/session"]` +
 * `_meta["ai.ggui/stack-item"]` slice meta carrying the WebSocket
 * bootstrap credentials the iframe shell needs.
 *
 * **What it does:**
 *
 *   1. Validates input (handshakeId required at schema; zod surfaces an actionable rejection if absent).
 *   2. Consumes the handshake record (`getAndDelete`) — single-use.
 *   3. Resolves the effective contract (cheap-confirm via
 *      `contractHash` OR override via `contract`).
 *   4. Validates routing targets on the contract's `actionSpec`.
 *   5. Resolves or creates the session from `record.target.sessionId`.
 *   6. Runs the blueprint matcher when cache is wired (cache-hit
 *      short-circuits generation).
 *   7. Otherwise runs the bound `UiGenerator` and registers the
 *      produced blueprint into the cache.
 *   8. Returns a spec-conformant `pushOutputSchema`-shaped result and
 *      emits the `ai.ggui/*` slice meta pair via `resultMeta`.
 *
 * **Placeholder stack-item invariant.** When the handler is built
 * with `provisionalPreview` deps, an empty-componentCode placeholder
 * StackItem is appended to the session stack BEFORE generation runs.
 * The placeholder gives the iframe-runtime's `stack-item-renderer` a
 * surface to mount the `mountProvisional` branch off — without it,
 * A2UI preview frames on `_ggui:preview` paint into the void (the
 * SessionViewer mounts provisional only PER-STACK-ITEM). When
 * generation later settles, the SAME `stackItemId` is reused —
 * `appendStackItem` upserts by id, so the placeholder is replaced
 * in-place by the authoritative componentCode (success) or an error
 * stack-item (failure).
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type BlueprintVariance,
  type GadgetDescriptor,
  type DataContract,
  type JsonObject,
  type SessionStackEntry,
  type StackItem,
} from '@ggui-ai/protocol';
import {
  GGUI_PUSH_UI_META,
  toMcpAppEnvelope,
  type McpAppAiGguiMeta,
  type McpAppAiGguiSessionMeta,
  type McpAppAiGguiStackItemMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  AppMetadataStore,
  BlueprintProvider,
  KeyValueStore,
  LlmSelection,
  PendingEventConsumer,
  ProviderKeyRef,
  RateLimiter,
  SessionStore,
  ShortCodeIndex,
  UiGenerateInput,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import { RateLimitedError } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  consumeHandshakeRecord,
  peekHandshakeRecord,
  HandshakeNotFoundError,
  type HandshakeRecord,
} from './handshake.js';
import {
  evaluateProvisionalPreviewGate,
  finalizeProvisionalPreview,
  kickoffProvisionalPreview,
  type ProvisionalPreviewDeps,
} from './provisional-preview.js';
import type {
  GenerationCacheDeps,
  GenerationCacheHit,
} from './generation-cache.js';
import { assertContractNoRetiredFields } from './assert-contract-no-retired-fields.js';
import { assertGeneratorRegistered } from './assert-generator.js';
import { assertNoDuplicateGadgetHooks } from './assert-no-duplicate-gadget-hooks.js';
import { matchBlueprint } from './blueprint-matcher.js';
import type { InstalledBlueprintsProvider } from './installed-blueprints-provider.js';
import { registerBlueprint } from './blueprint-registry.js';
import {
  assertGadgetsRegistered,
  filterDescriptorsToContract,
} from './assert-gadgets.js';
import { fetchGadgetTypes } from './fetch-gadget-types.js';
import { assertPublicEnvSatisfied } from './assert-public-env.js';
import type { LLMCaller } from '@ggui-ai/negotiator';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  validatePropsData,
  ContractViolationError,
  assertCrossReferences,
  assertNameInvariants,
  assertSchemaCompat,
  assertContractSchemasValid,
  dataContractSchema,
  STDLIB_GADGETS,
} from '@ggui-ai/protocol';
import {
  emitCacheTraceEvent,
  newCacheTraceId,
  truncateCacheTraceIntent,
} from './cache-trace-sink.js';
import { emitPayloadTraceEvent } from './payload-trace-sink.js';
import {
  deriveStackItemMeta,
  derivePublicEnvProjection,
  deriveContractBundle,
  type StackItemMetaView,
} from './slice-meta-derivation.js';

/**
 * Generation-time deps for the `ggui_push` handler. Absent = the
 * handler stays in placeholder mode (no componentCode written, push
 * returns `codeReady: false` on the story path).
 *
 * Design choices for this seam:
 *
 *   - `uiGenerator` is the extracted `@ggui-ai/ui-gen`
 *     {@link UiGenerator} — the handler does not care whether the
 *     implementation is the thin direct-prompt path or the full
 *     harness workflow. This keeps the handler narrow and the
 *     generator surface swappable.
 *   - `resolveLlm` is the seam the handler uses to get a
 *     `{selection, providerKey}` for THIS push. Returns `null` when
 *     no credentials are available — the handler funnels that case
 *     into the normal failure path (error stack item +
 *     `codeReady: false`). The CLI's `byok-resolver` + default
 *     model table produces this closure; hosted deployments supply
 *     their own. BYOK resolution stays OUT of this package on
 *     purpose — handlers know nothing about env / files.
 *   - `blueprints` is the already-locked
 *     `BlueprintProvider` seam; passed straight to
 *     `uiGenerator.generate`. A reasonable default at the call site
 *     when the operator didn't bind a manifest source (empty
 *     catalog) still works — the generator consults it only when
 *     RAG is enabled.
 *
 * Out of scope for this dep:
 *
 *   - Caching / negotiator decisions. Those layer on top of the
 *     same seam; the shape below doesn't need to change when they
 *     land.
 *   - Streaming partials. The optional `UiGenerator.stream()` is
 *     ignored by this handler — provisional preview already covers
 *     "something visible while generation runs", and streaming a
 *     second partial surface would duplicate that channel.
 */
export interface GenerationDeps {
  /** Concrete UiGenerator — typically built by
   *  `@ggui-ai/ui-gen#createUiGenerator`. */
  readonly uiGenerator: UiGenerator;
  /**
   * Per-push credential lookup. Receives the handler context so
   * multi-tenant hosts can route per-`appId`; OSS single-user
   * resolves from env + `~/.ggui/credentials.json` and ignores the
   * argument. Must return `null` (not throw) when no credentials
   * are available; the handler maps that to a generation failure.
   */
  readonly resolveLlm: (
    ctx: HandlerContext,
  ) => Promise<GenerationCredentials | null> | GenerationCredentials | null;
  /**
   * Blueprint catalog handed to the generator. Same value the
   * caller threads into `blueprintProvider` on the server; this
   * dep re-exposes it explicitly so the handler doesn't reach into
   * `defaultHandlers` deps for it.
   */
  readonly blueprints: BlueprintProvider;
  /**
   * Optional RAG retrieval + cache deps. Absent = generation always
   * runs (no cache lookup, every push hits the LLM).
   *
   * When present, the handler runs a `lookupGenerationCache` on the
   * story path BEFORE invoking the generator:
   *
   *   - Hit (score ≥ threshold) → synthesize a `StackItem` from the
   *     cached componentCode, skip `uiGenerator.generate`, and emit
   *     `cache.hit:true` on the push output.
   *   - Miss → run the existing generator path unchanged; on success,
   *     `recordGenerationCache` upserts the new componentCode into
   *     the scope so the next same-intent push hits.
   *
   * Scope: `ctx.appId`. Key: `sha256(trimmed intent)[0..16]`. Metadata
   * carries `componentCode` directly — a hit doesn't need a secondary
   * blob lookup to rehydrate a `StackItem`.
   *
   * The shape is intentionally optional-at-generation-level rather
   * than a top-level handler dep so the "generation off" default
   * path (no LLM) also has no cache attached — a server without
   * `generation` can't get surprising cache behavior.
   */
  readonly cache?: GenerationCacheDeps;

  /**
   * Per-call LLM resolver for Tier 2 rerank in the blueprint matcher.
   * When wired alongside `cache`, push routes through
   * `matchBlueprint` and uses the registry-based three-tier flow:
   * Tier 1 contract-key exact, Tier 2 RAG + LLM rerank, Tier 3 cold
   * gen + register. When absent, the matcher skips Tier 2 and falls
   * through to cold gen on cache miss — same registry storage, no
   * judge step.
   */
  readonly resolveLlmCaller?: (
    ctx: HandlerContext,
  ) => LLMCaller | null | Promise<LLMCaller | null>;

  /**
   * Optional marketplace-install bridge. When wired
   * alongside `cache`, the push handler threads it into
   * `matchBlueprint` deps so installed blueprints lazily compile
   * + populate the same vector store. The bridge is idempotent per
   * scope; the first matchBlueprint call pays the compile, every
   * subsequent call hits the cache directly.
   *
   * Constructed by the CLI / embedder via
   * `createInstalledBlueprintsProvider(...)` — `mcp-server-handlers`
   * supplies the orchestration logic, the caller supplies discovery
   * + compile callbacks.
   */
  readonly installedBlueprints?: InstalledBlueprintsProvider;

  /**
   * No-credentials fallback hook. Fires only when {@link resolveLlm}
   * returns `null` (no env/file/user-scope key resolved for this
   * push). Successful resolution always wins — the hook never sees
   * a key.
   *
   * When the hook returns a `StackItem`, the handler appends THAT
   * item to the session stack instead of the generic
   * `{reason:'no-credentials'}` error envelope, sets
   * `componentCode` on the bootstrap meta from it, and reports
   * `codeReady: true`. When it returns `null` (or the hook is
   * absent), the handler falls back to the existing
   * `commitErrorStackItem` path so historical no-BYOK behavior is
   * preserved for callers that don't opt in.
   *
   * Authored stack-item invariant: the returned item's `id` MUST
   * equal the in-flight `stackItemId` — `appendStackItem` upserts by id,
   * so reusing the page id replaces the provisional preview
   * placeholder in-place. Helpers in
   * `./no-credentials-card.ts` build the canonical Connect-Claude
   * card shape; embedders compose their own when they need a
   * different "set up your key" surface.
   *
   * Why a hook (not a static stack item dep): the URL the card
   * points at (`/settings`) depends on the operator's resolved
   * public-base-url, which the handler doesn't know. The CLI
   * composes the URL once at boot and threads it into the closure.
   */
  readonly onNoCredentials?: (
    ctx: HandlerContext,
    story: {
      readonly intent: string;
      readonly stackItemId: string;
      readonly nowIso: string;
    },
  ) => SessionStackEntry | null | Promise<SessionStackEntry | null>;
}

/**
 * One credential resolution for a single `ggui_push` call. Shape
 * matches the `UiGenerator.generate` input — the handler passes
 * these fields through unchanged.
 */
export interface GenerationCredentials {
  readonly selection: LlmSelection;
  readonly providerKey: ProviderKeyRef;
}

/**
 * Argument bundle handed to {@link GguiPushHandlerDeps.postSuccessHook}.
 *
 * Carries the resolved push state at success-time so cloud-side
 * fire-and-forget side-effects (RAG indexing, render-cache placeholder
 * write) have everything they need without re-deriving from raw input.
 */
export interface PushPostSuccessArgs {
  readonly ctx: HandlerContext;
  readonly sessionId: string;
  readonly stackItemId: string;
  /** Resolved DataContract used for this push (echoed contract or override). */
  readonly contract: DataContract;
  /** RFC 8785 canonical key of {@link contract}. */
  readonly contractHash: string;
  /**
   * Story intent — the canonical OSS-shape field. Cloud-specific
   * additions (`prompt`, `sourceTools`, etc.) are NOT transited
   * through this interface; cloud's compose layer closes over its
   * own input object to surface them in the hook impl.
   */
  readonly intent: string;
  /** Decision action classification — same value as on the response. */
  readonly action: 'create' | 'reuse' | 'update' | 'replace' | 'compose';
  /** Whether the stack item committed real componentCode. */
  readonly codeReady: boolean;
}

/**
 * Deps for the OSS `ggui_push` handler.
 */
export interface GguiPushHandlerDeps {
  /** Session-backing store. Used to create / reuse sessions on push. */
  readonly sessionStore: SessionStore;
  /**
   * Per-app metadata resolver — when bound, push reads
   * `app.gadgets` and runs `assertGadgetsRegistered`
   * before any state mutation. Every `(package, export name)` the
   * contract declares MUST resolve in the catalog; misses surface as
   * a precise reject: `GadgetNotRegisteredError`
   * (unknown export name, with did-you-mean) or
   * `GadgetPackageMismatchError` (export name under a different
   * package).
   *
   * Optional — the OSS no-app-registry path leaves this unset and
   * the validator becomes a no-op (matching the pre-plugin-slice
   * behavior). Cloud + CLI deployments wire this dep.
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Optional pending-events pipe. When wired, the handler calls
   * `markCreated(stackItemId)` the moment the stackItemId is minted
   * (Model C: pipes are stackItem-keyed, opened at push time so
   * events from `ggui_runtime_submit_action` land in the pipe even
   * BEFORE the agent's first `ggui_consume` arrives — covers the
   * "user clicks before agent polls" race). Idempotent — same
   * instance must be shared with `createGguiSubmitActionHandler` +
   * `createGguiConsumeHandler` for the pipe to actually thread.
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Bootstrap-credential minter for the MCP Apps outbound path. When
   * present, the handler's `resultMeta` emits the live-auth trio on
   * the `ai.ggui/session` slice. When ABSENT, no `_meta` is emitted —
   * non-MCP-Apps hosts read `{sessionId, stackItemId}` straight off
   * `structuredContent` and resolve the session-resource themselves.
   *
   * Returns the live-auth fields on the session slice —
   * `{wsUrl, token, expiresAt}`. The handler adds `sessionId` + `appId`
   * from the push context itself, plus `runtimeUrl` from the separate
   * `runtimeUrl` dep (server-level config, not minter-scoped).
   */
  // Live-mode credential minter. Returns the WS subscribe target +
  // the short-TTL WS auth token + its expiry. These fields are
  // session-slice optional (only live mode populates them); a minter
  // that's wired AT ALL is by construction the live-mode minter, so
  // the return shape pins them required so consumers don't have to
  // narrow. Set this to `undefined` (omit the key) for self-contained
  // / system-card-only deployments.
  readonly mintWsToken?: (
    sessionId: string,
    appId: string,
  ) => { wsUrl: string; token: string; expiresAt: string };
  /**
   * Slug of the single generator bound on this server. Used to
   * validate override-path `blueprintDraft.generator` — unknown
   * names reject at the wire boundary instead of silently falling
   * back to the default. Symmetric with the handshake handler's
   * same-named dep. Defaults to `DEFAULT_GENERATOR_SLUG` when
   * absent; multi-generator deployments would replace this single
   * value with a `knownGenerators: Set<string>` membership check.
   */
  readonly defaultGenerator?: string;
  /**
   * URL of the renderer bundle the thin shell should fetch. Padded
   * onto {@link McpAppAiGguiSessionMeta.runtimeUrl} at `resultMeta` time
   * alongside `sessionId` / `appId`. Separate dep (not a field on
   * `mintWsToken`'s return) because the URL is a server-config
   * value (same for every session), not a per-mint credential.
   *
   * Required when `mintWsToken` is set — the thin-shell HTML's
   * boot path depends on it. Omitted + `mintWsToken` set is a
   * configuration bug; we fall back to `/_ggui/iframe-runtime.js` (the
   * same-origin OSS default) with a warning on first use. Callers
   * composing the deps bundle inside `@ggui-ai/mcp-server` always
   * supply this; it's optional here to preserve backward-compatible
   * test construction where the bootstrap branch isn't exercised.
   *
   * Function form (request-aware): when the OSS server is fronted by
   * a tunnel or reverse proxy, a static configured URL can't know
   * the public host. The server passes a getter that resolves the
   * URL against the current request's context (X-Forwarded-Host
   * when the TCP peer is loopback). Either form is accepted; the
   * handler invokes the function lazily inside the request scope.
   */
  readonly runtimeUrl?: string | (() => string | undefined);
  /**
   * Theme preset id resolved from `ggui.json#theme`. Forwarded onto
   * the `ai.ggui/session.themeId` slice field so MCP Apps hosts
   * (claude.ai web, Claude Desktop) that mount via
   * `ui/notifications/tool-result` postMessage propagate the operator's
   * theme into the iframe's `extractBootstrapFromToolResult` path.
   * Without this, hosts that don't fetch the per-session resource via
   * `resources/read` silently fall back to the iframe-runtime's baked
   * default theme (`ggui`), even when `ggui.json#theme: 'indigo'` is set.
   */
  readonly themeId?: string;
  /** Theme color mode resolved from `ggui.json#theme.mode`. */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Live theme getter — resolved per-push instead of per-boot.
   * When set, supersedes the static `themeId` / `themeMode` deps
   * for every result-meta computation, so a console save (which
   * mutates the underlying state cell) reaches the next push
   * without a server restart.
   *
   * Returns `undefined` when no theme is set (the default-theme
   * path); returns `{ id, mode? }` when a preset is selected. The
   * caller (CLI) constructs a closure that reads from a shared
   * mutable ref the console-theme route also writes to on POST.
   *
   * Static `themeId` / `themeMode` survive as the no-getter
   * fallback for embedding hosts that compose `createGguiServer`
   * directly without dynamic theming — e.g. test fixtures.
   */
  readonly themeProvider?: () => {
    readonly id?: string;
    readonly mode?: 'light' | 'dark';
  } | undefined;
  /**
   * Returns the names of registered tools whose `_meta.ui.visibility`
   * includes `"app"`. Used to populate `bootstrap.appCallableTools`
   * so the iframe-runtime can decide between direct `tools/call`
   * (Pattern α) and the 3-message bridge (Pattern β) per wired action.
   *
   * Returns an empty array when no app-visible tools are registered.
   * Optional in deps because tests / smoke harnesses may not wire the
   * full registry.
   */
  readonly appCallableTools?: () => readonly string[];

  /**
   * Resolver for the bootstrap field `streamWebSocketLocalTools`.
   * Mirrors the same-named field on
   * `GguiHandshakeHandlerDeps.serverCapabilities` so the iframe-runtime
   * can route per-channel transport (WS-subscribe vs iframe-poll)
   * without re-querying the handshake. Closure form so dev-mode
   * reconfig flows in per-push without a restart.
   *
   * Returns the allowlist of `source.tool` names the server can
   * `channel_subscribe`-fan-out. Absent / returns undefined ⇒ field
   * omitted on the bootstrap ⇒ iframe falls back to direct polling for
   * every channel. Returns an empty array ⇒ "supported but no tool
   * is local" — still surfaces verbatim so consumers can
   * differentiate "unsupported" from "supported but empty".
   *
   * Composing hosts MUST keep this resolver in sync with the handshake
   * resolver — the channel-transport contract assumes the two agree.
   * `@ggui-ai/mcp-server`'s `createGguiServer` wires both from the
   * same `streamWebSocketLocalTools` option so drift can't sneak in.
   */
  readonly streamWebSocketLocalTools?: () => readonly string[] | undefined;

  /**
   * Provisional preview orchestration seam. When present AND the
   * per-push gate passes, the handler fires a background preview
   * task that emits A2UI-shaped payloads on the reserved
   * `_ggui:preview` channel. Absence of this dep is the "preview
   * not wired" signal — see {@link ProvisionalPreviewDeps}.
   *
   * The actual runner + fire-and-forget dispatch land in a follow-up
   * commit; this dep is seated so downstream callers (hosted pod,
   * OSS dev mode) can wire their own emitter + flag without further
   * churn to this handler.
   */
  readonly provisionalPreview?: ProvisionalPreviewDeps;

  /**
   * Admission-control seam. When present, every `ggui_push` call is
   * gated through `rateLimiter.check({key, cost: 1})` BEFORE the
   * handler's state-changing work begins. Denials throw
   * `RateLimitedError`; the transport layer projects the carried
   * {@link import('@ggui-ai/mcp-server-core').RateLimitDecision} to
   * HTTP 429 + `Retry-After` / `X-RateLimit-*` headers.
   *
   * Key composition: `ggui_push:<appId>`. The handler does NOT
   * widen the key shape on its own — per-identity-kind or per-user
   * isolation is a policy decision the caller makes by supplying a
   * different `RateLimiter` binding (e.g. a wrapping adapter that
   * includes `ctx.requestId` tags). Keeping the key stable here
   * means the OSS default policy is "per-app", which is the right
   * coarse unit for admission control without extra config.
   *
   * Absence of this dep is the "unlimited / handler is not
   * broken when limiter is absent" invariant — the `NoopRateLimiter`
   * default at composition time makes this a wiring convenience, not
   * a requirement.
   */
  readonly rateLimiter?: RateLimiter;

  /**
   * ShortCode → session lookup. When present, every successful push
   * records the minted `shortCode → { sessionId, appId }` binding so
   * downstream same-origin consumers (console `/s/<shortCode>`
   * viewer) can resolve it back. Writes are best-effort: if the index
   * `put` rejects, the push tool result is NOT failed — the agent
   * already holds the URL and the operator-visible surface gracefully
   * 404s on lookup.
   *
   * Absence of this dep is the "hosted cloud has its own
   * shortCode→session table, OSS isn't using console" signal —
   * `ggui_push` still works end-to-end; same-origin viewer lookups
   * just aren't available.
   */
  readonly shortCodeIndex?: ShortCodeIndex;

  /**
   * Handshake record store. When bound, the handler accepts the
   * handshake-paired input shape `{handshakeId, props?}` and consumes
   * the stored `HandshakeRecord` via `kvStore.getAndDelete` — reading
   * the captured story + target routing + negotiator decision. Absent
   * = handshake-paired input is rejected with a clear error.
   *
   * Keyed by `ggui-handshake:<appId>:<handshakeId>` — same shape the
   * handshake handler writes, so one `KeyValueStore` instance is the
   * source of truth across both tools. Single-use by contract: a
   * second `ggui_push` with the same handshakeId surfaces
   * `HandshakeNotFoundError`. `createGguiHandshakeHandler` is the peer
   * writer; both handlers take the same `KeyValueStore` instance.
   */
  readonly handshakeStore?: KeyValueStore;

  /**
   * Generation wiring. When present AND the push is a story path
   * (not MCP Apps), the handler:
   *
   *   1. Resolves BYOK credentials via `resolveLlm`.
   *   2. Kicks off provisional preview fire-and-forget (same seam
   *      as before — preview runs concurrently with generation).
   *   3. `await`s `uiGenerator.generate(...)`.
   *   4. On success: appends a real `StackItem` with `componentCode`
   *      + `sourceCode` and returns `codeReady: true`.
   *   5. On failure: appends an error-only `StackItem` and returns
   *      `codeReady: false`. Preview teardown fires with reason
   *      `'generation-failed'`.
   *
   * Absent = the current "placeholder" behavior: no stack item
   * appended on the story path, `codeReady: false` on every story
   * push. This keeps the handler honest on OSS hosts that haven't
   * configured BYOK yet — session + shortCode + preview work; real
   * code generation is opt-in through this dep.
   */
  readonly generation?: GenerationDeps;

  /**
   * Schema-compat check hook. When present, fires at three boundaries
   * — push validation (against `story.contract`), cache-hit commit
   * (against the matched blueprint's contract), and gen success
   * (against the generator's response contract). Purpose: if any
   * `actionSpec[name]` tool ref / `streamSpec[channel].tool`
   * ref is incompatible with its tool's registered `inputSchema` /
   * return schema, the handler rejects the push BEFORE the stack write
   * — the agent sees an honest structured failure instead of a stack
   * item that will silently surface as a perpetual loading state.
   *
   * Recovery posture: schema-compat errors are AGENT-FIXABLE — the agent
   * authored a contract whose declared schema doesn't fit the named
   * tool. The check throws `SchemaCompatError` (`schema_mismatch_error`)
   * at the EARLIEST boundary, the error propagates to the push response,
   * and the handshake record is preserved so the agent can retry on
   * the same handshakeId after fixing the contract. This is symmetric
   * with `CrossReferenceError` (`cross_reference_unresolved`) — both
   * are author-recoverable failures rooted in the contract.
   *
   * Type: accepts any shape with optional `actionSpec` / `streamSpec`
   * fields. `DataContract` (push-validation phase) and
   * `SessionStackEntry` with `type: 'component'` (cache-hit + gen
   * success phases) both fit structurally.
   *
   * Absent = no check (the zero-config / no-mounts / tests-with-no-
   * registry case). Servers MAY bind the check helper
   * `@ggui-ai/mcp-server/checkStackItemSchemaCompat` here.
   */
  readonly checkStackItemContracts?: (
    shape: {
      readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
      readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
    },
  ) => void;

  /**
   * Optional live-subscriber notifier. When present, every successful
   * `appendStackItem` (cold-generation success, cache-hit reuse, MCP
   * Apps push, error stack append) fan-outs a `{type:'push',
   * payload:{stackItem, matchType?}}` wire frame to every live
   * subscriber on the affected session.
   *
   * Why optional: the seam exists for transports that hold a live
   * subscription model (live-channel `/ws`). Hosts without a session
   * channel (programmatic embedding, Lambda one-shot invocation) leave
   * it absent — no notify needed because there's no live subscriber.
   *
   * Why a separate seam from `provisionalPreview.sendEnvelope`: stack
   * mutations are NOT stream-channel envelopes. They don't carry a
   * channel name, don't fold under streamSpec validation, and are not
   * subject to the per-channel replay policy. Routing them through
   * `sendToSession` would force a fake stream-channel for state that
   * isn't a stream — keep the wire shape honest by giving stack
   * pushes their own delivery method.
   *
   * Failure model: per-subscriber send failures are swallowed by the
   * channel server; this seam returns `void`. A notify failure cannot
   * make a push fail — the `appendStackItem` already happened, which
   * is the source of truth.
   *
   * Without this notifier, cache-hit + cold-generation second-turn
   * pushes on an already-subscribed session land in the store but not
   * in the live `GguiSession` stack, so the inline UI slot stays in
   * "Waiting for session channel replay…" forever.
   */
  readonly channelNotifier?: ChannelNotifier;

  /**
   * Canvas-mode lifecycle emitter. Fires
   * `push_started` on the `_ggui:lifecycle` channel right after
   * stackItemId is minted so the canvas animator transitions from
   * `ready`/`handshake` to `constructing` immediately — without
   * waiting for the final `push` envelope (which arrives after
   * generation completes).
   *
   * Absent ⇒ no emission. Non-canvas deployments pay zero cost.
   */
  readonly canvasLifecycle?: import('./canvas-lifecycle.js').CanvasLifecycleEmitter;

  /**
   * Content-addressable code-blob store.
   *
   * When present AND a story-path push results in non-empty
   * `componentCode` on the appended stack item, the handler
   * computes `sha256(code)`, writes (hash, code) to the store, and
   * surfaces `codeUrl` + `codeHash` on the push response
   * (`structuredContent` + the `ai.ggui/stack-item` slice). The iframe
   * runtime fetches the URL to load the compiled ES module.
   *
   * Pairs with {@link codeBaseUrl} below — both must be present for
   * URLs to be emitted. The store-without-baseUrl combo writes blobs
   * but emits no URL.
   *
   * Absent = the bootstrap emits no codeUrl. The iframe mounts via
   * live mode (wsUrl+token) and receives the stack item — including
   * componentCode — over the live-channel WS subscribe. Deployments
   * that disable both codeStore AND live-mode cannot deliver a
   * static-component renderable surface; pure agent-driven flows
   * still work via the live-channel path.
   */
  readonly codeStore?: import('@ggui-ai/mcp-server-core').CodeStore;

  /**
   * Base URL the code-blob route resolves to (without trailing
   * slash). E.g. `https://app.example.com`. The handler appends
   * `/code/<hash>.js` to form the iframe-facing URL the binding
   * mounted in {@link codeStore}.
   *
   * Required when `codeStore` is set; the OSS binding pulls this
   * from `--public-base-url` (or the local listener address if
   * absent) so the URL is reachable from the iframe sandbox.
   */
  readonly codeBaseUrl?: string;

  /**
   * Pre-validation gate. Fires at the very TOP of the handler, BEFORE
   * any input parsing or state-changing work. Throws to reject the
   * push — the thrown error class propagates unchanged through
   * JSON-RPC, so the gate owns the wire envelope (e.g. cloud's
   * `PushBillingError` mapping to HTTP 402).
   *
   * Receives raw input (untyped) so the gate can inspect cloud-only
   * fields (e.g. `infra.model` for provider derivation) before zod
   * validation strips them. The handler still validates the wire
   * shape afterward; the gate doesn't replace input validation.
   *
   * Cloud wiring: BYOK + credit pre-check (insufficient_credit /
   * unsupported_provider). OSS leaves absent — no per-push billing.
   */
  readonly preValidationGate?: (
    ctx: HandlerContext,
    rawInput: unknown,
  ) => Promise<void> | void;

  /**
   * Post-success hook. Fires AFTER all stack item commits for this
   * push and AFTER the response object is assembled, but BEFORE the
   * handler returns. Receives a {@link PushPostSuccessArgs} bundle
   * with the resolved sessionId, stackItemId, contract, contractHash,
   * story echo, action classification, and codeReady — everything
   * cloud needs for fire-and-forget side-effects.
   *
   * Contract: the hook is awaited. If it throws, the handler
   * propagates — cloud's hook impl is responsible for swallowing its
   * own internal failures (RAG index write, render-cache placeholder
   * write) so a side-effect failure can never make a push fail.
   *
   * Cloud wiring: writes the `GguiRenderCache` placeholder + emits a
   * RAG embedding for next-push pool match. OSS leaves absent.
   */
  readonly postSuccessHook?: (
    args: PushPostSuccessArgs,
  ) => Promise<void> | void;

  /**
   * Pre-resolved generator escape hatch. When set, the handler uses
   * THIS function in place of the {@link GenerationDeps.uiGenerator} +
   * {@link GenerationDeps.resolveLlm} pipeline. The seam input
   * intentionally OMITS `llm` + `providerKey` — cloud's pod-side
   * generator resolves its own credentials from pod-side BYOK / pool
   * key state, so the handler skips `resolveLlm` entirely when this
   * seam is set.
   *
   * Shape parity with `UiGenerator['generate']` minus credentials:
   * `request` / `blueprints` / `contract` / `rendering` / `signal`
   * are all forwarded unchanged.
   *
   * When this seam is wired AND `generation` is also wired,
   * `generation.cache` / `generation.blueprints` still apply for the
   * blueprint matcher; only the cold-gen call routes through this
   * generator instead of `generation.uiGenerator`. `generation.resolveLlm`
   * is NOT called.
   *
   * OSS leaves absent and uses `generation.uiGenerator` + `resolveLlm`.
   */
  readonly generator?: (
    input: Omit<
      import('@ggui-ai/mcp-server-core').UiGenerateInput,
      'llm' | 'providerKey'
    >,
    ctx: HandlerContext,
  ) => Promise<import('@ggui-ai/mcp-server-core').UiGenerateResult>;

  /**
   * ID factory for fresh sessions. The handler mints a sessionId
   * upstream of `sessionStore.create` so the just-minted id flows
   * onto the response BEFORE any persistence side-effect runs.
   *
   * OSS default: `randomUUID()` (no prefix). Hosted impls that need
   * a typed prefix (e.g. `sess_<uuid>`) supply this dep so the prefix
   * convention propagates without forking the factory's id-minting
   * site. Called ONLY on the create path — `target.sessionId`
   * resolution + reuse skip this entirely.
   */
  readonly sessionIdFactory?: () => string;

  /**
   * ID factory for the per-push stack item. Mirrors
   * {@link sessionIdFactory}; OSS default is `randomUUID()`. Hosted
   * impls prefix as needed (e.g. `card_<uuid>`).
   */
  readonly stackItemIdFactory?: () => string;
}

/**
 * Live-subscriber notifier for stack pushes. The mcp-server's
 * `SessionChannelServer.notifyStackPush` implements this contract;
 * the handler depends on the narrowed shape so the handlers package
 * doesn't take a peer dep on the full session-channel surface.
 *
 * `matchType` is reserved for future cache/blueprint-match diagnostics
 * the client surfaces (see `GguiSession`'s `push` handler — it folds
 * `matchType` into a synthetic progress event). OSS today omits it.
 */
export interface ChannelNotifier {
  notifyStackPush(
    sessionId: string,
    stackItem: import('@ggui-ai/protocol').SessionStackEntry,
    matchType?: string,
  ): void;
}

/**
 * Input raw-shape.
 *
 * Single shape: `{ handshakeId, decision, props? }`.
 * `handshakeId` is REQUIRED — every push consumes a prior
 * `ggui_handshake` record. The handshake captures the intent +
 * blueprintDraft and produces the suggestion the push acts on.
 *
 * Decision branching:
 *   - `{kind: 'accept'}` — use the handshake's
 *     `suggestion.blueprintMeta` verbatim (reuses provisional id).
 *   - `{kind: 'override', blueprintDraft: {...}}` — mint a fresh
 *     blueprintId; gen against the agent's NEW draft.
 */
const inputSchema = {
  handshakeId: z
    .string({
      message:
        'ggui_push: handshakeId is REQUIRED. Call ggui_handshake({sessionId, intent, blueprintDraft}) first to negotiate, then push with {handshakeId, decision: {kind: \'accept\'}} (accept the suggestion) or {handshakeId, decision: {kind: \'override\', blueprintDraft: {...}}} (mint fresh against a new draft). Direct-push without a handshakeId is not supported.',
    })
    .min(1, 'ggui_push: handshakeId must be a non-empty string.'),
  /**
   * Runtime prop values for THIS render. Validated against the
   * effective contract's `propsSpec`. Validation failures throw
   * `ContractViolationError` (recoverable); the handshake remains
   * alive so the agent can fix-and-retry on the same handshakeId.
   */
  props: z.record(z.string(), z.unknown()).optional(),
  /**
   * Per-push theme override. When set, lands on the committed
   * stack item and takes priority over `Session.themeId` /
   * `App.defaultThemeId` at bootstrap-projection time. Use sparingly
   * — most pushes should inherit the session theme. Set this when a
   * single render needs a distinct look (urgent banner, hero
   * marketing card) without retheming the rest of the chat.
   */
  themeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Per-stack-item theme override. Wins over Session.themeId for THIS render. Omit to inherit the session theme.",
    ),
  /**
   * Typed `infra` envelope (added 2026-05-24). Today carries one
   * field (`model`); future expansion (temperature, max_tokens,
   * provider hints) lands here additively. `model` MUST be a
   * provider-prefixed id (`provider/model-name`); a bound generator
   * may also accept generator-specific prefixes for alternate
   * transports (consult the generator's docs).
   *
   * Strict — extra keys at `infra.*` are not silently dropped, so
   * a typo (`infra.modelId`) surfaces as a clear zod path instead of
   * a silent default-model fallback.
   */
  infra: z
    .object({
      model: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Provider-prefixed model id (e.g., `anthropic/claude-haiku-4-5`, `openai/gpt-5`). Generator-specific prefixes (e.g., `bedrock/...` for AWS Bedrock routing) supported when the bound generator handles them.",
        ),
    })
    .strict()
    .optional(),
  /**
   * Push decision discriminator.
   *
   *   - `{kind: 'accept'}` — use the handshake's
   *     `suggestion.blueprintMeta` verbatim. Reuses the provisional
   *     `blueprintId`. Code: cache delivery (origin === 'cache') or
   *     gen against the suggestion's stored effective contract
   *     (origin === 'agent' / 'synth').
   *   - `{kind: 'override', blueprintDraft: {...}}` — mint a fresh
   *     `blueprintId` and gen against the agent's NEW draft. The
   *     provisional id from the handshake is discarded.
   */
  decision: z.union([
    z.object({ kind: z.literal('accept') }).strict(),
    z
      .object({
        kind: z.literal('override'),
        blueprintDraft: z
          .object({
            // Symmetric with handshake's tightening — `dataContractSchema`
            // enforces the per-entry wrappers (PropEntry / ActionEntry
            // / StreamChannelEntry / ContextEntry) so a malformed
            // override draft surfaces a precise zod path
            // (`...contract.propsSpec.properties.todos.schema:
            // Required`) instead of the opaque
            // ContractSchemaMetaError at layer-B meta-validation.
            contract: dataContractSchema,
            variance: z
              .object({
                persona: z.string().optional(),
                aesthetic: z.string().optional(),
                context: z.record(z.string(), z.unknown()).optional(),
                seedPrompt: z.string().optional(),
              })
              .strict()
              .optional(),
            // Identifier string naming a server-registered generator
            // (e.g. "anthropic-claude-haiku-4-5"). NOT a place for
            // component source code — symmetric with the handshake
            // validation so the override path can't smuggle JSX
            // through here when the same misuse hits push instead
            // of handshake.
            generator: z
              .string()
              .max(120)
              .regex(/^[a-z0-9_:.-]+$/i, {
                message:
                  "generator must be a registered generator identifier (e.g. 'anthropic-claude-haiku-4-5'), not source code or free-form text",
              })
              .optional(),
          })
          .strict(),
      })
      .strict(),
  ]),
} as const;

/**
 * Output raw-shape — minimum LLM-actionable surface (2026-05-13).
 *
 * Pre-launch, no back-compat. Three fields, all load-bearing:
 *   - `stackItemId` — agent's handle for follow-up tool calls
 *     (ggui_consume, ggui_update).
 *   - `nextStep` — terse recovery hint (tool + args). Emitted only
 *     when the contract has actionSpec; pure-display pushes omit.
 *   - `action` — negotiator's decision (`create | reuse | update |
 *     replace | compose`). May inform the agent's follow-up prompt.
 *
 * Retired this slice (all redundant or unused):
 *   - `sessionId` / `handshakeId` — agent passed these IN; echoes.
 *   - `shortCode` — redundant with the now-deleted `url` tail.
 *   - `url` — post-R5 the `/r/` shortCode route was deleted; every
 *     host either mounts via `_meta.ui.resourceUri` or resolves
 *     `{sessionId, stackItemId}` via `session-resource/item/...`.
 *     Leaving the dead URL on the wire had models hallucinating
 *     links that resolve nowhere.
 *   - `codeReady` — server-side state; LLM doesn't branch on it.
 *   - `decision` — every field was duplicate (action), input echo
 *     (contract), post-hoc prose (reasoning), or internal cache
 *     key (blueprintId).
 *   - `contractHash` — internal cache key for SDKs that consume
 *     handshake records directly.
 *   - `cache` / `codeUrl` / `codeHash` — operational telemetry;
 *     belongs in `_meta`, not LLM-visible structuredContent.
 *   - `contract` (top-level) — duplicate of decision.contract.
 *   - `interaction` — legacy, never derived.
 *   - `nextStep.description` / `nextStep.example` — duplicate of
 *     the canonical tool description + redundant with `args`.
 */
const outputSchema = {
  stackItemId: z.string(),
  nextStep: z
    .object({
      tool: z.literal('ggui_consume'),
      args: z.object({ stackItemId: z.string() }),
    })
    .optional(),
  action: z.enum(['create', 'reuse', 'update', 'replace', 'compose']),
} as const;

/**
 * Internal handler-output type — carries the FULL field set that
 * downstream seams need (resultMeta, postSuccessHook, cloud
 * persistence, test assertions). The LLM-visible serialization is
 * the smaller `outputSchema` subset (`{stackItemId, nextStep?,
 * action}`); zod's `.parse()` strips the extras before they land on
 * `structuredContent`.
 *
 * In the future, when no consumer needs the extras anymore, this
 * type can collapse into the lean shape. Today the cloud pod's
 * `resultMeta` reads sessionId / contractHash, tests pin
 * codeReady / handshakeId / shortCode for behavior assertions
 * (NOT contract assertions on the LLM-visible surface), and the
 * postSuccessHook indexes by contractHash.
 */
type PushOutput = {
  // LLM-visible surface (matches outputSchema):
  stackItemId: string;
  nextStep?: {
    readonly tool: 'ggui_consume';
    readonly args: { readonly stackItemId: string };
  };
  action: 'create' | 'reuse' | 'update' | 'replace' | 'compose';
  // Internal seams (stripped from JSON-RPC envelope by outputSchema):
  sessionId: string;
  shortCode: string;
  codeReady: boolean;
  handshakeId?: string;
  contractHash?: string;
  codeUrl?: string;
  codeHash?: string;
};

/**
 * Cache-hit contract surfaced on `ggui_push` `structuredContent`. See
 * `outputSchema.cache` docstring and `./generation-cache.ts` for the
 * retrieval + record primitives.
 */
export interface PushCacheMarker {
  readonly hit: boolean;
  readonly similarity?: number;
  readonly cachedBlueprintId?: string;
  readonly llmCallsAvoided: number;
  /**
   * What kind of registry asset matched. `full-template`
   * is the only emitted value today — the registry stores opaque
   * component blobs. `composed` is reserved for the atomic-
   * decomposition follow-up. `cold` accompanies `hit: false`.
   */
  readonly kind?: 'full-template' | 'composed' | 'cold';
}

/**
 * 16-char URL-safe short-code — `[a-z0-9]` minus `1lI0Oo` confusables (31-char
 * alphabet). Entropy ≈ 16 × log₂(31) ≈ 79 bits, brute-force-resistant against
 * the "capability URL is the secret" model. Lowercase-only keeps URLs
 * case-insensitive (operators can hand-type without case mistakes).
 */
function generateShortCode(): string {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = randomBytes(16);
  let out = '';
  for (let i = 0; i < 16; i++) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * Build the OSS `ggui_push` handler wired against the given deps.
 *
 * The handler's tool declaration carries `_meta.ui.resourceUri` +
 * `_meta.ui.visibility: ['model']` per the §2.4.1 entry-point lock.
 */
export function createGguiPushHandler(
  deps: GguiPushHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, PushOutput> {
  return {
    name: 'ggui_push',
    title: 'Push',
    audience: ['agent'],
    description:
      // Description is structured as 6 short blocks instead of one
      // wall of prose. Agents skim — leading with the call shape +
      // prerequisite is what produces correct first calls.
      [
        // 1. Call shape — the literal JSON the agent must emit.
        'CALL SHAPE: ggui_push({handshakeId, decision, props?}). handshakeId comes from a prior ggui_handshake (REQUIRED). decision is one of {kind:\'accept\'} (use the handshake suggestion verbatim, reuses provisional blueprintId) OR {kind:\'override\', blueprintDraft:{contract, variance?, generator?}} (mint a fresh blueprintId against your NEW draft). props is REQUIRED when the effective contract declares propsSpec; values are validated against propsSpec at push time.',
        // 2. Prerequisite — handshake first, always.
        'PREREQUISITE: call ggui_handshake({sessionId, intent, blueprintDraft}) FIRST. The response carries handshakeId + suggestion (origin: cache | agent | synth) — push consumes it. Direct push without a handshakeId fails with handshake_not_found.',
        // 2b. Next step — driven by the response, not blanket-applied.
        'NEXT STEP: read the response. If it carries a `nextStep` field (only emitted when the contract had non-empty actionSpec), call that tool — it names ggui_consume({stackItemId}) and you must long-poll for the user\'s gesture before ending your turn. If the response has NO nextStep, the UI is pure-display (props only, no interactive buttons/forms) — you can end your turn; the user reads the UI and prompts you again when ready. After consume returns an event, the event\'s own `nextStep` (if any) tells you the tool to call next; otherwise loop back to handshake → push.',
        // 3. Recovery shape — what happens on validation failure.
        "RECOVERABLE FAILURES: cross_reference_unresolved / contract_schema_invalid / schema_mismatch_error / contract_violation (props) / missing_props all preserve the handshake — fix your input and retry on the SAME handshakeId. cross_reference_unresolved fires when an `actionSpec[name].nextStep` or `streamSpec[channel].source.tool` names a tool that's not declared in `agentCapabilities.tools` — every referenced tool MUST appear in agentCapabilities.tools (catalog discoverability; same-MCP and cross-MCP both go here). contract_schema_invalid fires when an inner JSON Schema is malformed (e.g. `propsSpec.properties.X.schema` missing `type`). schema_mismatch_error fires when an actionSpec entry's `schema` is not a subset of the named tool's registered inputSchema, OR a streamSpec channel's `schema` doesn't accept the tool's return shape — adjust the action/channel schema to match the tool, or omit `nextStep` if the agent will compose the call from a different toolset entirely. Only handshake_not_found forces a re-handshake.",
        // 4. Mutation rule — never re-push.
        'MUTATION: ggui_update mutates props on a delivered UI. NEVER re-push to mutate — re-pushing destroys scroll position, focus, and uncommitted input.',
        // 5. Wire surface — DataContract overview.
        "WIRE SURFACE (DataContract). PLACEMENT RULE for the two inbound specs: actionSpec carries DISCRETE EVENTS that drive the agent's next turn (submit, send, confirm, cancel, choose). contextSpec carries STATE the agent observes (draft text, slider value, current selection, in-progress list items). The single test: does this thing need the agent's next-turn reasoning? Yes → actionSpec. No → contextSpec. There is no third category — no `terminal` flag, no `consumeSpec`, no `interaction` mode. Specs (every entry is a WRAPPER that contains a JSON Schema in `schema:` — the JSON Schema does NOT sit flat at the entry level):  • propsSpec.properties[name].{schema, required?, default?} — initial render values, validated against propsSpec.  • actionSpec[name].{label, schema?, nextStep?, confirm?, icon?} — clicks. `nextStep` is an OPTIONAL string naming the agent's intended next tool call (e.g. nextStep:'todo_toggle'); the named tool MUST also be declared in `agentCapabilities.tools`. Omit nextStep for actions the agent composes freely from any toolset.  • contextSpec[slot].{schema, default?} — observable client state (counters, toggles, slider values). Use slot setter; NOT useAction.  • streamSpec[channel].{schema, mode?, replay?, source?} — live updates from agent to UI (outbound).  • agentCapabilities.tools[name].{description?, inputSchema?, outputSchema?} — declarative catalog of every MCP tool the contract references from actionSpec.nextStep or streamSpec.source.tool.",
        // 6. Hosting hint — what the result looks like.
        'HOSTING: on MCP Apps hosts (Claude.ai, Claude Desktop) mounts an iframe via ui://ggui/session and streams on the live channel; other hosts resolve `{sessionId, stackItemId}` from structuredContent and render via their own session-resource fetch.',
      ].join(' '),
    // No `allowedFor` — same toolset on every pod kind. The user-pod
    // posture (universal MCP for end-users) and the app-pod
    // (agent-builder) posture both expose push. Sessions are scoped by
    // the resolved identity (`ctx.appId` populated by the auth
    // adapter); end-user calls are billed against credits / BYOK in
    // the adapter+billing layer, not gated at registration.
    inputSchema,
    outputSchema,
    _meta: {
      // §2.4.1 entry-point lock: `_meta.ui.resourceUri` +
      // `_meta.ui.visibility` per the MCP Apps spec. Exactly one ggui
      // tool carries these; expanding this set without revisiting the
      // design lock is a boundary violation.
      ui: GGUI_PUSH_UI_META,
      // Legacy flat key per `@modelcontextprotocol/ext-apps/server`
      // `registerAppTool` normalization: hosts that read the legacy
      // shape need the URI at `_meta["ui/resourceUri"]` too. Always
      // stamped alongside `_meta.ui.resourceUri` for backward compat.
      'ui/resourceUri': GGUI_PUSH_UI_META.resourceUri,
    },
    async handler(input, ctx: HandlerContext): Promise<PushOutput> {
      // Push is handshake-first. The wire input is just
      // {handshakeId, contract? | contractHash?, props?}; the
      // generator input (intent, context, schema, adapters,
      // forceCreate) flows from the handshake record the agent
      // already wrote in the prior `ggui_handshake` round-trip.
      // Schema-required handshakeId carries an educational
      // `required_error` so a missing-handshakeId zod parse error
      // includes actionable recovery text inside the JSON-RPC -32602
      // envelope.

      // Pre-validation gate fires BEFORE input parsing so a cloud
      // deployment's billing checks (insufficient_credit /
      // unsupported_provider) can reject the push without spending
      // validation work. Errors propagate unchanged — the gate owns
      // the JSON-RPC envelope.
      if (deps.preValidationGate) {
        await deps.preValidationGate(ctx, input);
      }

      const parsed = z.object(inputSchema).parse(input);

      if (!deps.handshakeStore) {
        throw new Error(
          "ggui_push: requires the handler to be built with a `handshakeStore:` KeyValueStore dep — the same instance `createGguiHandshakeHandler` wrote to.",
        );
      }
      // Peek-first, consume-on-success. Recoverable validation errors
      // below (routing-target / schema-compat / props-validation) leave
      // the handshake alive so the agent can fix the input and retry on
      // the same handshakeId without re-handshaking. The atomic consume
      // happens once all input validation has passed and we're committed
      // to running the generation/cache flow.
      const handshakeRecord: HandshakeRecord | null =
        await peekHandshakeRecord(
          deps.handshakeStore,
          ctx.appId,
          parsed.handshakeId,
        );
      if (!handshakeRecord) {
        throw new HandshakeNotFoundError(parsed.handshakeId);
      }

      const storedInput = handshakeRecord.input;
      const decision = parsed.decision;

      // Decision branching:
      //
      //   - `kind: 'accept'`   — use the handshake's stored
      //     effectiveContract verbatim. Reuses the provisional
      //     blueprintId from `suggestion.blueprintMeta` (durable
      //     post-push).
      //   - `kind: 'override'` — agent supplies a fresh
      //     blueprintDraft; mint a new blueprintId and gen against
      //     that draft. The provisional id from the handshake is
      //     discarded (telemetry still threads via handshakeId).
      //
      // Effective contract feeds the rest of the handler exactly as
      // before — the decision branch only changes WHICH contract gets
      // installed and WHICH blueprintId we surface.
      let effectiveContract: DataContract;
      let effectiveVariance: BlueprintVariance | undefined;
      let acceptanceClassification: 'accept' | 'override';
      if (decision.kind === 'accept') {
        effectiveContract = handshakeRecord.effectiveContract;
        // Accept path — the negotiator's projected variance on the
        // suggestion is canonical (carries agent draft for origin=agent,
        // cached blueprint's tags for origin=cache, synth-amended tags
        // for origin=synth).
        effectiveVariance = handshakeRecord.suggestion.blueprintMeta.variance;
        acceptanceClassification = 'accept';
      } else {
        // Override path — gen against the agent's NEW draft contract +
        // its declared variance. Variance arrives as
        // `Record<string, unknown>` from the zod parse; coerce into
        // the canonical `BlueprintVariance` shape at the parse
        // boundary (json-safe by zod construction).
        effectiveContract = decision.blueprintDraft.contract as DataContract;
        effectiveVariance = normalizeOverrideVariance(
          decision.blueprintDraft.variance,
        );
        acceptanceClassification = 'override';
        // Semantic check on override-path generator name — shared with
        // handshake.ts's input gate so the two seams cannot drift.
        assertGeneratorRegistered(
          decision.blueprintDraft.generator,
          deps.defaultGenerator,
        );
      }

      // Telemetry: classification observable on every push so the
      // cache trace shows accept-vs-override patterns.
      emitCacheTraceEvent({
        id: newCacheTraceId(),
        at: Date.now(),
        durationMs: 0,
        scope: ctx.appId,
        intent: truncateCacheTraceIntent(storedInput.intent),
        expectedKey: handshakeRecord.suggestion.blueprintMeta.contractHash,
        threshold: 0,
        decision: 'push-classify',
        candidates: [],
        agentClassification:
          acceptanceClassification === 'accept' ? 'confirm' : 'override',
        reason:
          acceptanceClassification === 'accept'
            ? `push-classify: agent accepted handshake suggestion (origin=${handshakeRecord.suggestion.origin}, blueprintId=${handshakeRecord.suggestion.blueprintMeta.blueprintId})`
            : `push-classify: agent overrode handshake suggestion with a fresh draft`,
      });

      // Effective story for the rest of the handler. `variance` is
      // optional — absent on legacy paths that don't declare it. When
      // present, cold-gen surfaces its fields (persona, aesthetic,
      // context, seedPrompt) as a styling directive in the prompt.
      //
      // `story.contract` stays wire-shape on persistence (no
      // enrichment overlay). The resolved descriptor list lives
      // on a parallel `resolvedGadgetDescriptors` sidecar threaded
      // into `appGadgets` for the generator + persisted on the
      // StackItem as `gadgetDescriptors`. Downstream consumers
      // (boilerplate, CSP, code-gen prompt) read the sidecar.
      const story: {
        readonly intent: string;
        readonly contract: DataContract;
        readonly variance?: BlueprintVariance;
      } = {
        intent: storedInput.intent,
        contract: effectiveContract,
        ...(effectiveVariance !== undefined
          ? { variance: effectiveVariance }
          : {}),
      };

      // Resolved gadget catalog, lifted to handler scope. When
      // `appMetadataStore` is bound, the
      // registry-membership block below captures the catalog (App
      // record's `gadgets`, or `STDLIB_GADGETS` on
      // fallback). On cold-gen, this is threaded into the generator's
      // `UiGenerateInput.appGadgets` so the code-gen system prompt's
      // `clientCapabilities — registered catalog` section renders the
      // SAME catalog the synth + decision LLMs see. Stays `undefined`
      // when `appMetadataStore` is unset — the system prompt falls
      // through to its STDLIB default.
      let resolvedAppLibraries: readonly GadgetDescriptor[] | undefined;

      // Admission check. Fires BEFORE state changes — a rate-limited
      // caller should get 429 without the server doing any real work.
      if (deps.rateLimiter) {
        const decision = await deps.rateLimiter.check({
          key: `ggui_push:${ctx.appId}`,
          cost: 1,
        });
        if (!decision.allowed) {
          throw new RateLimitedError(`ggui_push:${ctx.appId}`, decision);
        }
      }

      // Layer-B meta-validation: every inner JSON Schema the agent
      // authored (propsSpec/actionSpec/streamSpec/contextSpec entry
      // schemas + agentCapabilities.tools[*].inputSchema /
      // outputSchema) MUST be a well-formed JSON Schema under Ajv
      // strict mode. Catches malformed-shape bugs at the author seam
      // rather than letting them surface as opaque "Validate failed"
      // errors on the first data flow. Same fail-fast posture as the
      // cross-ref + name-invariant checks below — author-recoverable.
      // Retired-field gate. The contract schema is `.passthrough()`
      // so unknown fields slip through silently; this hard-rejects
      // the known-retired names (`libraries`, `dispatch`,
      // `wiredTools`, `clientTools`, `broadcast`, `capabilities`)
      // BEFORE the structural validators run so the agent sees a
      // precise migration message.
      assertContractNoRetiredFields(story.contract);

      // Duplicate-gadget-hook gate. Two bindings with the same
      // (package, hook) double-mount the wrapper; promoted from soft
      // hygiene warning to hard reject so the violation is
      // observable rather than silently tolerated.
      assertNoDuplicateGadgetHooks(story.contract);

      assertContractSchemasValid(story.contract);

      // Cross-reference invariants — every `actionSpec[*].nextStep` and
      // `streamSpec[*].source.tool` MUST resolve to a key in the
      // contract's own `agentCapabilities.tools` catalog. Author-visible
      // error surface: dangling hints that name tools the author forgot to
      // declare in the catalog. Throws `CrossReferenceError` with
      // every dangling reference listed in one pass.
      assertCrossReferences(story.contract);

      // Gadget registry gate + enrichment. First: every
      // `(package, export name)` the contract references on
      // `clientCapabilities.gadgets` MUST resolve in `App.gadgets` by
      // the `(name, package)` identity — a miss throws a precise
      // reject: `GadgetNotRegisteredError` /
      // `GadgetPackageMismatchError`. Second: the referenced package
      // descriptors are snapshotted onto
      // `SessionStackEntry.gadgetDescriptors` so the persisted
      // StackItem carries full teaching text + bundleUrl + styleUrl +
      // connect[]. No-op when `appMetadataStore` is unset.
      if (deps.appMetadataStore) {
        const appRecord = await deps.appMetadataStore.get(ctx.appId);
        // Symmetric with the handshake handler and list-gadgets:
        // when the appMetadataStore is bound but the App record either
        // doesn't exist or doesn't carry gadgets, fall back to
        // the STDLIB_GADGETS seed. Without this fallback the
        // gate would skip on every default-configured server (no app
        // pre-registered, get() returns null) and a hallucinated
        // hook would commit alongside legitimate STDLIB hooks.
        const appGadgets = appRecord?.gadgets ?? STDLIB_GADGETS;
        assertGadgetsRegistered(story.contract, appGadgets);
        // Also verify every declared wrapper's `requires`
        // is satisfied by `App.publicEnv`. Runs alongside (not
        // inside) the registry-membership check: the registry gate
        // verifies the hook NAME is registered; this gate verifies
        // the hook's required env keys are configured. Both fire
        // before contract enrichment + state mutation.
        assertPublicEnvSatisfied(
          story.contract,
          appGadgets,
          appRecord?.publicEnv,
        );
        // Instead of enriching the contract in-place, capture the
        // descriptor subset referenced by the wire's
        // `(hook, package, version)` tuples. The wire stays the wire;
        // resolution metadata lands on the StackItem's
        // `gadgetDescriptors` sidecar (see persistence below) +
        // threads into the generator via `appGadgets`.
        resolvedAppLibraries = filterDescriptorsToContract(
          story.contract,
          appGadgets,
        );
      }

      // Name-invariant rules: no name collisions across actionSpec /
      // streamSpec / contextSpec keys (boilerplate-identifier collision)
      // and no `_ggui:` reserved-prefix keys on actionSpec / contextSpec
      // (streamSpec reserved-prefix rejection is in
      // `validateContractStructure`). Same posture as the cross-ref
      // check above — both surface author-recoverable failures before
      // any state mutation.
      assertNameInvariants(story.contract);

      // Protocol-level schema-compat invariant: validates
      // actionSpec[*].schema ⊆ agentCapabilities.tools[nextStep].inputSchema
      // and streamSpec[*].schema ⊇ agentCapabilities.tools[source.tool].outputSchema
      // against the contract's OWN catalog. Author-visible bug:
      // "your action.schema doesn't fit the inputSchema you declared
      // on the tool entry." Different scope from the server-level
      // schema-compat check (`deps.checkStackItemContracts` below),
      // which compares against the runtime tool registry's zod
      // schemas.
      assertSchemaCompat(story.contract);

      // Schema-compat validation against the AUTHORED contract.
      // Every `actionSpec[name].dispatch.tool`
      // (when `kind === 'tool'`) must declare a `schema` that's a
      // subset of the named tool's registered `inputSchema`; every
      // `streamSpec[channel].tool` must declare a `schema` that's a
      // superset of the tool's return schema. Mismatches throw
      // `SchemaCompatError` (`schema_mismatch_error`); the handshake
      // record is preserved so the agent can retry on the same
      // handshakeId after fixing the contract. This is the SAME class
      // of failure as `CrossReferenceError` (author-recoverable
      // contract error) and follows the same posture — surface to
      // the agent at push-time, not buried in a silent error stack
      // item committed during gen.
      //
      // Defensive backstops at gen and cache-hit commit phases (see
      // `runGenerationIntoSession` + `commitCachedStackItem`) cover
      // contracts that differ from `story.contract` (synth-emit,
      // matched-blueprint reuse).
      if (deps.checkStackItemContracts && story.contract) {
        // Forward `agentCapabilities` alongside the spec fields so the
        // server-side schema-compat check can recognize cross-MCP
        // tools (declared by the agent in the contract's own catalog
        // but not registered in this server's tool registry). Pre-fix
        // this dropped the catalog, so cross-MCP nextStep always
        // tripped the `tool-not-found` finding even when the agent
        // had properly declared the tool.
        deps.checkStackItemContracts({
          ...(story.contract.actionSpec
            ? { actionSpec: story.contract.actionSpec }
            : {}),
          ...(story.contract.streamSpec
            ? { streamSpec: story.contract.streamSpec }
            : {}),
          ...(story.contract.agentCapabilities
            ? { agentCapabilities: story.contract.agentCapabilities }
            : {}),
        });
      }

      // Props validation against the agreed contract's propsSpec.
      // Strict policy: if the contract declares `propsSpec`, every
      // push MUST pass props that satisfy it (including required
      // fields). If the contract has NO propsSpec but props are
      // supplied anyway, that's a contract drift — reject with a
      // hint to refine the contract. Both throw a recoverable
      // ContractViolationError so the agent can fix-and-retry on the
      // same handshakeId without re-handshaking.
      const runtimeProps = parsed.props;
      if (effectiveContract.propsSpec) {
        const propsToValidate = (runtimeProps ?? {}) as Record<string, unknown>;
        const propsValidation = validatePropsData(
          propsToValidate,
          effectiveContract.propsSpec,
        );
        if (!propsValidation.valid) {
          throw new ContractViolationError({
            tool: 'ggui_push',
            violations: propsValidation.violations,
            hint: 'Fix the props to satisfy the agreed propsSpec, or send a refined `contract` to override the agreed shape. The handshake record is preserved across this validation error — retry on the SAME handshakeId after fixing the input; no need to re-handshake.',
          });
        }
      } else if (
        runtimeProps !== undefined &&
        Object.keys(runtimeProps).length > 0
      ) {
        throw new ContractViolationError({
          tool: 'ggui_push',
          violations: [
            {
              field: 'props',
              message:
                'props supplied but the agreed contract declares no propsSpec. Either refine the contract to declare a propsSpec covering these fields, or omit `props`.',
              expected: 'no props (contract has no propsSpec)',
              received: `props with keys: ${Object.keys(runtimeProps).join(', ')}`,
            },
          ],
          hint: 'Send a refined `contract` whose `props` declares a propsSpec for these fields, or drop the `props` field. The handshake record is preserved across this validation error — retry on the SAME handshakeId after fixing the input; no need to re-handshake.',
        });
      }

      // Atomically consume the handshake record now that input
      // validation has succeeded. Up to this point the record was
      // peeked, not consumed — so the recoverable errors above
      // (routing-target / schema-compat / props-validation) left it
      // alive for retry. A null return here means a concurrent push
      // won the race or the record expired during validation; both
      // surface as `HandshakeNotFoundError`, which is the right
      // degraded signal — the agent can re-handshake to recover.
      const consumed = await consumeHandshakeRecord(
        deps.handshakeStore,
        ctx.appId,
        parsed.handshakeId,
      );
      if (!consumed) {
        throw new HandshakeNotFoundError(parsed.handshakeId);
      }

      // Resolve or create the session. SessionStore.create is idempotent
      // when given a deterministic id (see InMemorySessionStore).
      const requestedId = handshakeRecord.target.sessionId;
      let sessionId: string;
      let action: PushOutput['action'];

      if (requestedId) {
        const existing = await deps.sessionStore.get(requestedId);
        if (existing) {
          sessionId = existing.id;
          action = 'reuse';
        } else {
          const created = await deps.sessionStore.create({
            id: requestedId,
            appId: ctx.appId,
          });
          sessionId = created.id;
          action = 'create';
        }
      } else {
        const created = await deps.sessionStore.create({
          id: deps.sessionIdFactory ? deps.sessionIdFactory() : randomUUID(),
          appId: ctx.appId,
        });
        sessionId = created.id;
        action = 'create';
      }

      // Devtools payload trace. No-op when no sink is registered.
      emitPayloadTraceEvent({
        direction: 'inbound-push',
        sessionId,
        appId: ctx.appId,
        tool: 'ggui_push',
        payload: { handshakeId: parsed.handshakeId, story },
      });

      const stackItemId: string = deps.stackItemIdFactory
        ? deps.stackItemIdFactory()
        : randomUUID();

      // Emit push_started so the canvas animator transitions to its
      // `constructing` state immediately, without waiting for cold-
      // gen to settle. Fire-and-forget.
      deps.canvasLifecycle?.emit(sessionId, {
        kind: 'push_started',
        stackItemId,
        intent: story.intent,
      });

      // Open the stackItem-keyed pending-events pipe (Model C). This
      // MUST happen before any iframe-side dispatch could fire — the
      // user can click before the agent's first `ggui_consume`, and
      // `ggui_runtime_submit_action` needs an open pipe to append to.
      // Idempotent: re-mark on the same stackItemId is a no-op.
      if (deps.pendingEventConsumer) {
        try {
          deps.pendingEventConsumer.markCreated?.(stackItemId);
        } catch {
          // Pipe open failures are non-fatal — `ui/message` fallback
          // on the host still routes gestures on the next chat turn.
        }
      }

      const shortCode = generateShortCode();

      // Record shortCode → session binding for same-origin console
      // viewer lookups. Best-effort: an index write rejection does NOT
      // fail the push (the agent already holds the URL). Awaited here
      // to keep the single-process in-memory store consistent — the
      // cost is sub-millisecond in practice. Swap for a durable index
      // later if ordering matters across replicas.
      if (deps.shortCodeIndex) {
        try {
          await deps.shortCodeIndex.put(shortCode, {
            sessionId,
            appId: ctx.appId,
            // Pass the just-minted stack item id so hosted impls
            // recording the rich row don't need a follow-up session
            // read (the placeholder stack item is written after the
            // put call below, so `sessionStore.get` wouldn't observe
            // it yet). OSS in-memory ignores; cloud DDB consumes.
            stackItemId,
          });
        } catch {
          // Silent: the index is a convenience layer. If it rejects
          // (bounded-store eviction, backend hiccup), the next
          // console viewer request 404s on that shortCode, which
          // is the correct degraded behavior.
        }
      }

      // Provisional preview kickoff. Runs ONLY when the handler was
      // built with `provisionalPreview` deps AND the gate passes.
      //
      // Preview runs CONCURRENTLY with generation below: it is
      // kicked off here (fire-and-forget), then the generation
      // `await` blocks the push RPC. Viewer sees preview frames
      // stream over `_ggui:preview` while the generator call is in
      // flight; on success/failure we tear down preview via
      // `finalizeProvisionalPreview` and the authoritative stack
      // item is the final state.
      const previewGate = evaluateProvisionalPreviewGate(
        deps.provisionalPreview,
        {
          story,
          isMcpAppsPush: false,
        },
        { appId: ctx.appId, sessionId },
      );
      if (previewGate.kind === 'skip') {
        deps.provisionalPreview?.onOutcome?.({
          status: 'skipped',
          reason: previewGate.reason,
          sessionId,
          appId: ctx.appId,
        });
      } else if (deps.provisionalPreview) {
        const handle = kickoffProvisionalPreview(deps.provisionalPreview, {
          sessionId,
          stackItemId,
          appId: ctx.appId,
          story,
        });
        // Register into the optional handoff registry so a later
        // handler (generation success below, apply-stack-item-patch
        // setting componentCode, session teardown, shutdown) can
        // cancel by `stackItemId`. Absent registry → the preamble still
        // runs; it just has no external cancellation site.
        deps.provisionalPreview.registry?.register(stackItemId, handle);

        // Placeholder stack-item — drives the provisional preview
        // path. The iframe-runtime mounts `mountProvisional`
        // PER-STACK-ITEM (see
        // `packages/iframe-runtime/src/stack-item-renderer.ts::detectKind`
        // — empty `componentCode` routes to the provisional branch).
        // Without an item on the stack, `_ggui:preview` frames the
        // emitter just kicked off would paint into the void.
        //
        // Lifecycle: this placeholder lives until generation settles.
        // `appendStackItem` is upsert-by-id (see SessionStore JSDoc),
        // so when the cold-generation success / cache-hit / generation-
        // failed paths below call `appendStackItem(sessionId, item)`
        // with the SAME `stackItemId`, the placeholder is replaced
        // in-place — no double-append, no stale entry. When generation
        // is NOT wired (no provider key), the placeholder stays for
        // the session's lifetime; that's the honest "we have no code
        // yet but the preview surface is mounted" state.
        //
        // We bypass the schema-compat hook here because the
        // placeholder declares no contract; the hook fires when
        // generation later commits the real item. Live-subscriber
        // notify DOES fire so a viewer that connects mid-push sees
        // the placeholder show up — without the notify the renderer
        // wouldn't know to mount a per-item surface for it.
        const placeholder: StackItem = {
          id: stackItemId,
          type: 'component',
          componentCode: '',
          prompt: story.intent,
          contentType: 'application/javascript+react',
          createdAt: new Date().toISOString(),
        };
        try {
          await deps.sessionStore.appendStackItem(sessionId, placeholder);
        } catch {
          // Defensive — a placeholder-append failure is not fatal to
          // the push. The session + shortCode are already minted; the
          // worst case is the live renderer paints nothing for this
          // session, which is the same "preview never wired" degraded
          // state callers without `provisionalPreview` already see.
        }
        safelyNotifyStackPush(deps.channelNotifier, sessionId, placeholder);
      }

      // Generation + cache gate. Absent generation deps = placeholder
      // mode: story pushes return `codeReady: false`. The placeholder
      // stack-item appended just above (when provisionalPreview was
      // wired) keeps the live-renderer's per-item provisional surface
      // mounted; generation-off doesn't paint anything onto it but
      // also doesn't leave the renderer with no anchor. When
      // generation IS wired:
      //
      //   - If `generation.cache` is also wired, attempt a retrieval
      //     first. A hit synthesizes a StackItem from the cached
      //     componentCode (skip LLM entirely) and surfaces
      //     `cache.hit:true` on the push output.
      //   - On a miss (or cache absent), run the generator as before.
      //     On success, when cache is wired, record the produced
      //     componentCode into the scope so the next same-intent
      //     push hits.
      //
      // Both branches converge on emitting the `cache` marker when
      // cache deps are present, giving the agent a visible signal of
      // cache behavior per the contract lock.
      let generatedCodeReady = false;
      // Note: cacheMarker was used for the structuredContent.cache
      // field; that field was retired in the 2026-05-13 lean-schema
      // slice. The variable is preserved (assigned but unread) as
      // a seam for future telemetry surfaces; eslint-prefix it _
      // so we don't fail the no-unused-vars check.
      let _cacheMarker: PushCacheMarker | undefined;

      // Probe-card short-circuit. Intent prefix `[ggui:probe]` triggers
      // the MCP Apps protocol probe diagnostic system card — a 4-button
      // tester for `ui/message`, `ui/update-model-context`,
      // `ui/open-link`, `ui/request-display-mode`. Bypasses generation
      // entirely (no LLM credentials needed) so the probe is
      // exercisable on a fresh server. The card lives in
      // `packages/iframe-runtime/src/system-cards/ProtocolProbeCard.tsx`
      // and is mapped via `SYSTEM_CARD_REGISTRY['mcp-apps-probe']`.
      const PROBE_INTENT_PREFIX = '[ggui:probe]';
      if (story.intent.startsWith(PROBE_INTENT_PREFIX)) {
        const probeItem: SessionStackEntry = {
          id: stackItemId,
          type: 'system',
          kind: 'mcp-apps-probe',
          createdAt: new Date().toISOString(),
          props: { intent: story.intent },
        };
        try {
          await deps.sessionStore.appendStackItem(sessionId, probeItem);
          safelyNotifyStackPush(deps.channelNotifier, sessionId, probeItem);
          generatedCodeReady = true;
        } catch {
          // Append failure leaves codeReady=false; downstream synth
          // emits an empty bootstrap which the runtime renders as the
          // generic system-card fallback.
        }
        await safelyFinalizePreview(deps.provisionalPreview, stackItemId, 'probe');
      } else if (deps.generation) {
        const intent = story.intent;
        const forceCreate = storedInput.forceCreate === true;

        // Blueprint matcher when cache is wired. The exact-key
        // strategy (canonical-key equality) and the semantic strategy
        // (RAG + LLM judge) short-circuit generation entirely; a
        // `no-match*` outcome falls through to cold-gen and registers
        // the produced blueprint. Bypass the matcher entirely when
        // `forceCreate` is set — agent has explicitly opted out after
        // a declined handshake.
        let blueprintHit: {
          readonly id: string;
          readonly contractKey: string;
          readonly componentCode: string;
          readonly cosine: number;
          readonly contract: DataContract;
        } | null = null;

        if (deps.generation.cache && !forceCreate) {
          const llm = deps.generation.resolveLlmCaller
            ? await deps.generation.resolveLlmCaller(ctx)
            : null;
          const matchDeps: Parameters<typeof matchBlueprint>[0] = {
            registry: {
              embedding: deps.generation.cache.embedding,
              vectorStore: deps.generation.cache.vectorStore,
            },
            ...(llm ? { llm } : {}),
            ...(deps.generation.installedBlueprints
              ? { installedBlueprints: deps.generation.installedBlueprints }
              : {}),
          };
          const matchResult = await matchBlueprint(matchDeps, ctx.appId, {
            intent,
            contract: story.contract,
          });
          if (
            matchResult.strategy === 'exact-key' ||
            matchResult.strategy === 'semantic'
          ) {
            blueprintHit = {
              id: matchResult.blueprint.id,
              contractKey: matchResult.blueprint.contractKey,
              componentCode: matchResult.blueprint.componentCode,
              cosine: matchResult.cosine,
              // Carry the matched blueprint's full DataContract so the
              // cache-hit commit path projects the four-spec wire
              // surface (contextSpec / actionSpec / streamSpec /
              // props) onto the new StackItem. Without this, runtime
              // crashes at `useGguiContext("...")` because the iframe
              // never receives bootstrap.contextSlots — the cached
              // componentCode references context slots that nobody
              // told the runtime to register.
              contract: matchResult.blueprint.contract,
            };
          }
        }

        if (blueprintHit) {
          generatedCodeReady = await commitCachedStackItem(
            deps.sessionStore,
            deps.provisionalPreview,
            deps.channelNotifier,
            deps.checkStackItemContracts,
            {
              sessionId,
              stackItemId,
              story,
              cacheHit: {
                cachedBlueprintId: blueprintHit.id,
                similarity: blueprintHit.cosine,
                componentCode: blueprintHit.componentCode,
                cachedIntent: intent,
                cachedAt: new Date().toISOString(),
                // Project the matched blueprint's contract onto the
                // cache hit so commitCachedStackItem lands the four
                // wire-surface specs on the new StackItem. Symmetric
                // with runGenerationIntoSession's StackItem build:
                // both paths emit the same shape, and bootstrap-meta
                // derivation reads from one place. DataContract.props
                // maps to StackItem.propsSpec by convention; the
                // other three names align directly.
                ...(blueprintHit.contract.actionSpec
                  ? { actionSpec: blueprintHit.contract.actionSpec }
                  : {}),
                ...(blueprintHit.contract.streamSpec
                  ? { streamSpec: blueprintHit.contract.streamSpec }
                  : {}),
                ...(blueprintHit.contract.propsSpec
                  ? { propsSpec: blueprintHit.contract.propsSpec }
                  : {}),
                ...(blueprintHit.contract.contextSpec
                  ? { contextSpec: blueprintHit.contract.contextSpec }
                  : {}),
                // Project clientCapabilities through the
                // blueprint-hit path so the cached commit emits
                // Permissions-Policy directives whenever the matched
                // blueprint's contract declared them. Symmetric with
                // cold-gen + cache-hit.
                ...(blueprintHit.contract.clientCapabilities
                  ? {
                      clientCapabilities:
                        blueprintHit.contract.clientCapabilities,
                    }
                  : {}),
              },
              ...(runtimeProps !== undefined
                ? { runtimeProps: runtimeProps as JsonObject }
                : {}),
              ...(resolvedAppLibraries !== undefined
                ? { appGadgets: resolvedAppLibraries }
                : {}),
            },
          );
          _cacheMarker = {
            hit: true,
            similarity: blueprintHit.cosine,
            cachedBlueprintId: blueprintHit.id,
            llmCallsAvoided: 1,
            kind: 'full-template',
          };
        } else {
          // The `.d.ts` fetch is deferred to HERE — the cold-gen
          // branch — not done eagerly after the registry gate. On a
          // blueprint cache hit the fetched types
          // would be discarded (cache-hit commits don't typecheck or
          // build a prompt), and a network transient in the fetch
          // would wrongly fail a push that had a valid cache hit. Only
          // cold generation consumes `gadgetTypes`, so only cold
          // generation pays the fetch.
          const resolvedGadgetTypes =
            resolvedAppLibraries !== undefined
              ? await fetchGadgetTypes(resolvedAppLibraries)
              : undefined;
          const outcome = await runGenerationIntoSession(
            deps.generation,
            deps.sessionStore,
            deps.provisionalPreview,
            deps.channelNotifier,
            deps.checkStackItemContracts,
            deps.generator,
            {
              ctx,
              sessionId,
              stackItemId,
              story,
              ...(runtimeProps !== undefined
                ? { runtimeProps: runtimeProps as JsonObject }
                : {}),
              ...(resolvedAppLibraries !== undefined
                ? { appGadgets: resolvedAppLibraries }
                : {}),
              ...(resolvedGadgetTypes !== undefined
                ? { gadgetTypes: resolvedGadgetTypes }
                : {}),
              // MP.5 (2026-05-24): typed `infra.model` flows from
              // the agent's wire input through the parsed schema
              // into the generator. Cloud's seam reads
              // `generateInput.infra?.model` to populate
              // `RunGenerationArgs.model`; the OSS generator path
              // ignores it (resolveLlm picks the model).
              ...(parsed.infra !== undefined ? { infra: parsed.infra } : {}),
            },
          );
          generatedCodeReady = outcome.ok;
          if (deps.generation.cache) {
            _cacheMarker = {
              hit: false,
              llmCallsAvoided: 0,
              kind: 'cold',
            };
            // Register the produced blueprint into the registry so
            // future calls can hit Tier 1 (exact contract match) or
            // Tier 2 (semantic neighbour).
            if (outcome.ok && outcome.componentCode) {
              await safelyRegisterBlueprint(
                {
                  embedding: deps.generation.cache.embedding,
                  vectorStore: deps.generation.cache.vectorStore,
                },
                ctx.appId,
                {
                  kind: 'template',
                  contract: story.contract,
                  intent,
                  componentCode: outcome.componentCode,
                  provenance: 'synth',
                },
              );
            }
          }
        }
      }

      // Content-addressable code delivery. When `codeStore`
      // + `codeBaseUrl` are wired AND the just-appended stack item has
      // non-empty `componentCode`, write (hash, code) to the store and
      // surface `codeUrl` + `codeHash` on the response.
      //
      // The lookup re-reads the session because the stack item was
      // appended several branches above (cache-hit, fresh generation,
      // MCP Apps inbound) — re-reading is simpler than threading a
      // reference through every branch and matches resultMeta's own
      // pattern. Failures are silent: on a put error or a missing
      // top-of-stack we fall through with no codeUrl. Without codeUrl,
      // the iframe falls back to live-mode (wsUrl+token) — the stack
      // item is delivered via the live-channel WS subscribe.
      let codeUrl: string | undefined;
      let codeHash: string | undefined;
      if (deps.codeStore && deps.codeBaseUrl) {
        try {
          const session = await deps.sessionStore.get(sessionId);
          const top = session?.stack[session.currentStackIndex];
          if (
            top
            && top.type !== 'mcpApps'
            && top.type !== 'system'
            && typeof top.componentCode === 'string'
            && top.componentCode.length > 0
          ) {
            const hash = deps.codeStore.hashOf(top.componentCode);
            await deps.codeStore.put(hash, top.componentCode);
            codeHash = hash;
            // Trim trailing slash so the join is `<base>/code/<hash>.js`
            // regardless of whether the caller passed `https://x/` or
            // `https://x` for codeBaseUrl.
            const base = deps.codeBaseUrl.replace(/\/$/, '');
            codeUrl = `${base}/code/${hash}.js`;
          }
        } catch {
          // Silent — codeStore failure falls back to inline-base64 path.
        }
      }

      // Per-push theme overlay. The commit paths above
      // (cold-gen / cache-hit / probe / placeholder) construct the
      // stack item from their own templates; none of them know about
      // the agent's `parsed.themeId` input. Rather than thread
      // themeId through every constructor, we read the just-committed
      // top item once + re-upsert with `themeId` set when the agent
      // requested a per-push override. `appendStackItem` is
      // upsert-by-id so this collapses to a single row update; the
      // bootstrap-projection block in `resultMeta` then reads the
      // overlaid value via the same lookup path that drives
      // `deriveStackItemMeta`.
      //
      // Failure here downgrades to "no per-push theme override" (the
      // session.themeId / app default / process default still apply
      // via the layered resolution chain). Better than failing the
      // whole push for a cosmetic overlay. Catch is non-empty —
      // surfacing via console.warn rather than `deps.logger` because
      // this handler doesn't have one bound today; the
      // `ggui_push.theme_overlay_failed` code is greppable so
      // operators can correlate without a stable observability seam.
      if (parsed.themeId !== undefined) {
        try {
          const session = await deps.sessionStore.get(sessionId);
          const top = session?.stack[session.currentStackIndex];
          if (top && top.id === stackItemId && top.type !== 'mcpApps' && top.type !== 'system') {
            await deps.sessionStore.appendStackItem(sessionId, {
              ...top,
              themeId: parsed.themeId,
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console -- one-shot warn, no logger dep on push handler today
          console.warn(
            '[ggui_push.theme_overlay_failed]',
            err instanceof Error ? err.message : String(err),
          );
        }
      }

      // Canonical-key of the resolved contract. Surface on output so
      // downstream consumers (resultMeta builder, cache trace,
      // resource URI minter) read from a single computed value
      // instead of recomputing against the same canonicalization.
      // This is the same hash the handshake returned as
      // `contractHash`.
      const resolvedContractHash = blueprintKey(effectiveContract);

      // Conditional `nextStep` — emit a consume-recovery hint ONLY when
      // the resolved contract has a non-empty `actionSpec`. Pure-display
      // pushes (props only) get no `nextStep` because there's nothing
      // for the agent to consume. Closes the recovery-hint chain
      // started by `new_session.nextStep` (→ handshake) and
      // `handshake.nextStep` (→ push).
      const hasActions =
        effectiveContract.actionSpec !== undefined &&
        Object.keys(effectiveContract.actionSpec).length > 0;
      const nextStep = hasActions
        ? {
            tool: 'ggui_consume' as const,
            args: { stackItemId },
          }
        : undefined;

      // Push response architecture (2026-05-13):
      //   - `outputSchema` defines the LLM-visible subset (4 fields).
      //   - This `result` carries the FULL set — extras are stripped
      //     by zod's `.parse()` (z.object default behavior) before
      //     the JSON-RPC `structuredContent` is built.
      //   - Internal seams (resultMeta, postSuccessHook, tests) read
      //     from this rich in-memory object.
      const result: PushOutput = {
        stackItemId,
        action,
        sessionId,
        shortCode,
        codeReady: generatedCodeReady,
        handshakeId: handshakeRecord.handshakeId,
        contractHash: resolvedContractHash,
        ...(codeUrl ? { codeUrl, codeHash } : {}),
        ...(nextStep ? { nextStep } : {}),
      };

      // Post-success hook for fire-and-forget side-effects (RAG
      // indexing, render-cache placeholder write).
      // Awaited — the hook impl is responsible for swallowing internal
      // failures so a side-effect rejection can never fail a push that
      // already committed its stack item.
      if (deps.postSuccessHook) {
        await deps.postSuccessHook({
          ctx,
          sessionId,
          stackItemId,
          contract: effectiveContract,
          contractHash: resolvedContractHash,
          intent: story.intent,
          action,
          codeReady: generatedCodeReady,
        });
      }

      return result;
    },
    resultMeta: async (output, _input, ctx) => {
      // Resource URI is the rehydrate handle — chat hosts persist this
      // and re-fetch on history reload. Include the blueprint's
      // canonical key alongside the sessionId so the resource handler
      // can run session + blueprint lookups in parallel (no data
      // dependency between them) AND fall back to a registry-only
      // render when the session has been evicted but the blueprint is
      // still cached. Legacy single-segment URIs
      // (`ui://ggui/session/<sessionId>`) emitted before this slice
      // continue to work via the fallback handler registration in
      // `registerGguiSessionResourceTemplate`.
      const blueprintSegment = output.contractHash
        ? `/${output.contractHash}`
        : '';
      const perCallResourceUri = `${GGUI_PUSH_UI_META.resourceUri}/${output.sessionId}${blueprintSegment}`;
      const perCallUiMeta = { resourceUri: perCallResourceUri };

      // Look up the just-appended stack item to embed renderable wire
      // shape on the `ai.ggui/stack-item` slice meta. Hosts whose iframe
      // sandbox CSP blocks `connect-src` to our origin (claude.ai's
      // `claudemcpcontent.com` wrapper) cannot fetch the per-session
      // resource — but they DO forward the full `_meta` over postMessage,
      // so the inline-mount path needs the renderable in the meta itself.
      //
      // Stack-item-derived fields (componentCode | kind, propsJson,
      // actionNextSteps, contextSlots) come from the
      // {@link deriveStackItemMeta} projection — same single
      // source of truth the public-render `/r/<shortCode>` route
      // composes its inline shell from. Encoding `componentCode` to
      // base64 happens here at the meta-emission boundary; the View
      // itself stays raw so transports own their wire encoding.
      let view: StackItemMetaView = {};
      // Public env projection requires App.publicEnv, which lives on
      // the App record (not the stack item). Re-read here in
      // resultMeta rather than threading via closure: the
      // appMetadataStore lookup is O(1) (an in-memory map or a
      // single-key datastore read) and the symmetric re-read pattern
      // is simpler than refactoring
      // the handler/resultMeta state contract. Stays undefined when
      // appMetadataStore is unbound (registry seam not wired).
      let bootstrapPublicEnv:
        | Readonly<Record<string, string>>
        | undefined;
      // Per-render theme resolution sources, populated from the same
      // session+stackItem lookup that drives the projection. Chain
      // ordering happens below alongside `liveTheme` / `deps.themeId`.
      let stackItemThemeId: string | undefined;
      let sessionThemeId: string | undefined;
      // When the session is in canvas mode AND
      // the canvas iframe has completed its ui/initialize handshake
      // (canvasLoaded === true), the canvas is already mounted and
      // subscribed to the live channel — the push's stack item landed as a
      // `push` envelope on the existing subscription. The tool
      // result MUST NOT stamp a new ui.resourceUri (would cause the
      // host to mount a second iframe per push, defeating the canvas
      // model). Captured here from the same sessionStore.get() that
      // powers the view/theme lookup to avoid a second read.
      let canvasOwnsRender = false;
      // `lastSequence` — monotonic SessionEvent ledger cursor stamped on
      // every emit (R6). Polling clients use it to initialize the /events
      // cursor (R7) aligned with the WS stream.
      let lastSequence: number | undefined;
      try {
        const session = await deps.sessionStore?.get(output.sessionId);
        const top = session?.stack[session.currentStackIndex];
        if (session) {
          sessionThemeId = session.themeId;
          lastSequence = session.eventSequence;
          if (session.mcpAppsMode === 'canvas' && session.canvasLoaded === true) {
            canvasOwnsRender = true;
          }
        }
        if (top) {
          view = deriveStackItemMeta(top);
          // Project the App's publicEnv down to the union of declared
          // wrappers' `requires`. The push gate has already verified
          // every required key is satisfied, so this projection's
          // only filter is dropping App.publicEnv keys no wrapper
          // asked for (minimum-disclosure).
          if (deps.appMetadataStore) {
            const appRecord = await deps.appMetadataStore.get(ctx.appId);
            bootstrapPublicEnv = derivePublicEnvProjection(
              top,
              appRecord?.publicEnv,
            );
          }
          // Per-stack-item theme override — only on the `component`
          // variant. McpAppsStackItem / SystemStackItem don't carry
          // user-facing themes (they render via host-supplied or
          // built-in renderers).
          if (top.type !== 'mcpApps' && top.type !== 'system') {
            stackItemThemeId = top.themeId;
          }
        }
      } catch {
        // Silent — bootstrap stays minimal if the lookup fails.
      }
      const runtimeUrlRaw =
        typeof deps.runtimeUrl === 'function'
          ? deps.runtimeUrl()
          : deps.runtimeUrl;
      const runtimeUrl = runtimeUrlRaw ?? '/_ggui/iframe-runtime.js';

      // `mintWsToken` owns wsUrl + wsToken + expiresAt when wired. The
      // minter's own return shape names the credential `token` (legacy);
      // we rename to `wsToken` here so the session slice matches the
      // wire field name. When absent we still emit a minimal
      // `ai.ggui/session` slice carrying sessionId + appId + runtimeUrl
      // + the renderable variant on the `ai.ggui/stack-item` slice so
      // postMessage-mount paths work without a WS-token minter.
      const mintedTrio = deps.mintWsToken
        ? deps.mintWsToken(output.sessionId, ctx.appId)
        : undefined;
      const partial: Partial<
        Pick<McpAppAiGguiSessionMeta, 'wsUrl' | 'wsToken' | 'expiresAt'>
      > = mintedTrio
        ? {
            wsUrl: mintedTrio.wsUrl,
            wsToken: mintedTrio.token,
            expiresAt: mintedTrio.expiresAt,
          }
        : {};
      // Surface the content-addressable code URL + hash on the
      // `ai.ggui/stack-item` slice. The output object already carries
      // these (the handler body wrote to codeStore + composed the URL
      // before returning), so we just forward — no second lookup, no
      // second store write. `codeUrl` is the sole static-component
      // delivery channel post-2026-05-13; the inline base64
      // `componentCode` channel retired in T3-1.
      const outputWithCode = output as typeof output & {
        codeUrl?: string;
        codeHash?: string;
      };
      // Layered theme resolution at slice-meta-projection time. Order
      // is operator-debug-wins: `liveTheme` exists ONLY when an
      // operator just picked a theme via the dev console picker, so
      // it's their "show me what THIS looks like" intent — that has
      // to beat agent-stored state, otherwise the picker is silently
      // outranked the moment any session has a theme and the picker
      // stops doing anything visible.
      //   1. liveTheme?.id    — process-shared live cell from the
      //      console-theme POST. Survives across new_session calls in
      //      the same process; resets on restart unless persisted to
      //      ggui.json. Top priority because it's a runtime debug
      //      surface; ThemeMode resolution below already does this.
      //   2. stackItemThemeId — per-push override the agent set on
      //      `ggui_push.themeId` (rare; mostly omitted).
      //   3. sessionThemeId   — chat-scoped default the agent set on
      //      `ggui_new_session.themeId` (or inherited from
      //      App.defaultThemeId via the new_session handler's resolution).
      //   4. deps.themeId     — static boot-time fallback for embedders
      //      that don't wire a themeProvider.
      // First non-undefined wins.
      const liveTheme = deps.themeProvider?.();
      const resolvedThemeId =
        liveTheme?.id
        ?? stackItemThemeId
        ?? sessionThemeId
        ?? deps.themeId;
      const resolvedThemeMode = liveTheme?.mode ?? deps.themeMode;
      // Surface the names of same-server app-visible tools so the
      // iframe-runtime can choose Pattern α (direct tools/call) over
      // Pattern β (3-message bridge) per wired action. Spread only
      // when non-empty so bootstrap envelopes without a provider
      // wired stay byte-identical.
      const appCallableTools = deps.appCallableTools?.() ?? [];
      // Mirror `serverCapabilities.streamWebSocketLocalTools` onto
      // the bootstrap. Spread only when the resolver returns
      // SOMETHING — undefined means "no WS-subscribe support", which
      // is distinct from "supported but empty allowlist" (`[]`). The
      // latter still surfaces so the iframe-runtime can branch
      // "transport-aware client knows server is configured" vs
      // "fall through to iframe poll for everything".
      const streamWebSocketLocalTools = deps.streamWebSocketLocalTools?.();

      // Content-addressable contract bundle. When the stack item
      // declares a runtime-validated schema AND the server has a
      // CodeStore wired, compile + write the bundle + emit the URL.
      // The iframe-runtime fetches the URL and dynamic-imports to
      // resolve validators (Cache-Control:immutable means repeat
      // pushes with the same contract hit the browser cache without
      // a round-trip). Absent → no client-side validators shipped;
      // server-side `assertActionContract` remains authoritative.
      //
      // Symmetric pattern with the `/code/<hash>.js` componentCode
      // route above — same store, same idempotent put, same charset
      // gate, different URL prefix.
      let contractHash: string | undefined;
      let validatorsUrl: string | undefined;
      if (deps.codeStore && deps.codeBaseUrl) {
        try {
          const session = await deps.sessionStore.get(output.sessionId);
          const top = session?.stack[session.currentStackIndex];
          if (top) {
            const bundle = await deriveContractBundle(top);
            if (bundle) {
              await deps.codeStore.put(bundle.contractHash, bundle.bundleSource);
              contractHash = bundle.contractHash;
              const base = deps.codeBaseUrl.replace(/\/$/, '');
              validatorsUrl = `${base}/contract/${bundle.contractHash}.js`;
            }
          }
        } catch {
          // Silent — contract-bundle write failure degrades to no
          // client-side validators (server-side gate is authoritative).
        }
      }

      // Build the two slices directly (#109 / R3). Session-slice
      // carries identity + live-auth + capability advertisements
      // (cached per session by hosts); stack-item slice carries the
      // active item's render state + contract pointer + component-mode
      // discriminator (replaced per push). `partial` is the
      // `mintWsToken` output (wsUrl + token + expiresAt) — all
      // session-slice fields.
      const session: McpAppAiGguiSessionMeta = {
        sessionId: output.sessionId,
        appId: ctx.appId,
        runtimeUrl,
        ...partial,
        ...(appCallableTools.length > 0 ? { appCallableTools } : {}),
        ...(streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools }
          : {}),
        // Operator-registered wrappers ride the session slice to the
        // iframe so the runtime can dynamic-import each before the
        // first stack item renders. Projected by
        // `deriveStackItemMeta` from the (enriched) stack-
        // item contract; only emitted when wrappers are actually
        // declared so pure-STDLIB apps stay byte-identical.
        ...(view.gadgets !== undefined && view.gadgets.length > 0
          ? { gadgets: view.gadgets }
          : {}),
        // Minimum-disclosure subset of App.publicEnv (union of
        // declared wrappers' `requires`). Filtered above by
        // `derivePublicEnvProjection`; only emitted when non-empty
        // so apps without wrapper-required env stay byte-identical.
        ...(bootstrapPublicEnv !== undefined &&
        Object.keys(bootstrapPublicEnv).length > 0
          ? { publicEnv: bootstrapPublicEnv }
          : {}),
        ...(resolvedThemeId !== undefined
          ? { themeId: resolvedThemeId }
          : {}),
        ...(resolvedThemeMode !== undefined
          ? { themeMode: resolvedThemeMode }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
      };
      // stackItemId is load-bearing: the iframe-runtime threads it
      // into `dispatchWiredAction.stackItemId` on every useAction
      // call. When absent, submit_action returns PIPE_NOT_FOUND
      // (post 2026-05-13 fail-loud fix) and the iframe falls through
      // to `ui/message` — the gesture reaches the chat surface but
      // the agent's open ggui_consume long-poll never drains the
      // event. Every other slice-meta transport already projects this
      // field via `deriveStackItemMeta`; push.resultMeta was
      // the last drift point.
      const stackItem: McpAppAiGguiStackItemMeta = {
        ...(output.stackItemId !== undefined
          ? { stackItemId: output.stackItemId }
          : {}),
        ...(view.actionNextSteps !== undefined
          ? { actionNextSteps: view.actionNextSteps }
          : {}),
        ...(view.contextSlots !== undefined
          ? { contextSlots: [...view.contextSlots] }
          : {}),
        // Content-addressable contract validators (see content-bundle
        // compute above). Both fields present together or absent
        // together — iframe-runtime treats absence as "no validators".
        ...(contractHash !== undefined && validatorsUrl !== undefined
          ? { contractHash, validatorsUrl }
          : {}),
        ...(view.kind ? { kind: view.kind } : {}),
        ...(view.propsJson ? { propsJson: view.propsJson } : {}),
        ...(outputWithCode.codeUrl
          ? { codeUrl: outputWithCode.codeUrl }
          : {}),
        ...(outputWithCode.codeHash
          ? { codeHash: outputWithCode.codeHash }
          : {}),
      };
      // Canvas-mode + loaded path: the canvas
      // iframe already exists, is subscribed to the live channel, and owns
      // rendering for every push in this session. Return `undefined`
      // to omit `_meta` entirely:
      //
      //   - ui.resourceUri stamp would cause the host to mount a
      //     second iframe per push, defeating the canvas model.
      //   - the stack-item slice carries this push's `stackItemId`, which
      //     if forwarded via postMessage to the canvas iframe would
      //     poison its parser into single-item mode and break the
      //     session-wide subscription.
      //
      // The stack item still flows over the live channel via the existing
      // `push` envelope (server-side appendStackItem path emits it
      // unconditionally), so the canvas iframe gets the new item
      // through the live subscription rather than the tool result.
      if (canvasOwnsRender) {
        return undefined;
      }

      // Emit the two per-window `_meta` keys (#109). Hosts that
      // forward `_meta` to views may cache the `session` slice for the
      // session's lifetime; render-only deltas can emit just
      // `stack-item`. The contract pointer is content-addressable —
      // same hash on repeat pushes ⇒ browser HTTP cache returns the
      // validators without a round-trip.
      const ggui: McpAppAiGguiMeta = {
        session,
        ...(Object.keys(stackItem).length > 0 ? { stackItem } : {}),
      };
      const meta: Record<string, unknown> = {
        ...toMcpAppEnvelope(ggui),
        ui: perCallUiMeta,
        // Legacy flat key for hosts that read the unnested form.
        'ui/resourceUri': perCallResourceUri,
      };
      return meta;
    },
  };
}

/**
 * Invoke the bound {@link UiGenerator} for a story-path push and
 * append the resulting {@link StackItem} to the session. Returns
 * `true` when real componentCode landed on the stack;
 * `false` when no credentials were resolved, the generator
 * rejected, or the generator returned an error result.
 *
 * Side-effects:
 *
 *   - Success: `sessionStore.appendStackItem(sessionId, item)` with
 *     the generator's componentCode + sourceCode + stackItemId as the
 *     stack-item id. Preview (if registered) is cancelled with
 *     reason `'handoff'` — the authoritative stack item supersedes
 *     the provisional frames.
 *   - Failure: `sessionStore.appendStackItem(sessionId, errorItem)`
 *     with `componentCode: ''` and a populated `error` field so the
 *     agent can read the failure reason via the session channel.
 *     Preview (if registered) is cancelled with reason
 *     `'generation-failed'`.
 *   - `await`s throughout — the push RPC blocks until generation
 *     settles. This is intentional: a synchronous `codeReady:true`
 *     is the honest user-visible signal for "ggui_push returned and
 *     the component is ready". Clients that want progress read the
 *     provisional preview channel.
 *
 * Never throws. Every failure path funnels through an error stack
 * item + preview teardown so the caller doesn't have to install a
 * rejection handler. Secondary failures (stack append rejecting,
 * preview cancel throwing) are swallowed — keeping the session
 * channel + transport intact matters more than re-raising.
 */
/**
 * Result shape for {@link runGenerationIntoSession}. `componentCode`
 * is populated only on the happy path — the push handler uses it to
 * write the cache entry when `generation.cache` is wired. Failure
 * paths carry `ok:false` and no componentCode; the caller treats
 * that as "skip the cache record" without a second error shape.
 */
interface GenerationRunOutcome {
  readonly ok: boolean;
  readonly componentCode?: string;
  readonly createdAt: string;
}

async function runGenerationIntoSession(
  generation: GenerationDeps,
  sessionStore: SessionStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  checkStackItemContracts:
    | ((shape: {
        readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
        readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
      }) => void)
    | undefined,
  generatorOverride: GguiPushHandlerDeps['generator'] | undefined,
  args: {
    readonly ctx: HandlerContext;
    readonly sessionId: string;
    readonly stackItemId: string;
    readonly story: {
      readonly intent: string;
      readonly context?: unknown;
      // Agent-authored contract forwarded from the parsed input.
      // Typed `DataContract` end-to-end via `dataContractSchema` —
      // no cast, no splice. `intent` is not a contract field;
      // internal consumers (prompt rendering, contract hash,
      // negotiator decision, cache scope) read the outer
      // `story.intent` instead.
      readonly contract?: DataContract;
      /**
       * Variance signals forwarded from the agent's BlueprintDraft
       * (`persona`, `aesthetic`, `context`, `seedPrompt`). Threaded
       * through to the generator's prompt builder so cold-gen produces
       * a component aligned with the requested persona/aesthetic.
       * Absent → generator runs the default styling pass. Cache-hit
       * commits never reach this seam — variance there flows via the
       * stored Blueprint's own `variance` field.
       */
      readonly variance?: BlueprintVariance;
    };
    /** Runtime prop values for THIS render. Validated against
     *  `story.contract.props` (propsSpec) by the upstream caller
     *  before this function runs. */
    readonly runtimeProps?: JsonObject;
    /**
     * Operator-registered gadget catalog resolved by the
     * push handler from the bound `AppMetadataStore` (plugin slice
     * 1.2.1 follow-up). Threaded into `UiGenerateInput.appGadgets`
     * so the code-gen system prompt's `clientCapabilities —
     * registered catalog` section renders the operator's plugins
     * (Leaflet, Mapbox, …) instead of falling back to STDLIB.
     * Undefined when `appMetadataStore` is unset on `deps`.
     */
    readonly appGadgets?: readonly GadgetDescriptor[];
    /**
     * `package → .d.ts content` for the contract's non-stdlib
     * gadgets, parallel-fetched by the push handler.
     * Threaded into `UiGenerateInput.gadgetTypes` so the code-gen
     * sandbox loads each wrapper's real declaration into its VFS.
     */
    readonly gadgetTypes?: Readonly<Record<string, string>>;
    /**
     * MP.5 (2026-05-24) — typed `infra.model` override from the
     * agent's wire input. Threaded onto `generateInputBase.infra`
     * so the generator override (cloud pod) can pick the model up
     * without re-parsing raw input. OSS path ignores it
     * (`resolveLlm` already chose the model).
     */
    readonly infra?: { readonly model?: string };
  },
): Promise<GenerationRunOutcome> {
  const { ctx, sessionId, stackItemId, story } = args;
  const nowIso = new Date().toISOString();

  // Credential-free input shape — both the override path and the
  // OSS path build their generator input on top of this.
  const generateInputBase: Omit<UiGenerateInput, 'llm' | 'providerKey'> = {
    request: {
      sessionId,
      prompt: story.intent,
      ...(isJsonObject(story.context) ? { context: story.context } : {}),
    },
    blueprints: generation.blueprints,
    // Agent-authored contract ride from `story.contract` (parsed
    // input on direct path, forwarded from
    // HandshakeStoredInput.contract on the handshake-paired path)
    // into the generator. Typed `DataContract` end-to-end via
    // `dataContractSchema`. `story.intent` is the canonical
    // intent for the generator's prompt. create-ui-generator echoes
    // the contract back on `result.response.contract`, which the
    // StackItem persistence block projects onto the committed item
    // — so slice-meta-derivation's deriveContextSlots /
    // deriveWiredActionTools pick them up on /r/<id> + on the
    // `ai.ggui/stack-item` slice meta.
    ...(story.contract !== undefined
      ? { contract: story.contract }
      : {}),
    // Variance signals (persona / aesthetic / context / seedPrompt)
    // ride into the generator's prompt builder so cold-gen aligns
    // the produced component with the agent's declared variant. The
    // generator decides whether to surface a "Variance" block — empty
    // BlueprintVariance objects are no-ops.
    ...(story.variance !== undefined ? { variance: story.variance } : {}),
    // Gadget catalog flows to the code-gen system prompt via
    // dispatch's `appGadgets`
    // capture. Same catalog the push-time gate validated against;
    // keeps the three triad surfaces (synth, decision, code-gen) in
    // sync about which plugins exist.
    ...(args.appGadgets !== undefined
      ? { appGadgets: args.appGadgets }
      : {}),
    // Gadget `.d.ts` content for the sandbox VFS overlay.
    ...(args.gadgetTypes !== undefined
      ? { gadgetTypes: args.gadgetTypes }
      : {}),
    // MP.5 (2026-05-24) — typed infra envelope. Today carries one
    // field (`model`); cloud's generator override pulls
    // `infra.model` into `RunGenerationArgs.model` for the pool
    // route dispatcher. OSS path ignores it.
    ...(args.infra !== undefined ? { infra: args.infra } : {}),
  };

  let result: Awaited<ReturnType<UiGenerator['generate']>>;

  if (generatorOverride) {
    // Cloud seam: a cloud deployment's server-side generator
    // resolves its own credentials (bring-your-own-key or pool key)
    // inside the runner — skip `resolveLlm` entirely and call the
    // override with the credential-free input shape.
    try {
      result = await generatorOverride(generateInputBase, ctx);
    } catch (err) {
      return commitErrorStackItem(sessionStore, previewDeps, channelNotifier, {
        sessionId,
        stackItemId,
        story,
        nowIso,
        message:
          err instanceof Error
            ? `generator threw: ${err.message}`
            : 'generator threw',
        reason: 'generator-threw',
      });
    }
  } else {
    // OSS path: resolve credentials then call generation.uiGenerator.
    // A `null` result is the "no BYOK" case — we treat it structurally
    // the same as a provider-side `no-credentials` failure so the
    // agent sees one consistent shape. `resolveLlm` never throws per
    // its contract; defensive catch to preserve that if an
    // implementation slips.
    let creds: GenerationCredentials | null;
    try {
      creds = await generation.resolveLlm(ctx);
    } catch (err) {
      return commitErrorStackItem(sessionStore, previewDeps, channelNotifier, {
        sessionId,
        stackItemId,
        story,
        nowIso,
        message:
          err instanceof Error
            ? `credential resolution failed: ${err.message}`
            : 'credential resolution failed',
        reason: 'credential-resolution-failed',
      });
    }
    if (!creds) {
      // Operator-supplied no-credentials fallback (typically a
      // Connect-Claude card pointing at `/settings`). Only fires when
      // the generator dep was bound with `onNoCredentials` AND the
      // hook returns a non-null stack item; everything else (no
      // hook, hook throws, hook returns null) falls through to the
      // legacy error envelope so historical behavior is preserved
      // for callers that don't opt in.
      if (generation.onNoCredentials) {
        let fallbackItem: SessionStackEntry | null = null;
        try {
          fallbackItem = await generation.onNoCredentials(ctx, {
            intent: story.intent,
            stackItemId,
            nowIso,
          });
        } catch {
          // Hook bug shouldn't break the push — fall through to the
          // canonical error path below.
          fallbackItem = null;
        }
        if (fallbackItem) {
          return commitNoCredentialsCardItem(
            sessionStore,
            previewDeps,
            channelNotifier,
            {
              sessionId,
              stackItemId,
              nowIso,
              stackItem: fallbackItem,
            },
          );
        }
      }
      return commitErrorStackItem(sessionStore, previewDeps, channelNotifier, {
        sessionId,
        stackItemId,
        story,
        nowIso,
        message:
          'no credentials available for the configured generation provider (expected env var or ~/.ggui/credentials.json entry)',
        reason: 'no-credentials',
      });
    }

    // Run the generator. `UiGenerator.generate` never throws per its
    // contract — failures funnel through the discriminated result —
    // but we still catch defensively so a buggy implementation can't
    // crash the server.
    try {
      result = await generation.uiGenerator.generate({
        ...generateInputBase,
        llm: creds.selection,
        providerKey: creds.providerKey,
      });
    } catch (err) {
      return commitErrorStackItem(sessionStore, previewDeps, channelNotifier, {
        sessionId,
        stackItemId,
        story,
        nowIso,
        message:
          err instanceof Error
            ? `generator threw: ${err.message}`
            : 'generator threw',
        reason: 'generator-threw',
      });
    }
  }

  if (!result.ok) {
    return commitErrorStackItem(sessionStore, previewDeps, channelNotifier, {
      sessionId,
      stackItemId,
      story,
      nowIso,
      message: result.error.message,
      reason: 'generation-failed',
    });
  }

  // Happy path — append the authoritative stack item. `StackItem`
  // carries `componentCode` plus optional contract fields
  // (`actionSpec`, `streamSpec`, `propsSpec`) when the generator
  // resolved them. Contracts flow through from the generator's
  // `UIGenerationResponse.contract` envelope — either the caller's
  // authored contract passed through as-is, or a minimal one
  // synthesized from the generated code's wire call sites. Closes
  // the failure mode where LLM-emitted wire calls land without a
  // declared actionSpec/streamSpec surface.
  //
  // Warnings surface as the item's `description` so renderers can
  // display them without shape changes.
  const responseContracts = result.response.contract;
  const item: StackItem = {
    id: stackItemId,
    type: 'component',
    componentCode: result.response.componentCode,
    prompt: story.intent,
    contentType: 'application/javascript+react',
    createdAt: nowIso,
    ...(result.response.warnings && result.response.warnings.length > 0
      ? { description: result.response.warnings[0] }
      : {}),
    ...(args.runtimeProps !== undefined
      ? { props: args.runtimeProps }
      : {}),
    ...(responseContracts?.actionSpec
      ? { actionSpec: responseContracts.actionSpec }
      : {}),
    ...(responseContracts?.streamSpec
      ? { streamSpec: responseContracts.streamSpec }
      : {}),
    ...(responseContracts?.propsSpec
      ? { propsSpec: responseContracts.propsSpec }
      : {}),
    // Project `contextSpec` onto the committed StackItem so the
    // bootstrap-meta derivation block in `resultMeta` can read
    // `top.contextSpec` and emit `bootstrap.contextSlots`. Without
    // this, the LLM-authored contextSpec slots silently fail to
    // reach the iframe runtime.
    ...(responseContracts?.contextSpec
      ? { contextSpec: responseContracts.contextSpec }
      : {}),
    // Project `agentCapabilities` onto the committed StackItem so the
    // schema-compat defensive backstop (`checkStackItemContracts`
    // below) can recognize cross-MCP tools — tools the agent
    // declared in the
    // contract catalog but doesn't expect to live on this server.
    // Without this projection the post-gen schema-compat check trips
    // on any nextStep targeting an external MCP server, even though
    // the agent properly declared the tool.
    ...(responseContracts?.agentCapabilities
      ? { agentCapabilities: responseContracts.agentCapabilities }
      : {}),
    // Project `clientCapabilities` onto the committed StackItem so
    // `derivePermissionsPolicy` can union the declared
    // `entry.permission` values into a Permissions-Policy directive
    // set. The public-render `/r/<shortCode>` route reads this
    // projection to set the iframe's HTTP-level `Permissions-Policy`
    // header before the content loads; the bootstrap inline carries
    // `permissionsPolicy` for in-renderer inspection. Without this
    // projection the renderer has no signal about which
    // browser-capability gates the contract requests.
    ...(responseContracts?.clientCapabilities
      ? { clientCapabilities: responseContracts.clientCapabilities }
      : {}),
    // Descriptor sidecar. The wire's
    // `(hook, package, version)` tuples resolved against
    // `App.gadgets` at push-validation time; persisted here so
    // `derivePermissionsPolicy` + `deriveBundleOrigins` +
    // `deriveGadgetRegistrations` + `derivePublicEnvProjection` read
    // descriptor metadata without re-resolving against the registry.
    ...(args.appGadgets !== undefined && args.appGadgets.length > 0
      ? { gadgetDescriptors: args.appGadgets }
      : {}),
  };
  // Schema-compat check (DEFENSIVE backstop). Authored contracts are
  // validated at push-validation phase BEFORE gen runs (see push
  // handler body); this site catches drift between `story.contract`
  // and the generator's `result.response.contract`. Synth paths
  // today never emit an `actionSpec[*].nextStep` tool ref, so the
  // check is a no-op on the synthesis path. When the generator
  // preserves authored tool refs verbatim the early check already
  // rejected; this site is structural insurance against future
  // synth paths that emit tool refs.
  //
  // Thrown SchemaCompatError propagates up to the push handler →
  // structured error response → agent retries on same handshakeId.
  // Without this check the site would silently commit an error stack
  // item (surfacing as "stuck on Generating UI..."). Preview cleanup
  // runs in the catch arm so a thrown error doesn't leak a running
  // preview into the next push.
  if (checkStackItemContracts) {
    try {
      checkStackItemContracts(item);
    } catch (err) {
      await safelyFinalizePreview(
        previewDeps,
        stackItemId,
        'schema-mismatch',
      );
      throw err;
    }
  }
  try {
    await sessionStore.appendStackItem(sessionId, item);
  } catch {
    // If the stack append fails, we still clean up preview — the
    // session is in a degraded state but the channel shouldn't
    // leak a running preview.
    await safelyFinalizePreview(previewDeps, stackItemId, 'stack-append-failed');
    return { ok: false, createdAt: nowIso };
  }
  // Live-subscriber notify. Cold-generation success — the entry
  // reuses an existing stackItemId, so already-subscribed clients should
  // see the new componentCode flip the matching `data-ggui-code-
  // ready` slot from `false` to `true`. No `matchType` — this is a
  // generated entry, not a cache hit.
  safelyNotifyStackPush(channelNotifier, sessionId, item);
  await safelyFinalizePreview(previewDeps, stackItemId, 'handoff');
  return {
    ok: true,
    componentCode: result.response.componentCode,
    createdAt: nowIso,
  };
}

/**
 * Append a hand-authored "no-credentials" card stack item, fan out
 * the stack-push notify, and tear down provisional preview with the
 * canonical `'no-credentials'` reason. Returns `ok: true` so the
 * push handler reports `codeReady: true` and emits the card's
 * `kind` on the `ai.ggui/stack-item.kind` slice field — the iframe
 * renderer mounts the registered system card. (T3-1 retired the
 * inline `componentCode` channel; system cards use the `kind`
 * discriminator.)
 *
 * Pageid contract: the caller's `stackItem.id` MUST equal `stackItemId`
 * (the in-flight stack-item id) so `appendStackItem` replaces the
 * provisional placeholder in place. This helper rebinds it
 * defensively to keep the contract local — a hook that returns a
 * StackItem with a different id still lands at the active page.
 */
async function commitNoCredentialsCardItem(
  sessionStore: SessionStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  args: {
    readonly sessionId: string;
    readonly stackItemId: string;
    readonly nowIso: string;
    readonly stackItem: SessionStackEntry;
  },
): Promise<GenerationRunOutcome> {
  const item = { ...args.stackItem, id: args.stackItemId } as SessionStackEntry;
  let appended = false;
  try {
    await sessionStore.appendStackItem(args.sessionId, item);
    appended = true;
  } catch {
    // Stack append rejected — preview teardown is the only honest
    // recovery; the session is otherwise unchanged.
  }
  if (appended) {
    safelyNotifyStackPush(channelNotifier, args.sessionId, item);
  }
  await safelyFinalizePreview(previewDeps, args.stackItemId, 'no-credentials');
  // System cards have no `componentCode` — surface an empty string so
  // the outcome shape stays uniform; downstream observers don't read
  // it for the fallback path.
  const code =
    item.type !== 'mcpApps' && item.type !== 'system'
      ? item.componentCode
      : '';
  return appended
    ? { ok: true, componentCode: code, createdAt: args.nowIso }
    : { ok: false, createdAt: args.nowIso };
}

/**
 * Source-type field on `StackItem` is too narrow for an "error, no
 * code" payload, so we synthesize a `componentCode: ''` record with
 * the `error` slot populated. Renderers already handle
 * `componentCode === ''` by showing a fallback UI; the extra `error`
 * field carries the operator-facing reason.
 */
async function commitErrorStackItem(
  sessionStore: SessionStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  args: {
    readonly sessionId: string;
    readonly stackItemId: string;
    readonly story: { readonly intent: string };
    readonly nowIso: string;
    readonly message: string;
    readonly reason: string;
  },
): Promise<GenerationRunOutcome> {
  const errorItem: StackItem = {
    id: args.stackItemId,
    type: 'component',
    componentCode: '',
    prompt: args.story.intent,
    error: args.message,
    contentType: 'application/javascript+react',
    createdAt: args.nowIso,
  };
  let appended = false;
  try {
    await sessionStore.appendStackItem(args.sessionId, errorItem);
    appended = true;
  } catch {
    // Secondary failure — session store rejected the error record.
    // Nothing meaningful to do; preserve session channel integrity
    // by still finalizing preview below.
  }
  if (appended) {
    // Even error-only stack entries fan out — the console viewer
    // renders an error panel for them, so a live subscriber needs the
    // delta to flip out of the "Waiting for session channel replay…"
    // state. (B1: stack mutations on already-subscribed sessions
    // were previously invisible to the live client.)
    safelyNotifyStackPush(channelNotifier, args.sessionId, errorItem);
  }
  await safelyFinalizePreview(previewDeps, args.stackItemId, args.reason);
  return { ok: false, createdAt: args.nowIso };
}

/**
 * Best-effort fire of {@link ChannelNotifier.notifyStackPush}. Wrapped
 * so a notifier impl that throws can't fail an already-committed
 * append. Returns `void` because the notify is observably-fire-and-
 * forget — the source of truth for the entry is the SessionStore,
 * which already accepted the write before we got here.
 *
 * Absent notifier → no-op. That's the "host without a live session
 * channel (programmatic embedding, hosted Lambda one-shot)" case;
 * those hosts read state via subscribe-time snapshot, not deltas.
 */
function safelyNotifyStackPush(
  notifier: ChannelNotifier | undefined,
  sessionId: string,
  stackItem: import('@ggui-ai/protocol').SessionStackEntry,
  matchType?: string,
): void {
  if (!notifier) return;
  try {
    notifier.notifyStackPush(sessionId, stackItem, matchType);
  } catch {
    // Swallow — same posture as `safelyFinalizePreview`. A notify
    // failure is observability, not correctness.
  }
}

/**
 * Wrap {@link finalizeProvisionalPreview} so callers don't have to
 * null-check the deps or catch. Absent deps → no-op. Absent
 * registry → no-op (the preview path doesn't have an external
 * cancellation site). Any rejection from `registry.cancel` is
 * swallowed — preview teardown is best-effort during a push
 * settlement.
 */
async function safelyFinalizePreview(
  previewDeps: ProvisionalPreviewDeps | undefined,
  stackItemId: string,
  reason: string,
): Promise<void> {
  const registry = previewDeps?.registry;
  if (!registry) return;
  try {
    await finalizeProvisionalPreview(registry, stackItemId, reason);
  } catch {
    // Swallow. The runner's own terminal outcome already fired; a
    // second-order cancel rejection isn't worth propagating.
  }
}

/**
 * Narrow-only passthrough guards so we can forward
 * `story.context` + `story.schema` into `UIGenerationRequest`
 * without losing type safety. The zod schema on `story` is
 * `.passthrough()` so both fields arrive as `unknown`; we accept
 * the minimum structural shape the generator contract requires.
 */
function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Append a cache-hit {@link StackItem} to the session. Mirrors the
 * happy-path branch of {@link runGenerationIntoSession}, minus the
 * generator call + the cache-record write (the entry is already in
 * the store — that's why we hit). Returns `true` when the append
 * succeeded and `false` on a session-store rejection (treated the
 * same as a generation append failure: no crash, preview torn
 * down, push returns `codeReady: false` so the agent observes the
 * degraded state through the channel instead of a synthetic "ready"
 * signal).
 */
async function commitCachedStackItem(
  sessionStore: SessionStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  checkStackItemContracts:
    | ((shape: {
        readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
        readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
      }) => void)
    | undefined,
  args: {
    readonly sessionId: string;
    readonly stackItemId: string;
    readonly story: { readonly intent: string };
    readonly cacheHit: GenerationCacheHit;
    /** Runtime prop values for THIS render. Validated against the
     *  resolved contract's propsSpec by the caller before this
     *  function runs. */
    readonly runtimeProps?: JsonObject;
    /**
     * Resolved descriptor subset (filtered from `App.gadgets` to
     * those referenced by the contract's wire-side
     * `(hook, package, version)` tuples). Persisted on the StackItem
     * as `gadgetDescriptors` so the bootstrap-meta derivation reads
     * descriptor metadata without re-resolving.
     */
    readonly appGadgets?: readonly GadgetDescriptor[];
  },
): Promise<boolean> {
  const nowIso = new Date().toISOString();
  // `intent` lifecycle drop point — authoring-side `DataContract.intent`
  // (required on the file-format side) folds into `StackItem.prompt` at
  // the wire boundary. There is NO `StackItem.intent` field; consumers
  // that want the originating intent read `prompt`. The field rename is
  // the drop signal. See the `DataContract.intent` docstring in
  // `@ggui-ai/protocol` for the full lifecycle contract.
  // Cached path — project optional contract fields onto the
  // StackItem so the bootstrap-meta derivation in `resultMeta` reads
  // them off the active stack item. {@link GenerationCacheHit}
  // carries optional contract fields so when the cache store evolves
  // to persist them, the projection surface stays correct without
  // re-touching this site.
  // Symmetric with the cold-generation path in
  // `runGenerationIntoSession` so contract flow uniformly across
  // both commit paths.
  const item: StackItem = {
    id: args.stackItemId,
    type: 'component',
    componentCode: args.cacheHit.componentCode,
    prompt: args.story.intent,
    contentType: 'application/javascript+react',
    createdAt: nowIso,
    ...(args.runtimeProps !== undefined
      ? { props: args.runtimeProps }
      : {}),
    ...(args.cacheHit.actionSpec
      ? { actionSpec: args.cacheHit.actionSpec }
      : {}),
    ...(args.cacheHit.streamSpec
      ? { streamSpec: args.cacheHit.streamSpec }
      : {}),
    ...(args.cacheHit.propsSpec
      ? { propsSpec: args.cacheHit.propsSpec }
      : {}),
    ...(args.cacheHit.contextSpec
      ? { contextSpec: args.cacheHit.contextSpec }
      : {}),
    // Symmetric with the cold-gen path — project the contract's
    // `agentCapabilities` so the schema-compat backstop recognizes
    // cross-MCP tools the contract declared.
    ...(args.cacheHit.agentCapabilities
      ? { agentCapabilities: args.cacheHit.agentCapabilities }
      : {}),
    // Symmetric with the cold-gen path so Permissions-Policy
    // derivation reads the same field whether the commit came from a
    // cache hit or fresh generation.
    ...(args.cacheHit.clientCapabilities
      ? { clientCapabilities: args.cacheHit.clientCapabilities }
      : {}),
    // Descriptor sidecar, symmetric with cold-gen.
    ...(args.appGadgets !== undefined && args.appGadgets.length > 0
      ? { gadgetDescriptors: args.appGadgets }
      : {}),
  };
  // Schema-compat check (DEFENSIVE backstop). Authored
  // contracts are validated at push-validation phase BEFORE this
  // handler runs; this site catches drift between `story.contract`
  // and the matched-blueprint's persisted contract — most relevantly
  // when the matched blueprint was registered against a different
  // operator's tool registry that's missing on this server.
  //
  // Thrown SchemaCompatError propagates up to the push handler →
  // structured error response → agent retries (typically by
  // overriding the contract on the same handshakeId). Without this
  // check the site would silently return false and commit nothing,
  // surfacing as the "stuck on Generating UI..." trap. Preview
  // cleanup runs in the catch arm so a thrown error doesn't leak a
  // running preview into the next push.
  if (checkStackItemContracts) {
    try {
      checkStackItemContracts(item);
    } catch (err) {
      await safelyFinalizePreview(
        previewDeps,
        args.stackItemId,
        'schema-mismatch',
      );
      throw err;
    }
  }
  try {
    await sessionStore.appendStackItem(args.sessionId, item);
  } catch {
    await safelyFinalizePreview(previewDeps, args.stackItemId, 'stack-append-failed');
    return false;
  }
  // Fan out to live subscribers — the load-bearing case for B1. The
  // matchType marker `cached` lets the client surface "Reused from
  // cache" UX without a separate roundtrip.
  safelyNotifyStackPush(channelNotifier, args.sessionId, item, 'cached');
  await safelyFinalizePreview(previewDeps, args.stackItemId, 'handoff');
  return true;
}

/**
 * Wrap {@link registerBlueprint} so a write-side rejection (sqlite
 * disk-full, vector-dim mismatch on a misconfigured index, etc.)
 * can't fail an otherwise-successful push. The generator has already
 * produced valid componentCode and the stack item has been appended;
 * the registry write is a performance optimization, not a
 * correctness dependency.
 */
async function safelyRegisterBlueprint(
  deps: import('@ggui-ai/mcp-server-core').EmbeddingProvider extends never
    ? never
    : Parameters<typeof registerBlueprint>[0],
  scope: string,
  input: Parameters<typeof registerBlueprint>[2],
): Promise<void> {
  try {
    await registerBlueprint(deps, scope, input);
  } catch (err) {
    // Best-effort registration — the live push already produced valid
    // code + the stack item; only the future cache-hit optimization is
    // lost. Caught here, not rethrown.
    //
    // Structured JSON for CloudWatch MetricFilter pickup. A bare
    // freeform `console.warn` text message bled for 6 days before G1
    // surfaced the cloud S3 Vectors `nonFilterableMetadataKeys` bug
    // (2026-05-26) — every cache write was failing in production and
    // no alarm fired. The `msg: 'cache_write_failed'` shape lets
    // operators wire a metric filter on `{ $.msg = "cache_write_failed" }`
    // against the pod log group and page on persistent breakage
    // without grepping freeform text. Mirrors the structured-warn
    // pattern from `backend/amplify/functions/status-llm-probe`.
    // eslint-disable-next-line no-console
    console.warn(
      JSON.stringify({
        msg: 'cache_write_failed',
        scope,
        error: err instanceof Error ? err.message : String(err),
        errorName: err instanceof Error ? err.name : undefined,
      }),
    );
  }
}

/**
 * Coerce the override-path's parsed `variance` (zod-typed as
 * `Record<string, unknown>` due to `z.unknown()` on `context`) into
 * the canonical {@link BlueprintVariance} shape. Same pattern as
 * `normalizeBlueprintDraft` in handshake.ts — every key is preserved
 * verbatim; the result is a structural projection, not a transformation.
 * Returns `undefined` for absent or empty inputs so the spread in the
 * `story` builder stays clean.
 */
function normalizeOverrideVariance(
  variance:
    | {
        persona?: string | undefined;
        aesthetic?: string | undefined;
        context?: Record<string, unknown> | undefined;
        seedPrompt?: string | undefined;
      }
    | undefined,
): BlueprintVariance | undefined {
  if (variance === undefined) return undefined;
  const out: { -readonly [K in keyof BlueprintVariance]: BlueprintVariance[K] } = {};
  if (typeof variance.persona === 'string') out.persona = variance.persona;
  if (typeof variance.aesthetic === 'string') out.aesthetic = variance.aesthetic;
  if (typeof variance.seedPrompt === 'string') out.seedPrompt = variance.seedPrompt;
  if (
    variance.context !== undefined &&
    variance.context !== null &&
    typeof variance.context === 'object' &&
    !Array.isArray(variance.context)
  ) {
    // The parsed context object is JSON-safe by construction (zod
    // accepted it through `z.unknown()` from a JSON wire); the
    // canonical `JsonObject` type just spells the same shape with a
    // tighter index signature.
    const ctx: { [k: string]: import('@ggui-ai/protocol').JsonValue } = {};
    for (const [k, v] of Object.entries(variance.context)) {
      ctx[k] = v as import('@ggui-ai/protocol').JsonValue;
    }
    out.context = ctx;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
