/**
 * `ggui_render` — OSS handler for outbound UI delivery.
 *
 * Handshake-first only. The wire input is `{handshakeId, decision,
 * props?, themeId?, infra?}`; the generator input (intent, context,
 * schema, adapters, forceCreate) is read from the handshake record the
 * agent already wrote in the prior `ggui_handshake` round-trip.
 *
 * The handler stamps declaration-level `_meta.ui.resourceUri` +
 * `_meta.ui.visibility` so MCP Apps hosts know to fetch
 * `ui://ggui/render` on a tool call, and (when `mintWsToken` is wired)
 * emits per-result `_meta["ai.ggui/render"]` slice meta carrying the
 * WebSocket bootstrap credentials the iframe shell needs.
 *
 * **What it does:**
 *
 *   1. Validates input (handshakeId required at schema; zod surfaces an
 *      actionable rejection if absent).
 *   2. Consumes the handshake record (`getAndDelete`) — single-use.
 *   3. Resolves the effective contract (cheap-confirm via
 *      `contractHash` OR override via `contract`).
 *   4. Validates routing targets on the contract's `actionSpec`.
 *   5. Resolves or mints the render row from
 *      `handshakeRecord.target.renderId`.
 *   6. Runs the blueprint matcher when cache is wired (cache-hit
 *      short-circuits generation).
 *   7. Otherwise runs the bound `UiGenerator` and registers the
 *      produced blueprint into the cache.
 *   8. Returns a spec-conformant `renderOutputSchema`-shaped result and
 *      emits the single `ai.ggui/render` slice meta via `resultMeta`.
 *
 * **Placeholder render invariant.** When the handler is built with
 * `provisionalPreview` deps, an empty-componentCode placeholder
 * ComponentRender is committed to the render store BEFORE generation
 * runs. The placeholder gives the iframe-runtime a surface to mount the
 * `mountProvisional` branch off — without it, A2UI preview frames on
 * `_ggui:preview` paint into the void. When generation later settles,
 * the SAME `renderId` is reused — `renderStore.commit` upserts by id,
 * so the placeholder is replaced in-place by the authoritative
 * componentCode (success) or an error render (failure).
 *
 * Post-Phase-B (flatten-render-identity): the prior
 * `{sessionId, stackItemId}` pair collapsed to a single `renderId`. The
 * outbound `_meta` collapsed from two slices
 * (`ai.ggui/render` + `ai.ggui/render`) to one (`ai.ggui/render`).
 */

import { randomUUID, randomBytes } from 'node:crypto';
import { z } from 'zod';
import {
  type BlueprintVariance,
  type GadgetDescriptor,
  type DataContract,
  type JsonObject,
  type Render,
  type ComponentRender,
  type SystemRender,
} from '@ggui-ai/protocol';
import {
  GGUI_RENDER_UI_META,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  AppMetadataStore,
  BlueprintProvider,
  KeyValueStore,
  LlmSelection,
  PendingEventConsumer,
  ProviderKeyRef,
  RateLimiter,
  RenderStore,
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
  validateContract,
  dataContractSchema,
  STDLIB_GADGETS,
  renderOutputSchema,
  type GguiRenderOutput,
  type RenderCacheMarker,
} from '@ggui-ai/protocol';
import {
  emitCacheTraceEvent,
  newCacheTraceId,
  truncateCacheTraceIntent,
} from './cache-trace-sink.js';
import { emitPayloadTraceEvent } from './payload-trace-sink.js';
import {
  deriveRenderMeta,
  derivePublicEnvProjection,
  deriveContractBundle,
  type RenderMetaView,
} from './slice-meta-derivation.js';

/**
 * Generation-time deps for the `ggui_render` handler. Absent = the
 * handler stays in placeholder mode (no componentCode written, render
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
 *     `{selection, providerKey}` for THIS render. Returns `null` when
 *     no credentials are available — the handler funnels that case
 *     into the normal failure path (error render +
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
   * Per-render credential lookup. Receives the handler context so
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
   * runs (no cache lookup, every render hits the LLM).
   *
   * When present, the handler runs a `lookupGenerationCache` on the
   * story path BEFORE invoking the generator:
   *
   *   - Hit (score ≥ threshold) → synthesize a `ComponentRender` from
   *     the cached componentCode, skip `uiGenerator.generate`, and emit
   *     `cache.hit:true` on the render output.
   *   - Miss → run the existing generator path unchanged; on success,
   *     `recordGenerationCache` upserts the new componentCode into
   *     the scope so the next same-intent render hits.
   *
   * Scope: `ctx.appId`. Key: `sha256(trimmed intent)[0..16]`. Metadata
   * carries `componentCode` directly — a hit doesn't need a secondary
   * blob lookup to rehydrate a `ComponentRender`.
   *
   * The shape is intentionally optional-at-generation-level rather
   * than a top-level handler dep so the "generation off" default
   * path (no LLM) also has no cache attached — a server without
   * `generation` can't get surprising cache behavior.
   */
  readonly cache?: GenerationCacheDeps;

  /**
   * Per-call LLM resolver for Tier 2 rerank in the blueprint matcher.
   * When wired alongside `cache`, render routes through
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
   * alongside `cache`, the render handler threads it into
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
   * render). Successful resolution always wins — the hook never sees
   * a key.
   *
   * When the hook returns a `Render`, the handler commits THAT row to
   * the render store instead of the generic `{reason:'no-credentials'}`
   * error envelope, sets `componentCode` on the bootstrap meta from it,
   * and reports `codeReady: true`. When it returns `null` (or the hook
   * is absent), the handler falls back to the existing
   * `commitErrorRender` path so historical no-BYOK behavior is
   * preserved for callers that don't opt in.
   *
   * Authored render invariant: the returned render's `id` MUST equal
   * the in-flight `renderId` — `renderStore.commit` upserts by id, so
   * reusing the id replaces the provisional preview placeholder
   * in-place. Helpers in `./no-credentials-card.ts` build the
   * canonical Connect-Claude card shape; embedders compose their own
   * when they need a different "set up your key" surface.
   *
   * Why a hook (not a static render dep): the URL the card points at
   * (`/settings`) depends on the operator's resolved public-base-url,
   * which the handler doesn't know. The CLI composes the URL once at
   * boot and threads it into the closure.
   */
  readonly onNoCredentials?: (
    ctx: HandlerContext,
    story: {
      readonly intent: string;
      readonly renderId: string;
      readonly nowIso: string;
    },
  ) => Render | null | Promise<Render | null>;
}

/**
 * One credential resolution for a single `ggui_render` call. Shape
 * matches the `UiGenerator.generate` input — the handler passes
 * these fields through unchanged.
 */
export interface GenerationCredentials {
  readonly selection: LlmSelection;
  readonly providerKey: ProviderKeyRef;
}

/**
 * Argument bundle handed to {@link GguiRenderHandlerDeps.postSuccessHook}.
 *
 * Carries the resolved render state at success-time so cloud-side
 * fire-and-forget side-effects (RAG indexing, render-cache placeholder
 * write) have everything they need without re-deriving from raw input.
 *
 * Post-Phase-B (flatten-render-identity): the pre-rename `sessionId` +
 * `stackItemId` pair collapsed to a single `renderId`.
 */
export interface RenderPostSuccessArgs {
  readonly ctx: HandlerContext;
  readonly renderId: string;
  /** Resolved DataContract used for this render (echoed contract or override). */
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
  /** Whether the render committed real componentCode. */
  readonly codeReady: boolean;
}

/**
 * Deps for the OSS `ggui_render` handler.
 */
export interface GguiRenderHandlerDeps {
  /** Render-backing store. Used to mint / replace renders on render. */
  readonly renderStore: RenderStore;
  /**
   * Per-app metadata resolver — when bound, render reads
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
   * `markCreated(renderId)` the moment the renderId is minted (Model
   * C: pipes are render-keyed, opened at render time so events from
   * `ggui_runtime_submit_action` land in the pipe even BEFORE the
   * agent's first `ggui_consume` arrives — covers the "user clicks
   * before agent polls" race). Idempotent — same instance must be
   * shared with `createGguiSubmitActionHandler` +
   * `createGguiConsumeHandler` for the pipe to actually thread.
   */
  readonly pendingEventConsumer?: PendingEventConsumer;
  /**
   * Bootstrap-credential minter for the MCP Apps outbound path. When
   * present, the handler's `resultMeta` emits the live-auth trio on
   * the `ai.ggui/render` slice. When ABSENT, no auth fields are
   * emitted — non-MCP-Apps hosts read `{renderId}` straight off
   * `structuredContent` and resolve the render-resource themselves.
   *
   * Returns the live-auth fields — `{wsUrl, token, expiresAt}`. The
   * handler adds `renderId` + `appId` from the render context itself,
   * plus `runtimeUrl` from the separate `runtimeUrl` dep
   * (server-level config, not minter-scoped).
   *
   * A minter that's wired AT ALL is by construction the live-mode
   * minter, so the return shape pins them required so consumers don't
   * have to narrow. Set this to `undefined` (omit the key) for
   * self-contained / system-card-only deployments.
   */
  readonly mintWsToken?: (
    renderId: string,
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
   * onto {@link McpAppAiGguiRenderMeta.runtimeUrl} at `resultMeta` time
   * alongside `renderId` / `appId`. Separate dep (not a field on
   * `mintWsToken`'s return) because the URL is a server-config value
   * (same for every render), not a per-mint credential.
   *
   * Required when `mintWsToken` is set — the thin-shell HTML's boot
   * path depends on it. Omitted + `mintWsToken` set is a configuration
   * bug; we fall back to `/_ggui/iframe-runtime.js` (the same-origin
   * OSS default) with a warning on first use. Callers composing the
   * deps bundle inside `@ggui-ai/mcp-server` always supply this; it's
   * optional here to preserve backward-compatible test construction
   * where the bootstrap branch isn't exercised.
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
   * the `ai.ggui/render.themeId` slice field so MCP Apps hosts
   * (claude.ai web, Claude Desktop) that mount via
   * `ui/notifications/tool-result` postMessage propagate the operator's
   * theme into the iframe's `extractBootstrapFromToolResult` path.
   * Without this, hosts that don't fetch the per-render resource via
   * `resources/read` silently fall back to the iframe-runtime's baked
   * default theme (`ggui`), even when `ggui.json#theme: 'indigo'` is set.
   */
  readonly themeId?: string;
  /** Theme color mode resolved from `ggui.json#theme.mode`. */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Live theme getter — resolved per-render instead of per-boot. When
   * set, supersedes the static `themeId` / `themeMode` deps for every
   * result-meta computation, so a console save (which mutates the
   * underlying state cell) reaches the next render without a server
   * restart.
   *
   * Returns `undefined` when no theme is set (the default-theme
   * path); returns `{ id, mode? }` when a preset is selected. The
   * caller (CLI) constructs a closure that reads from a shared
   * mutable ref the console-theme route also writes to on POST.
   *
   * Static `themeId` / `themeMode` survive as the no-getter fallback
   * for embedding hosts that compose `createGguiServer` directly
   * without dynamic theming — e.g. test fixtures.
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
   * reconfig flows in per-render without a restart.
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
   * per-render gate passes, the handler fires a background preview
   * task that emits A2UI-shaped payloads on the reserved
   * `_ggui:preview` channel. Absence of this dep is the "preview
   * not wired" signal — see {@link ProvisionalPreviewDeps}.
   */
  readonly provisionalPreview?: ProvisionalPreviewDeps;

  /**
   * Admission-control seam. When present, every `ggui_render` call is
   * gated through `rateLimiter.check({key, cost: 1})` BEFORE the
   * handler's state-changing work begins. Denials throw
   * `RateLimitedError`; the transport layer projects the carried
   * {@link import('@ggui-ai/mcp-server-core').RateLimitDecision} to
   * HTTP 429 + `Retry-After` / `X-RateLimit-*` headers.
   *
   * Key composition: `ggui_render:<appId>`. The handler does NOT
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
   * ShortCode → render lookup. When present, every successful render
   * records the minted `shortCode → { renderId, appId }` binding so
   * downstream same-origin consumers (console `/s/<shortCode>` viewer)
   * can resolve it back. Writes are best-effort: if the index `put`
   * rejects, the render tool result is NOT failed — the agent already
   * holds the URL and the operator-visible surface gracefully 404s on
   * lookup.
   *
   * Absence of this dep is the "hosted cloud has its own
   * shortCode→render table, OSS isn't using console" signal —
   * `ggui_render` still works end-to-end; same-origin viewer lookups
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
   * second `ggui_render` with the same handshakeId surfaces
   * `HandshakeNotFoundError`. `createGguiHandshakeHandler` is the peer
   * writer; both handlers take the same `KeyValueStore` instance.
   */
  readonly handshakeStore?: KeyValueStore;

  /**
   * Generation wiring. When present AND the render is a story path
   * (not MCP Apps), the handler:
   *
   *   1. Resolves BYOK credentials via `resolveLlm`.
   *   2. Kicks off provisional preview fire-and-forget (same seam
   *      as before — preview runs concurrently with generation).
   *   3. `await`s `uiGenerator.generate(...)`.
   *   4. On success: commits a real `ComponentRender` with
   *      `componentCode` + `sourceCode` and returns `codeReady: true`.
   *   5. On failure: commits an error-only `ComponentRender` and
   *      returns `codeReady: false`. Preview teardown fires with reason
   *      `'generation-failed'`.
   *
   * Absent = the current "placeholder" behavior: no real
   * componentCode on the story path, `codeReady: false` on every story
   * render. This keeps the handler honest on OSS hosts that haven't
   * configured BYOK yet — render + shortCode + preview work; real code
   * generation is opt-in through this dep.
   */
  readonly generation?: GenerationDeps;

  /**
   * Schema-compat check hook. When present, fires at three boundaries
   * — render validation (against `story.contract`), cache-hit commit
   * (against the matched blueprint's contract), and gen success
   * (against the generator's response contract). Purpose: if any
   * `actionSpec[name]` tool ref / `streamSpec[channel].tool`
   * ref is incompatible with its tool's registered `inputSchema` /
   * return schema, the handler rejects the render BEFORE the commit
   * — the agent sees an honest structured failure instead of a render
   * that will silently surface as a perpetual loading state.
   *
   * Recovery posture: schema-compat errors are AGENT-FIXABLE — the agent
   * authored a contract whose declared schema doesn't fit the named
   * tool. The check throws `SchemaCompatError` (`schema_mismatch_error`)
   * at the EARLIEST boundary, the error propagates to the render response,
   * and the handshake record is preserved so the agent can retry on
   * the same handshakeId after fixing the contract. This is symmetric
   * with `CrossReferenceError` (`cross_reference_unresolved`) — both
   * are author-recoverable failures rooted in the contract.
   *
   * Type: accepts any shape with optional `actionSpec` / `streamSpec`
   * fields. `DataContract` (render-validation phase) and
   * `ComponentRender` (cache-hit + gen success phases) both fit
   * structurally.
   *
   * Absent = no check (the zero-config / no-mounts / tests-with-no-
   * registry case). Servers MAY bind the check helper
   * `@ggui-ai/mcp-server/checkRenderSchemaCompat` here.
   */
  readonly checkRenderContracts?: (
    shape: {
      readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
      readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
    },
  ) => void;

  /**
   * Optional live-subscriber notifier. When present, every successful
   * commit (cold-generation success, cache-hit reuse, MCP Apps render,
   * error render) fan-outs a render-commit wire frame to every live
   * subscriber on the affected render.
   *
   * Why optional: the seam exists for transports that hold a live
   * subscription model (live-channel `/ws`). Hosts without a render
   * channel (programmatic embedding, Lambda one-shot invocation) leave
   * it absent — no notify needed because there's no live subscriber.
   *
   * Why a separate seam from `provisionalPreview.sendEnvelope`: render
   * commits are NOT stream-channel envelopes. They don't carry a
   * channel name, don't fold under streamSpec validation, and are not
   * subject to the per-channel replay policy. Routing them through
   * `sendToRender` would force a fake stream-channel for state that
   * isn't a stream — keep the wire shape honest by giving render
   * commits their own delivery method.
   *
   * Failure model: per-subscriber send failures are swallowed by the
   * channel server; this seam returns `void`. A notify failure cannot
   * make a render fail — the `renderStore.commit` already happened,
   * which is the source of truth.
   */
  readonly channelNotifier?: ChannelNotifier;

  /**
   * Canvas-mode lifecycle emitter. Fires `push_started` on the
   * `_ggui:lifecycle` channel right after renderId is minted so the
   * canvas animator transitions from `ready`/`handshake` to
   * `constructing` immediately — without waiting for the final commit
   * envelope (which arrives after generation completes).
   *
   * Absent ⇒ no emission. Non-canvas deployments pay zero cost.
   */
  readonly canvasLifecycle?: import('./canvas-lifecycle.js').CanvasLifecycleEmitter;

  /**
   * Content-addressable code-blob store.
   *
   * When present AND a story-path render results in non-empty
   * `componentCode` on the committed render, the handler
   * computes `sha256(code)`, writes (hash, code) to the store, and
   * surfaces `codeUrl` + `codeHash` on the render response
   * (`structuredContent` + the `ai.ggui/render` slice). The iframe
   * runtime fetches the URL to load the compiled ES module.
   *
   * Pairs with {@link codeBaseUrl} below — both must be present for
   * URLs to be emitted. The store-without-baseUrl combo writes blobs
   * but emits no URL.
   *
   * Absent = the bootstrap emits no codeUrl. The iframe mounts via
   * live mode (wsUrl+token) and receives the render — including
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
   * render — the thrown error class propagates unchanged through
   * JSON-RPC, so the gate owns the wire envelope (e.g. cloud's
   * `RenderBillingError` mapping to HTTP 402).
   *
   * Receives raw input (untyped) so the gate can inspect cloud-only
   * fields (e.g. `infra.model` for provider derivation) before zod
   * validation strips them. The handler still validates the wire
   * shape afterward; the gate doesn't replace input validation.
   *
   * Cloud wiring: BYOK + credit pre-check (insufficient_credit /
   * unsupported_provider). OSS leaves absent — no per-render billing.
   */
  readonly preValidationGate?: (
    ctx: HandlerContext,
    rawInput: unknown,
  ) => Promise<void> | void;

  /**
   * Post-success hook. Fires AFTER the render commit for this call
   * and AFTER the response object is assembled, but BEFORE the handler
   * returns. Receives a {@link RenderPostSuccessArgs} bundle with the
   * resolved renderId, contract, contractHash, story echo, action
   * classification, and codeReady — everything cloud needs for
   * fire-and-forget side-effects.
   *
   * Contract: the hook is awaited. If it throws, the handler
   * propagates — cloud's hook impl is responsible for swallowing its
   * own internal failures (RAG index write, render-cache placeholder
   * write) so a side-effect failure can never make a render fail.
   *
   * Cloud wiring: writes the `GguiRenderCache` placeholder + emits a
   * RAG embedding for next-render pool match. OSS leaves absent.
   */
  readonly postSuccessHook?: (
    args: RenderPostSuccessArgs,
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
   * ID factory for fresh renders. The handler mints a renderId
   * upstream of `renderStore.commit` so the just-minted id flows
   * onto the response BEFORE any persistence side-effect runs.
   *
   * OSS default: `randomUUID()` (no prefix). Hosted impls that need
   * a typed prefix (e.g. `rend_<uuid>`) supply this dep so the prefix
   * convention propagates without forking the factory's id-minting
   * site. Called ONLY on the create path — `target.renderId`
   * resolution + reuse skip this entirely.
   */
  readonly renderIdFactory?: () => string;
}

/**
 * Live-subscriber notifier for render commits. The mcp-server's
 * `RenderChannelServer.notifyRenderCommit` implements this contract;
 * the handler depends on the narrowed shape so the handlers package
 * doesn't take a peer dep on the full render-channel surface.
 *
 * `matchType` is reserved for cache/blueprint-match diagnostics the
 * client surfaces (see `GguiRender`'s commit handler — it folds
 * `matchType` into a synthetic progress event). OSS today omits it.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from the prior
 * `notifyRenderCommit(sessionId, stackItem, matchType?)` to
 * `notifyRenderCommit(renderId, render, matchType?)` — the render IS
 * the addressable row.
 */
export interface ChannelNotifier {
  notifyRenderCommit(
    renderId: string,
    render: Render,
    matchType?: string,
  ): void;
}

/**
 * Input raw-shape.
 *
 * Single shape: `{ handshakeId, decision, props? }`.
 * `handshakeId` is REQUIRED — every render consumes a prior
 * `ggui_handshake` record. The handshake captures the intent +
 * blueprintDraft and produces the suggestion the render acts on.
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
        "ggui_render: handshakeId is REQUIRED. Call ggui_handshake({intent, blueprintDraft}) first to negotiate, then render with {handshakeId, decision: {kind: 'accept'}} (accept the suggestion) or {handshakeId, decision: {kind: 'override', blueprintDraft: {...}}} (mint fresh against a new draft). Direct-render without a handshakeId is not supported.",
    })
    .min(1, 'ggui_render: handshakeId must be a non-empty string.'),
  /**
   * Runtime prop values for THIS render. Validated against the
   * effective contract's `propsSpec`. Validation failures throw
   * `ContractViolationError` (recoverable); the handshake remains
   * alive so the agent can fix-and-retry on the same handshakeId.
   */
  props: z.record(z.string(), z.unknown()).optional(),
  /**
   * Per-render theme override. When set, lands on the committed
   * render and takes priority over `App.defaultThemeId` at
   * bootstrap-projection time. Use sparingly — most renders should
   * inherit the app default. Set this when a single render needs a
   * distinct look (urgent banner, hero marketing card) without
   * retheming the rest of the chat.
   */
  themeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Per-render theme override. Wins over App.defaultThemeId for THIS render. Omit to inherit the app theme.',
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
          'Provider-prefixed model id (e.g., `anthropic/claude-haiku-4-5`, `openai/gpt-5`). Generator-specific prefixes (e.g., `bedrock/...` for AWS Bedrock routing) supported when the bound generator handles them.',
        ),
    })
    .strict()
    .optional(),
  /**
   * Render decision discriminator.
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
 * Pre-launch, no back-compat. Four fields, all load-bearing:
 *   - `renderId` — agent's handle for follow-up tool calls
 *     (ggui_consume, ggui_update).
 *   - `resourceUri` — spec-canonical MCP-Apps entry-point
 *     (`ui://ggui/render/{renderId}[/{contractHash}]`). SDKs that
 *     preserve `_meta` also receive this on `_meta.ui.resourceUri`,
 *     but SDKs that strip `_meta` from tool_results (OpenAI Agents
 *     SDK, Google ADK) reach the URI only via this LLM-visible field.
 *     Mirrors the `resourceUri` surface `ggui_update` ships.
 *   - `nextStep` — terse recovery hint (tool + args). Emitted only
 *     when the contract has actionSpec; pure-display renders omit.
 *   - `action` — negotiator's decision (`create | reuse | update |
 *     replace | compose`). May inform the agent's follow-up prompt.
 */
/**
 * Canonical wire output shape — pulled from `@ggui-ai/protocol`'s
 * `renderOutputSchema` so the handler's wire shape can't drift from
 * the protocol declaration. `.shape` unpacks the zod object back to a
 * field-record for SharedHandler's type-level inference.
 */
const outputSchema = renderOutputSchema.shape;

/**
 * Internal handler-output type — carries the FULL field set that
 * downstream seams need (resultMeta, postSuccessHook, cloud
 * persistence, test assertions). The LLM-visible serialization is
 * the `GguiRenderOutput` subset (`{renderId, resourceUri, nextStep?,
 * action}`); zod's `.parse()` strips the extras (`shortCode`,
 * `codeReady`, etc.) before they land on `structuredContent`.
 */
type RenderOutput = GguiRenderOutput & {
  // Internal seams (stripped from JSON-RPC envelope by outputSchema):
  shortCode: string;
  codeReady: boolean;
  handshakeId?: string;
  codeUrl?: string;
  codeHash?: string;
};

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
 * Build the OSS `ggui_render` handler wired against the given deps.
 *
 * The handler's tool declaration carries `_meta.ui.resourceUri` +
 * `_meta.ui.visibility: ['model']` per the §2.4.1 entry-point lock.
 */
export function createGguiRenderHandler(
  deps: GguiRenderHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, RenderOutput> {
  return {
    name: 'ggui_render',
    title: 'Render',
    audience: ['agent'],
    description:
      // Description is structured as 6 short blocks instead of one
      // wall of prose. Agents skim — leading with the call shape +
      // prerequisite is what produces correct first calls.
      [
        // 1. Call shape — the literal JSON the agent must emit.
        "CALL SHAPE: ggui_render({handshakeId, decision, props?}). handshakeId comes from a prior ggui_handshake (REQUIRED). decision is one of {kind:'accept'} (use the handshake suggestion verbatim, reuses provisional blueprintId) OR {kind:'override', blueprintDraft:{contract, variance?, generator?}} (mint a fresh blueprintId against your NEW draft). props is REQUIRED when the effective contract declares propsSpec; values are validated against propsSpec at render time.",
        // 2. Prerequisite — handshake first, always.
        'PREREQUISITE: call ggui_handshake({intent, blueprintDraft}) FIRST. The response carries handshakeId + suggestion (origin: cache | agent | synth) — render consumes it. Direct render without a handshakeId fails with handshake_not_found.',
        // 2b. Next step — driven by the response, not blanket-applied.
        "NEXT STEP: read the response. If it carries a `nextStep` field (only emitted when the contract had non-empty actionSpec), call that tool — it names ggui_consume({renderId}) and you must long-poll for the user's gesture before ending your turn. If the response has NO nextStep, the UI is pure-display (props only, no interactive buttons/forms) — you can end your turn; the user reads the UI and prompts you again when ready. After consume returns an event, the event's own `nextStep` (if any) tells you the tool to call next; otherwise loop back to handshake → render.",
        // 3. Recovery shape — what happens on validation failure.
        "RECOVERABLE FAILURES: cross_reference_unresolved / contract_schema_invalid / schema_mismatch_error / contract_violation (props) / missing_props all preserve the handshake — fix your input and retry on the SAME handshakeId. cross_reference_unresolved fires when an `actionSpec[name].nextStep` or `streamSpec[channel].source.tool` names a tool that's not declared in `agentCapabilities.tools` — every referenced tool MUST appear in agentCapabilities.tools (catalog discoverability; same-MCP and cross-MCP both go here). contract_schema_invalid fires when an inner JSON Schema is malformed (e.g. `propsSpec.properties.X.schema` missing `type`). schema_mismatch_error fires when an actionSpec entry's `schema` is not a subset of the named tool's registered inputSchema, OR a streamSpec channel's `schema` doesn't accept the tool's return shape — adjust the action/channel schema to match the tool, or omit `nextStep` if the agent will compose the call from a different toolset entirely. Only handshake_not_found forces a re-handshake.",
        // 4. Mutation rule — never re-render.
        'MUTATION: ggui_update mutates props on a delivered UI. NEVER re-render to mutate — re-rendering destroys scroll position, focus, and uncommitted input.',
        // 5. Wire surface — DataContract overview.
        "WIRE SURFACE (DataContract). PLACEMENT RULE for the two inbound specs: actionSpec carries DISCRETE EVENTS that drive the agent's next turn (submit, send, confirm, cancel, choose). contextSpec carries STATE the agent observes (draft text, slider value, current selection, in-progress list items). The single test: does this thing need the agent's next-turn reasoning? Yes → actionSpec. No → contextSpec. There is no third category — no `terminal` flag, no `consumeSpec`, no `interaction` mode. Specs (every entry is a WRAPPER that contains a JSON Schema in `schema:` — the JSON Schema does NOT sit flat at the entry level):  • propsSpec.properties[name].{schema, required?, default?} — initial render values, validated against propsSpec.  • actionSpec[name].{label, schema?, nextStep?, confirm?, icon?} — clicks. `nextStep` is an OPTIONAL string naming the agent's intended next tool call (e.g. nextStep:'todo_toggle'); the named tool MUST also be declared in `agentCapabilities.tools`. Omit nextStep for actions the agent composes freely from any toolset.  • contextSpec[slot].{schema, default?} — observable client state (counters, toggles, slider values). Use slot setter; NOT useAction.  • streamSpec[channel].{schema, mode?, replay?, source?} — live updates from agent to UI (outbound).  • agentCapabilities.tools[name].{description?, inputSchema?, outputSchema?} — declarative catalog of every MCP tool the contract references from actionSpec.nextStep or streamSpec.source.tool.",
        // 6. Hosting hint — what the result looks like.
        'HOSTING: on MCP Apps hosts (Claude.ai, Claude Desktop) mounts an iframe via ui://ggui/render and streams on the live channel; other hosts resolve `{renderId}` from structuredContent and render via their own render-resource fetch.',
      ].join(' '),
    inputSchema,
    outputSchema,
    _meta: {
      // §2.4.1 entry-point lock: `_meta.ui.resourceUri` +
      // `_meta.ui.visibility` per the MCP Apps spec. Exactly one ggui
      // tool carries these; expanding this set without revisiting the
      // design lock is a boundary violation.
      //
      // Legacy flat-key (`_meta["ui/resourceUri"]`) is stamped
      // automatically by `registerAppTool` in `build-mcp.ts` — we
      // carry the canonical key only.
      ui: GGUI_RENDER_UI_META,
    },
    async handler(input, ctx: HandlerContext): Promise<RenderOutput> {
      // Render is handshake-first. The wire input is just
      // {handshakeId, decision, props?}; the generator input (intent,
      // context, schema, adapters, forceCreate) flows from the
      // handshake record the agent already wrote in the prior
      // `ggui_handshake` round-trip. Schema-required handshakeId
      // carries an educational `required_error` so a missing-handshakeId
      // zod parse error includes actionable recovery text inside the
      // JSON-RPC -32602 envelope.

      // Pre-validation gate fires BEFORE input parsing so a cloud
      // deployment's billing checks (insufficient_credit /
      // unsupported_provider) can reject the render without spending
      // validation work. Errors propagate unchanged — the gate owns
      // the JSON-RPC envelope.
      if (deps.preValidationGate) {
        await deps.preValidationGate(ctx, input);
      }

      const parsed = z.object(inputSchema).parse(input);

      if (!deps.handshakeStore) {
        throw new Error(
          'ggui_render: requires the handler to be built with a `handshakeStore:` KeyValueStore dep — the same instance `createGguiHandshakeHandler` wrote to.',
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
      //     post-render).
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
        // its declared variance.
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

      // Telemetry: classification observable on every render so the
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
            ? `push-classify: agent accepted handshake suggestion (origin=${handshakeRecord.suggestion.origin}${
                handshakeRecord.suggestion.blueprintMeta.blueprintId
                  ? `, blueprintId=${handshakeRecord.suggestion.blueprintMeta.blueprintId}`
                  : ''
              })`
            : `push-classify: agent overrode handshake suggestion with a fresh draft`,
      });

      // Effective story for the rest of the handler.
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
      // `appMetadataStore` is bound, the registry-membership block
      // below captures the catalog (App record's `gadgets`, or
      // `STDLIB_GADGETS` on fallback). On cold-gen, this is threaded
      // into the generator's `UiGenerateInput.appGadgets` so the
      // code-gen system prompt's `clientCapabilities — registered
      // catalog` section renders the SAME catalog the synth + decision
      // LLMs see. Stays `undefined` when `appMetadataStore` is unset —
      // the system prompt falls through to its STDLIB default.
      let resolvedAppLibraries: readonly GadgetDescriptor[] | undefined;

      // Admission check. Fires BEFORE state changes — a rate-limited
      // caller should get 429 without the server doing any real work.
      if (deps.rateLimiter) {
        const decision = await deps.rateLimiter.check({
          key: `ggui_render:${ctx.appId}`,
          cost: 1,
        });
        if (!decision.allowed) {
          throw new RateLimitedError(`ggui_render:${ctx.appId}`, decision);
        }
      }

      // Single deterministic contract gate — the SAME `validateContract`
      // the handshake backstop runs (retired fields, inner-schema
      // validity, cross-references, name invariants, schema-compat). On
      // the ACCEPT path this re-checks an already-validated contract
      // (defense-in-depth; never fires). On the OVERRIDE path it is the
      // STRICT commit gate: a forced contract MUST conform — the server
      // does not repair it ("use mine verbatim"). A failure is rethrown
      // with a pointer back to ggui_handshake (which DOES repair), so the
      // agent recovers instead of looping on override.
      try {
        validateContract(story.contract);
      } catch (err) {
        if (acceptanceClassification === 'override') {
          const detail = err instanceof Error ? err.message : String(err);
          throw new Error(
            `override_contract_invalid: the forced contract failed validation — ${detail} Override COMMITS you to your exact contract; the server does not repair it. To get an auto-repaired or cache-matched contract, call ggui_handshake({intent, blueprintDraft}) and send decision:{kind:'accept'} — do NOT retry override with the same draft.`,
          );
        }
        throw err;
      }

      // Duplicate-gadget-hook gate (gadget-specific; not part of the
      // contract gate). Two bindings with the same (package, hook)
      // double-mount the wrapper; hard reject so the violation is
      // observable rather than silently tolerated.
      assertNoDuplicateGadgetHooks(story.contract);

      // Gadget registry gate + enrichment. First: every
      // `(package, export name)` the contract references on
      // `clientCapabilities.gadgets` MUST resolve in `App.gadgets`.
      // Second: the referenced package descriptors are snapshotted
      // onto `ComponentRender.gadgetDescriptors` so the persisted
      // render carries full teaching text + bundleUrl + styleUrl +
      // connect[]. No-op when `appMetadataStore` is unset.
      if (deps.appMetadataStore) {
        const appRecord = await deps.appMetadataStore.get(ctx.appId);
        const appGadgets = appRecord?.gadgets ?? STDLIB_GADGETS;
        assertGadgetsRegistered(story.contract, appGadgets);
        assertPublicEnvSatisfied(
          story.contract,
          appGadgets,
          appRecord?.publicEnv,
        );
        resolvedAppLibraries = filterDescriptorsToContract(
          story.contract,
          appGadgets,
        );
      }

      // (Name-invariant + schema-compat invariants are covered by the
      // single `validateContract` gate above — no separate asserts here.)

      // Schema-compat validation against the AUTHORED contract via the
      // server's registered tool registry. Defensive backstops at gen
      // and cache-hit commit phases (see `runGenerationIntoRender` +
      // `commitCachedRender`) cover contracts that differ from
      // `story.contract` (synth-emit, matched-blueprint reuse).
      if (deps.checkRenderContracts && story.contract) {
        deps.checkRenderContracts({
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
      let runtimeProps = parsed.props;
      if (effectiveContract.propsSpec) {
        const propsToValidate = (runtimeProps ?? {}) as Record<string, unknown>;
        const propsValidation = validatePropsData(
          propsToValidate,
          effectiveContract.propsSpec,
        );
        if (!propsValidation.valid) {
          throw new ContractViolationError({
            tool: 'ggui_render',
            violations: propsValidation.violations,
            hint: 'Fix the props to satisfy the agreed propsSpec, or send a refined `contract` to override the agreed shape. The handshake record is preserved across this validation error — retry on the SAME handshakeId after fixing the input; no need to re-handshake.',
          });
        }
      } else if (
        runtimeProps !== undefined &&
        Object.keys(runtimeProps).length > 0
      ) {
        if (acceptanceClassification === 'accept') {
          // Forgiving ACCEPT: the negotiator may have RESHAPED the
          // contract (e.g. synth moves a mutable collection like `todos`
          // from propsSpec → contextSpec), so the agent's accept-path
          // props — authored against its ORIGINAL draft — no longer fit.
          // The agreed contract declares no propsSpec, so the props are
          // unusable; DROP them (the UI starts from contextSpec defaults)
          // rather than hard-failing. The agent populates live state via
          // ggui_update after render. Override stays STRICT (below).
          const droppedKeys = Object.keys(runtimeProps).join(', ');
          // eslint-disable-next-line no-console -- operator-visible signal
          console.warn(
            `[ggui_render] accept-path props dropped — the agreed contract declares no propsSpec ` +
              `(synth likely reshaped propsSpec → contextSpec). Dropped keys: ${droppedKeys}. ` +
              `Populate live state with ggui_update after render.`,
          );
          runtimeProps = undefined;
        } else {
          throw new ContractViolationError({
            tool: 'ggui_render',
            violations: [
              {
                field: 'props',
                message:
                  'props supplied but your override contract declares no propsSpec. Drop the `props` field, or add a propsSpec covering these fields.',
                expected: 'no props (contract has no propsSpec)',
                received: `props with keys: ${Object.keys(runtimeProps).join(', ')}`,
              },
            ],
            hint: 'Your OVERRIDE draft has no propsSpec, so it takes no props. Drop `props`, add a propsSpec — or re-handshake and use decision:accept (the accept path tolerates mismatched props instead of failing). The handshake record is preserved; retry on the SAME handshakeId.',
          });
        }
      }

      // Atomically consume the handshake record now that input
      // validation has succeeded.
      const consumed = await consumeHandshakeRecord(
        deps.handshakeStore,
        ctx.appId,
        parsed.handshakeId,
      );
      if (!consumed) {
        throw new HandshakeNotFoundError(parsed.handshakeId);
      }

      // Resolve or mint the render id. The handshake negotiator MAY
      // suggest reusing an existing render via `target.renderId` (the
      // cache / update path); absent ⇒ mint a fresh id. Reuse only
      // counts when the existing render belongs to the same appId —
      // cross-tenant id collisions fall back to mint.
      const requestedId = handshakeRecord.target.renderId;
      let renderId: string;
      let action: RenderOutput['action'];

      if (requestedId) {
        const existing = await deps.renderStore.get(requestedId);
        if (existing && existing.appId === ctx.appId) {
          renderId = existing.id;
          action = 'reuse';
        } else {
          renderId = requestedId;
          action = 'create';
        }
      } else {
        renderId = deps.renderIdFactory
          ? deps.renderIdFactory()
          : randomUUID();
        action = 'create';
      }

      // Devtools payload trace. No-op when no sink is registered.
      // Post-Phase-B the sink shape addresses by `renderId` directly
      // (every render IS the addressable row).
      emitPayloadTraceEvent({
        direction: 'outbound-update',
        renderId,
        appId: ctx.appId,
        tool: 'ggui_render',
        payload: { handshakeId: parsed.handshakeId, story },
      });

      // Emit render_started so the canvas animator transitions to its
      // `constructing` state immediately, without waiting for cold-
      // gen to settle. Fire-and-forget.
      deps.canvasLifecycle?.emit(renderId, {
        kind: 'render_started',
        renderId,
        intent: story.intent,
      });

      // Open the renderId-keyed pending-events pipe (Model C). This
      // MUST happen before any iframe-side dispatch could fire — the
      // user can click before the agent's first `ggui_consume`, and
      // `ggui_runtime_submit_action` needs an open pipe to append to.
      // Idempotent: re-mark on the same renderId is a no-op.
      if (deps.pendingEventConsumer) {
        try {
          deps.pendingEventConsumer.markCreated?.(renderId);
        } catch {
          // Pipe open failures are non-fatal — `ui/message` fallback
          // on the host still routes gestures on the next chat turn.
        }
      }

      const shortCode = generateShortCode();

      // Record shortCode → render binding for same-origin console
      // viewer lookups. Post Phase-B identity collapse: `renderId` IS
      // the addressable unit, so the binding row carries a single
      // `renderId` field (the prior `sessionId` + `stackItemId` slot
      // pair always held the same value at the bind site).
      if (deps.shortCodeIndex) {
        try {
          await deps.shortCodeIndex.put(shortCode, {
            renderId,
            appId: ctx.appId,
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
      // `await` blocks the render RPC. Viewer sees preview frames
      // stream over `_ggui:preview` while the generator call is in
      // flight; on success/failure we tear down preview via
      // `finalizeProvisionalPreview` and the authoritative render is
      // the final state.
      // Provisional-preview's surface still uses `sessionId` +
      // `stackItemId` as field names; post-Phase-B both positions
      // carry the same `renderId` (every render IS the addressable
      // row). Renaming the provisional-preview surface is sibling-
      // owned (the file's pre-existing `HandleStreamEnvelope`
      // mismatches at 440/576 show that rename is already in flight
      // there).
      const previewGate = evaluateProvisionalPreviewGate(
        deps.provisionalPreview,
        {
          story,
          isMcpAppsPush: false,
        },
        { appId: ctx.appId, renderId },
      );
      if (previewGate.kind === 'skip') {
        deps.provisionalPreview?.onOutcome?.({
          status: 'skipped',
          reason: previewGate.reason,
          renderId,
          appId: ctx.appId,
        });
      } else if (deps.provisionalPreview) {
        const handle = kickoffProvisionalPreview(deps.provisionalPreview, {
          renderId,
          appId: ctx.appId,
          story,
        });
        // Register into the optional handoff registry so a later
        // handler (generation success below, apply-render-patch
        // setting componentCode, render teardown, shutdown) can
        // cancel by `renderId`. Absent registry → the preamble still
        // runs; it just has no external cancellation site.
        deps.provisionalPreview.registry?.register(renderId, handle);

        // Placeholder render — drives the provisional preview path.
        // The iframe-runtime mounts `mountProvisional` per render
        // (empty `componentCode` routes to the provisional branch).
        // Without an item committed, `_ggui:preview` frames the
        // emitter just kicked off would paint into the void.
        //
        // Lifecycle: this placeholder lives until generation settles.
        // `renderStore.commit` upserts by `render.id`, so when the
        // cold-generation success / cache-hit / generation-failed
        // paths below call `commit` with the SAME `renderId`, the
        // placeholder is replaced in-place — no double-commit, no
        // stale entry. When generation is NOT wired (no provider
        // key), the placeholder stays for the render's lifetime;
        // that's the honest "we have no code yet but the preview
        // surface is mounted" state.
        //
        // We bypass the schema-compat hook here because the
        // placeholder declares no contract; the hook fires when
        // generation later commits the real render. Live-subscriber
        // notify DOES fire so a viewer that connects mid-render sees
        // the placeholder show up — without the notify the renderer
        // wouldn't know to mount a surface for it.
        const nowEpochMs = Date.now();
        const placeholder: ComponentRender = {
          id: renderId,
          appId: ctx.appId,
          type: 'component',
          componentCode: '',
          prompt: story.intent,
          contentType: 'application/javascript+react',
          createdAt: nowEpochMs,
          lastActivityAt: nowEpochMs,
          expiresAt: nowEpochMs + DEFAULT_RENDER_TTL_MS,
          eventSequence: 0,
        };
        try {
          await deps.renderStore.commit({
            render: placeholder,
            appId: ctx.appId,
          });
        } catch {
          // Defensive — a placeholder-commit failure is not fatal to
          // the render. The renderId + shortCode are already minted;
          // the worst case is the live renderer paints nothing for
          // this render, which is the same "preview never wired"
          // degraded state callers without `provisionalPreview`
          // already see.
        }
        safelyNotifyRenderCommit(deps.channelNotifier, renderId, placeholder);
      }

      // Generation + cache gate. Absent generation deps = placeholder
      // mode: story renders return `codeReady: false`. The placeholder
      // render committed just above (when provisionalPreview was wired)
      // keeps the live-renderer's provisional surface mounted;
      // generation-off doesn't paint anything onto it but also doesn't
      // leave the renderer with no anchor. When generation IS wired:
      //
      //   - If `generation.cache` is also wired, attempt a retrieval
      //     first. A hit synthesizes a Render from the cached
      //     componentCode (skip LLM entirely) and surfaces
      //     `cache.hit:true` on the render output.
      //   - On a miss (or cache absent), run the generator as before.
      //     On success, when cache is wired, record the produced
      //     componentCode into the scope so the next same-intent
      //     render hits.
      let generatedCodeReady = false;
      // Reuse outcome for this render — surfaced on the wire `cache` field.
      let cacheMarker: RenderCacheMarker | undefined;

      // Probe-card short-circuit. Intent prefix `[ggui:probe]` triggers
      // the MCP Apps protocol probe diagnostic system card.
      const PROBE_INTENT_PREFIX = '[ggui:probe]';
      if (story.intent.startsWith(PROBE_INTENT_PREFIX)) {
        const nowEpochMs = Date.now();
        const probeRender: SystemRender = {
          id: renderId,
          appId: ctx.appId,
          type: 'system',
          kind: 'mcp-apps-probe',
          createdAt: nowEpochMs,
          lastActivityAt: nowEpochMs,
          expiresAt: nowEpochMs + DEFAULT_RENDER_TTL_MS,
          eventSequence: 0,
          props: { intent: story.intent },
        };
        try {
          await deps.renderStore.commit({
            render: probeRender,
            appId: ctx.appId,
          });
          safelyNotifyRenderCommit(deps.channelNotifier, renderId, probeRender);
          generatedCodeReady = true;
        } catch {
          // Commit failure leaves codeReady=false; downstream synth
          // emits an empty bootstrap which the runtime renders as the
          // generic system-card fallback.
        }
        await safelyFinalizePreview(deps.provisionalPreview, renderId, 'probe');
      } else if (deps.generation) {
        const intent = story.intent;
        const forceCreate = storedInput.forceCreate === true;

        // Blueprint matcher when cache is wired. Exact-key and
        // semantic strategies short-circuit generation entirely; a
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
              contract: matchResult.blueprint.contract,
            };
          }
        }

        if (blueprintHit) {
          generatedCodeReady = await commitCachedRender(
            deps.renderStore,
            deps.provisionalPreview,
            deps.channelNotifier,
            deps.checkRenderContracts,
            {
              renderId,
              appId: ctx.appId,
              story,
              cacheHit: {
                cachedBlueprintId: blueprintHit.id,
                similarity: blueprintHit.cosine,
                componentCode: blueprintHit.componentCode,
                cachedIntent: intent,
                cachedAt: new Date().toISOString(),
                // Project the matched blueprint's contract onto the
                // cache hit so commitCachedRender lands the four wire-
                // surface specs on the new render. Symmetric with
                // runGenerationIntoRender's render build: both paths
                // emit the same shape, and bootstrap-meta derivation
                // reads from one place.
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
                // Project clientCapabilities through the blueprint-hit
                // path so the cached commit emits Permissions-Policy
                // directives whenever the matched blueprint's contract
                // declared them.
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
          cacheMarker = {
            hit: true,
            similarity: blueprintHit.cosine,
            cachedBlueprintId: blueprintHit.id,
            llmCallsAvoided: 1,
            kind: 'full-template',
          };
        } else {
          // The `.d.ts` fetch is deferred to HERE — the cold-gen
          // branch — not done eagerly after the registry gate. On a
          // blueprint cache hit the fetched types would be discarded
          // (cache-hit commits don't typecheck or build a prompt),
          // and a network transient in the fetch would wrongly fail a
          // render that had a valid cache hit. Only cold generation
          // consumes `gadgetTypes`, so only cold generation pays the
          // fetch.
          const resolvedGadgetTypes =
            resolvedAppLibraries !== undefined
              ? await fetchGadgetTypes(resolvedAppLibraries)
              : undefined;
          const outcome = await runGenerationIntoRender(
            deps.generation,
            deps.renderStore,
            deps.provisionalPreview,
            deps.channelNotifier,
            deps.checkRenderContracts,
            deps.generator,
            {
              ctx,
              renderId,
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
            cacheMarker = {
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
      // + `codeBaseUrl` are wired AND the just-committed render has
      // non-empty `componentCode`, write (hash, code) to the store and
      // surface `codeUrl` + `codeHash` on the response.
      //
      // The lookup re-reads the render because the commit happened
      // several branches above (cache-hit, fresh generation, MCP Apps
      // inbound) — re-reading is simpler than threading a reference
      // through every branch and matches resultMeta's own pattern.
      // Failures are silent: on a put error or a missing render we
      // fall through with no codeUrl. Without codeUrl, the iframe
      // falls back to live-mode (wsUrl+token) — the render is
      // delivered via the live-channel WS subscribe.
      let codeUrl: string | undefined;
      let codeHash: string | undefined;
      if (deps.codeStore && deps.codeBaseUrl) {
        try {
          const stored = await deps.renderStore.get(renderId);
          const rendered = stored?.render;
          if (
            rendered
            && rendered.type !== 'mcpApps'
            && rendered.type !== 'system'
            && typeof rendered.componentCode === 'string'
            && rendered.componentCode.length > 0
          ) {
            const hash = deps.codeStore.hashOf(rendered.componentCode);
            await deps.codeStore.put(hash, rendered.componentCode);
            codeHash = hash;
            const base = deps.codeBaseUrl.replace(/\/$/, '');
            codeUrl = `${base}/code/${hash}.js`;
          }
        } catch {
          // Silent — codeStore failure falls back to inline-base64 path.
        }
      }

      // Per-render theme overlay. The commit paths above
      // (cold-gen / cache-hit / probe / placeholder) construct the
      // render from their own templates; none of them know about the
      // agent's `parsed.themeId` input. Rather than thread themeId
      // through every constructor, we read the just-committed render
      // once + re-commit with `themeId` set when the agent requested a
      // per-render override. `renderStore.commit` is upsert-by-id so
      // this collapses to a single row update; the bootstrap-projection
      // block in `resultMeta` then reads the overlaid value via the
      // same lookup path that drives `deriveRenderMeta`.
      //
      // Failure here downgrades to "no per-render theme override" (the
      // app default / process default still apply via the layered
      // resolution chain). Better than failing the whole render for a
      // cosmetic overlay.
      if (parsed.themeId !== undefined) {
        try {
          const stored = await deps.renderStore.get(renderId);
          const top = stored?.render;
          if (
            top &&
            top.type !== 'mcpApps' &&
            top.type !== 'system'
          ) {
            const overlaid: ComponentRender = { ...top, themeId: parsed.themeId };
            await deps.renderStore.commit({
              render: overlaid,
              appId: ctx.appId,
            });
          }
        } catch (err) {
          // eslint-disable-next-line no-console -- one-shot warn, no logger dep on render handler today
          console.warn(
            '[ggui_render.theme_overlay_failed]',
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
      // renders (props only) get no `nextStep` because there's nothing
      // for the agent to consume.
      const hasActions =
        effectiveContract.actionSpec !== undefined &&
        Object.keys(effectiveContract.actionSpec).length > 0;
      const nextStep = hasActions
        ? {
            tool: 'ggui_consume' as const,
            description:
              'Drain the action pipe for this render — long-polls until a user gesture arrives or 15s timeout.',
            example: `ggui_consume({ renderId: "${renderId}" })`,
            args: { renderId },
          }
        : undefined;

      // Render response architecture (2026-05-13):
      //   - `outputSchema` defines the LLM-visible subset (3 fields).
      //   - This `result` carries the FULL set — extras are stripped
      //     by zod's `.parse()` (z.object default behavior) before
      //     the JSON-RPC `structuredContent` is built.
      //   - Internal seams (resultMeta, postSuccessHook, tests) read
      //     from this rich in-memory object.
      // Per-render resource URI — same formula `resultMeta` uses to
      // build `_meta.ui.resourceUri`. Surfacing it on the LLM-visible
      // structuredContent too lets agent SDKs that strip `_meta` from
      // tool_results (OpenAI Agents SDK, Google ADK) still hand a
      // mount handle to their frontend without the side-channel.
      const blueprintSegmentForOutput = resolvedContractHash
        ? `/${resolvedContractHash}`
        : '';
      const resourceUriForOutput = `${GGUI_RENDER_UI_META.resourceUri}/${renderId}${blueprintSegmentForOutput}`;
      const result: RenderOutput = {
        renderId,
        resourceUri: resourceUriForOutput,
        action,
        shortCode,
        codeReady: generatedCodeReady,
        handshakeId: handshakeRecord.handshakeId,
        contractHash: resolvedContractHash,
        cache: cacheMarker ?? { hit: false, llmCallsAvoided: 0, kind: 'cold' },
        ...(codeUrl ? { codeUrl, codeHash } : {}),
        ...(nextStep ? { nextStep } : {}),
      };

      // Post-success hook for fire-and-forget side-effects.
      if (deps.postSuccessHook) {
        await deps.postSuccessHook({
          ctx,
          renderId,
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
      // and re-fetch on history reload. Reuses the URI already computed
      // by the handler (and surfaced on structuredContent for SDKs that
      // strip `_meta`); a single source of truth means no chance of the
      // two derivations drifting apart.
      const perCallResourceUri = output.resourceUri;
      // `_meta.ui.displayMode` is the spec-native presentation hint
      // (MCP-Apps SEP-1865). When the app declares a default, stamp it
      // on every render so hosts can arrange this iframe accordingly.
      let perCallDisplayMode:
        | import('@ggui-ai/protocol').McpUiDisplayMode
        | undefined;

      // Look up the just-committed render to embed renderable wire
      // shape on the `ai.ggui/render` slice meta. Hosts whose iframe
      // sandbox CSP blocks `connect-src` to our origin (claude.ai's
      // `claudemcpcontent.com` wrapper) cannot fetch the per-render
      // resource — but they DO forward the full `_meta` over postMessage,
      // so the inline-mount path needs the renderable in the meta
      // itself.
      //
      // Render-derived fields (componentCode | kind, propsJson,
      // actionNextSteps, contextSlots) come from the
      // {@link deriveRenderMeta} projection — same single source of
      // truth the public-render `/r/<shortCode>` route composes its
      // inline shell from.
      let view: RenderMetaView = {};
      // Public env projection requires App.publicEnv, which lives on
      // the App record (not the render). Re-read here in resultMeta
      // rather than threading via closure.
      let bootstrapPublicEnv:
        | Readonly<Record<string, string>>
        | undefined;
      // Per-render theme override sourced from the just-committed
      // render itself.
      let renderThemeId: string | undefined;
      // `lastSequence` — monotonic event-ledger cursor stamped on every
      // emit (R6). Polling clients use it to initialize the /events
      // cursor (R7) aligned with the WS stream.
      let lastSequence: number | undefined;
      try {
        const stored = await deps.renderStore.get(output.renderId);
        const top = stored?.render;
        if (stored) {
          lastSequence = stored.eventSequence;
        }
        if (top) {
          view = deriveRenderMeta(top);
          // Project the App's publicEnv down to the union of declared
          // wrappers' `requires`.
          if (deps.appMetadataStore) {
            const appRecord = await deps.appMetadataStore.get(ctx.appId);
            bootstrapPublicEnv = derivePublicEnvProjection(
              top,
              appRecord?.publicEnv,
            );
            if (appRecord?.defaultDisplayMode !== undefined) {
              perCallDisplayMode = appRecord.defaultDisplayMode;
            }
          }
          // Per-render theme override — only on the `component`
          // variant. McpAppsRender / SystemRender don't carry
          // user-facing themes (they render via host-supplied or
          // built-in renderers).
          if (top.type !== 'mcpApps' && top.type !== 'system') {
            renderThemeId = top.themeId;
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
      // we rename to `wsToken` here so the render slice matches the
      // wire field name. When absent we still emit a minimal
      // `ai.ggui/render` slice carrying renderId + appId + runtimeUrl
      // so postMessage-mount paths work without a WS-token minter.
      const mintedTrio = deps.mintWsToken
        ? deps.mintWsToken(output.renderId, ctx.appId)
        : undefined;
      const authFields: Partial<
        Pick<McpAppAiGguiRenderMeta, 'wsUrl' | 'wsToken' | 'expiresAt'>
      > = mintedTrio
        ? {
            wsUrl: mintedTrio.wsUrl,
            wsToken: mintedTrio.token,
            expiresAt: mintedTrio.expiresAt,
          }
        : {};
      // Surface the content-addressable code URL + hash on the
      // `ai.ggui/render` slice. The output object already carries
      // these (the handler body wrote to codeStore + composed the URL
      // before returning), so we just forward — no second lookup, no
      // second store write.
      const outputWithCode = output as typeof output & {
        codeUrl?: string;
        codeHash?: string;
      };
      // Layered theme resolution at slice-meta-projection time.
      // Order is operator-debug-wins: `liveTheme` exists ONLY when an
      // operator just picked a theme via the dev console picker, so
      // it's their "show me what THIS looks like" intent — that has to
      // beat agent-stored state.
      //
      //   1. liveTheme?.id   — process-shared live cell from the
      //      console-theme POST.
      //   2. renderThemeId   — per-render override the agent set on
      //      `ggui_render.themeId` (rare; mostly omitted).
      //   3. deps.themeId    — static boot-time fallback.
      const liveTheme = deps.themeProvider?.();
      const resolvedThemeId =
        liveTheme?.id ?? renderThemeId ?? deps.themeId;
      const resolvedThemeMode = liveTheme?.mode ?? deps.themeMode;
      // Surface the names of same-server app-visible tools so the
      // iframe-runtime can choose Pattern α (direct tools/call) over
      // Pattern β (3-message bridge) per wired action.
      const appCallableTools = deps.appCallableTools?.() ?? [];
      // Mirror `serverCapabilities.streamWebSocketLocalTools` onto
      // the bootstrap.
      const streamWebSocketLocalTools = deps.streamWebSocketLocalTools?.();

      // Content-addressable contract bundle. When the committed render
      // declares a runtime-validated schema AND the server has a
      // CodeStore wired, compile + write the bundle + emit the URL.
      // The iframe-runtime fetches the URL and dynamic-imports to
      // resolve validators (Cache-Control:immutable means repeat
      // renders with the same contract hit the browser cache without
      // a round-trip).
      let contractHash: string | undefined;
      let validatorsUrl: string | undefined;
      if (deps.codeStore && deps.codeBaseUrl) {
        try {
          const stored = await deps.renderStore.get(output.renderId);
          const top = stored?.render;
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

      // Build the single `ai.ggui/render` slice (#109 / R3 / B.2c).
      // Carries identity + live-auth + capability advertisements +
      // current render state + contract pointer + component-mode
      // discriminator — everything an iframe needs to mount.
      const render: McpAppAiGguiRenderMeta = {
        renderId: output.renderId,
        appId: ctx.appId,
        runtimeUrl,
        ...authFields,
        ...(appCallableTools.length > 0 ? { appCallableTools } : {}),
        ...(streamWebSocketLocalTools !== undefined
          ? { streamWebSocketLocalTools }
          : {}),
        // Operator-registered wrappers ride the render slice so the
        // runtime can dynamic-import each before mounting. Projected
        // by `deriveRenderMeta` from the (enriched) render contract;
        // only emitted when wrappers are actually declared so
        // pure-STDLIB apps stay byte-identical.
        ...(view.gadgets !== undefined && view.gadgets.length > 0
          ? { gadgets: view.gadgets }
          : {}),
        // Minimum-disclosure subset of App.publicEnv (union of
        // declared wrappers' `requires`). Filtered above by
        // `derivePublicEnvProjection`.
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
        ...(view.permissionsPolicy !== undefined
          ? { permissionsPolicy: [...view.permissionsPolicy] }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
        ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
        ...(view.actionNextSteps !== undefined
          ? { actionNextSteps: view.actionNextSteps }
          : {}),
        ...(view.contextSlots !== undefined
          ? { contextSlots: [...view.contextSlots] }
          : {}),
        // Content-addressable contract validators. Both fields present
        // together or absent together — iframe-runtime treats absence
        // as "no validators".
        ...(contractHash !== undefined && validatorsUrl !== undefined
          ? { contractHash, validatorsUrl }
          : {}),
        ...(view.kind ? { kind: view.kind } : {}),
        ...(outputWithCode.codeUrl
          ? { codeUrl: outputWithCode.codeUrl }
          : {}),
        ...(outputWithCode.codeHash
          ? { codeHash: outputWithCode.codeHash }
          : {}),
      };
      const uiMeta: Record<string, unknown> = {
        resourceUri: perCallResourceUri,
        ...(perCallDisplayMode !== undefined
          ? { displayMode: perCallDisplayMode }
          : {}),
      };
      const meta: Record<string, unknown> = {
        ...toMcpAppEnvelope(render),
        ui: uiMeta,
        // Legacy flat key for hosts that read the unnested form.
        'ui/resourceUri': perCallResourceUri,
      };
      return meta;
    },
  };
}

/**
 * Default TTL applied to renders the handler mints inline. The
 * authoritative TTL lives on the store impls (InMemory: 1h, Sqlite:
 * 24h, DDB: tenant policy); this constant only fills the
 * `Render.expiresAt` field of the wire shape (which the store may
 * overwrite at commit time anyway). 1 hour matches the InMemoryStore
 * default — anything longer would surprise tests that pin TTL
 * semantics; anything shorter would close active renders mid-session.
 */
const DEFAULT_RENDER_TTL_MS = 60 * 60 * 1000;

/**
 * Invoke the bound {@link UiGenerator} for a story-path render and
 * commit the resulting {@link ComponentRender}. Returns `true` when
 * real componentCode landed; `false` when no credentials were
 * resolved, the generator rejected, or the generator returned an
 * error result.
 *
 * Side-effects:
 *
 *   - Success: `renderStore.commit({render})` with the generator's
 *     componentCode + sourceCode and `renderId` as the render id.
 *     Preview (if registered) is cancelled with reason `'handoff'`.
 *   - Failure: `renderStore.commit({render: errorRender})` with
 *     `componentCode: ''` and a populated `error` field so the agent
 *     can read the failure reason via the render channel. Preview (if
 *     registered) is cancelled with reason `'generation-failed'`.
 *   - `await`s throughout — the render RPC blocks until generation
 *     settles. This is intentional: a synchronous `codeReady:true` is
 *     the honest user-visible signal for "ggui_render returned and the
 *     component is ready". Clients that want progress read the
 *     provisional preview channel.
 *
 * Never throws. Every failure path funnels through an error render
 * + preview teardown so the caller doesn't have to install a
 * rejection handler. Secondary failures (commit rejecting, preview
 * cancel throwing) are swallowed — keeping the render channel +
 * transport intact matters more than re-raising.
 */
interface GenerationRunOutcome {
  readonly ok: boolean;
  readonly componentCode?: string;
  readonly createdAt: string;
}

async function runGenerationIntoRender(
  generation: GenerationDeps,
  renderStore: RenderStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  checkRenderContracts:
    | ((shape: {
        readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
        readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
      }) => void)
    | undefined,
  generatorOverride: GguiRenderHandlerDeps['generator'] | undefined,
  args: {
    readonly ctx: HandlerContext;
    readonly renderId: string;
    readonly story: {
      readonly intent: string;
      readonly context?: unknown;
      readonly contract?: DataContract;
      readonly variance?: BlueprintVariance;
    };
    /** Runtime prop values for THIS render. Validated against
     *  `story.contract.props` (propsSpec) by the upstream caller
     *  before this function runs. */
    readonly runtimeProps?: JsonObject;
    /**
     * Operator-registered gadget catalog resolved by the render
     * handler from the bound `AppMetadataStore`.
     */
    readonly appGadgets?: readonly GadgetDescriptor[];
    /**
     * `package → .d.ts content` for the contract's non-stdlib
     * gadgets, parallel-fetched by the render handler.
     */
    readonly gadgetTypes?: Readonly<Record<string, string>>;
    /**
     * MP.5 (2026-05-24) — typed `infra.model` override from the
     * agent's wire input.
     */
    readonly infra?: { readonly model?: string };
  },
): Promise<GenerationRunOutcome> {
  const { ctx, renderId, story } = args;
  const nowIso = new Date().toISOString();
  const nowEpochMs = Date.now();

  // Credential-free input shape — both the override path and the
  // OSS path build their generator input on top of this.
  const generateInputBase: Omit<UiGenerateInput, 'llm' | 'providerKey'> = {
    request: {
      renderId,
      prompt: story.intent,
      ...(isJsonObject(story.context) ? { context: story.context } : {}),
    },
    blueprints: generation.blueprints,
    ...(story.contract !== undefined
      ? { contract: story.contract }
      : {}),
    ...(story.variance !== undefined ? { variance: story.variance } : {}),
    ...(args.appGadgets !== undefined
      ? { appGadgets: args.appGadgets }
      : {}),
    ...(args.gadgetTypes !== undefined
      ? { gadgetTypes: args.gadgetTypes }
      : {}),
    ...(args.infra !== undefined ? { infra: args.infra } : {}),
  };

  let result: Awaited<ReturnType<UiGenerator['generate']>>;

  if (generatorOverride) {
    // Cloud seam: a cloud deployment's server-side generator resolves
    // its own credentials inside the runner.
    try {
      result = await generatorOverride(generateInputBase, ctx);
    } catch (err) {
      return commitErrorRender(renderStore, previewDeps, channelNotifier, {
        renderId,
        appId: ctx.appId,
        story,
        nowIso,
        nowEpochMs,
        message:
          err instanceof Error
            ? `generator threw: ${err.message}`
            : 'generator threw',
        reason: 'generator-threw',
      });
    }
  } else {
    // OSS path: resolve credentials then call generation.uiGenerator.
    let creds: GenerationCredentials | null;
    try {
      creds = await generation.resolveLlm(ctx);
    } catch (err) {
      return commitErrorRender(renderStore, previewDeps, channelNotifier, {
        renderId,
        appId: ctx.appId,
        story,
        nowIso,
        nowEpochMs,
        message:
          err instanceof Error
            ? `credential resolution failed: ${err.message}`
            : 'credential resolution failed',
        reason: 'credential-resolution-failed',
      });
    }
    if (!creds) {
      // Operator-supplied no-credentials fallback.
      if (generation.onNoCredentials) {
        let fallback: Render | null = null;
        try {
          fallback = await generation.onNoCredentials(ctx, {
            intent: story.intent,
            renderId,
            nowIso,
          });
        } catch {
          fallback = null;
        }
        if (fallback) {
          return commitNoCredentialsCardRender(
            renderStore,
            previewDeps,
            channelNotifier,
            {
              renderId,
              appId: ctx.appId,
              nowIso,
              render: fallback,
            },
          );
        }
      }
      return commitErrorRender(renderStore, previewDeps, channelNotifier, {
        renderId,
        appId: ctx.appId,
        story,
        nowIso,
        nowEpochMs,
        message:
          'no credentials available for the configured generation provider (expected env var or ~/.ggui/credentials.json entry)',
        reason: 'no-credentials',
      });
    }

    try {
      result = await generation.uiGenerator.generate({
        ...generateInputBase,
        llm: creds.selection,
        providerKey: creds.providerKey,
      });
    } catch (err) {
      return commitErrorRender(renderStore, previewDeps, channelNotifier, {
        renderId,
        appId: ctx.appId,
        story,
        nowIso,
        nowEpochMs,
        message:
          err instanceof Error
            ? `generator threw: ${err.message}`
            : 'generator threw',
        reason: 'generator-threw',
      });
    }
  }

  if (!result.ok) {
    return commitErrorRender(renderStore, previewDeps, channelNotifier, {
      renderId,
      appId: ctx.appId,
      story,
      nowIso,
      nowEpochMs,
      message: result.error.message,
      reason: 'generation-failed',
    });
  }

  // Happy path — commit the authoritative ComponentRender.
  const responseContracts = result.response.contract;
  const componentRender: ComponentRender = {
    id: renderId,
    appId: ctx.appId,
    type: 'component',
    componentCode: result.response.componentCode,
    prompt: story.intent,
    contentType: 'application/javascript+react',
    createdAt: nowEpochMs,
    lastActivityAt: nowEpochMs,
    expiresAt: nowEpochMs + DEFAULT_RENDER_TTL_MS,
    eventSequence: 0,
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
    ...(responseContracts?.contextSpec
      ? { contextSpec: responseContracts.contextSpec }
      : {}),
    ...(responseContracts?.agentCapabilities
      ? { agentCapabilities: responseContracts.agentCapabilities }
      : {}),
    ...(responseContracts?.clientCapabilities
      ? { clientCapabilities: responseContracts.clientCapabilities }
      : {}),
    ...(args.appGadgets !== undefined && args.appGadgets.length > 0
      ? { gadgetDescriptors: args.appGadgets }
      : {}),
  };
  // Schema-compat check (DEFENSIVE backstop).
  if (checkRenderContracts) {
    try {
      checkRenderContracts(componentRender);
    } catch (err) {
      await safelyFinalizePreview(
        previewDeps,
        renderId,
        'schema-mismatch',
      );
      throw err;
    }
  }
  try {
    await renderStore.commit({
      render: componentRender,
      appId: ctx.appId,
    });
  } catch {
    await safelyFinalizePreview(previewDeps, renderId, 'commit-failed');
    return { ok: false, createdAt: nowIso };
  }
  // Live-subscriber notify. Cold-generation success — the entry reuses
  // an existing renderId, so already-subscribed clients should see the
  // new componentCode flip the matching `data-ggui-code-ready` slot
  // from `false` to `true`.
  safelyNotifyRenderCommit(channelNotifier, renderId, componentRender);
  await safelyFinalizePreview(previewDeps, renderId, 'handoff');
  return {
    ok: true,
    componentCode: result.response.componentCode,
    createdAt: nowIso,
  };
}

/**
 * Commit a hand-authored "no-credentials" card render, fan out the
 * render-commit notify, and tear down provisional preview with the
 * canonical `'no-credentials'` reason. Returns `ok: true` so the
 * render handler reports `codeReady: true` and emits the card's
 * `kind` on the `ai.ggui/render.kind` slice field — the iframe
 * renderer mounts the registered system card.
 *
 * Render-id contract: the caller's `render.id` MUST equal `renderId`
 * (the in-flight render id) so `renderStore.commit` replaces the
 * provisional placeholder in place. This helper rebinds it
 * defensively to keep the contract local — a hook that returns a
 * Render with a different id still lands at the active row.
 */
async function commitNoCredentialsCardRender(
  renderStore: RenderStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  args: {
    readonly renderId: string;
    readonly appId: string;
    readonly nowIso: string;
    readonly render: Render;
  },
): Promise<GenerationRunOutcome> {
  const render: Render = { ...args.render, id: args.renderId } as Render;
  let committed = false;
  try {
    await renderStore.commit({
      render,
      appId: args.appId,
    });
    committed = true;
  } catch {
    // Commit rejected — preview teardown is the only honest recovery;
    // the render store is otherwise unchanged.
  }
  if (committed) {
    safelyNotifyRenderCommit(channelNotifier, args.renderId, render);
  }
  await safelyFinalizePreview(previewDeps, args.renderId, 'no-credentials');
  // System cards have no `componentCode` — surface an empty string so
  // the outcome shape stays uniform; downstream observers don't read
  // it for the fallback path.
  const code =
    render.type !== 'mcpApps' && render.type !== 'system'
      ? render.componentCode
      : '';
  return committed
    ? { ok: true, componentCode: code, createdAt: args.nowIso }
    : { ok: false, createdAt: args.nowIso };
}

/**
 * Source-type field on `ComponentRender` is too narrow for an "error,
 * no code" payload, so we synthesize a `componentCode: ''` record with
 * the `error` slot populated. Renderers already handle
 * `componentCode === ''` by showing a fallback UI; the extra `error`
 * field carries the operator-facing reason.
 */
async function commitErrorRender(
  renderStore: RenderStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  args: {
    readonly renderId: string;
    readonly appId: string;
    readonly story: { readonly intent: string };
    readonly nowIso: string;
    readonly nowEpochMs: number;
    readonly message: string;
    readonly reason: string;
  },
): Promise<GenerationRunOutcome> {
  const errorRender: ComponentRender = {
    id: args.renderId,
    appId: args.appId,
    type: 'component',
    componentCode: '',
    prompt: args.story.intent,
    error: args.message,
    contentType: 'application/javascript+react',
    createdAt: args.nowEpochMs,
    lastActivityAt: args.nowEpochMs,
    expiresAt: args.nowEpochMs + DEFAULT_RENDER_TTL_MS,
    eventSequence: 0,
  };
  let committed = false;
  try {
    await renderStore.commit({
      render: errorRender,
      appId: args.appId,
    });
    committed = true;
  } catch {
    // Secondary failure — render store rejected the error record.
    // Nothing meaningful to do; preserve render channel integrity by
    // still finalizing preview below.
  }
  if (committed) {
    safelyNotifyRenderCommit(channelNotifier, args.renderId, errorRender);
  }
  await safelyFinalizePreview(previewDeps, args.renderId, args.reason);
  return { ok: false, createdAt: args.nowIso };
}

/**
 * Best-effort fire of {@link ChannelNotifier.notifyRenderCommit}.
 * Wrapped so a notifier impl that throws can't fail an already-
 * committed render. Returns `void` because the notify is observably-
 * fire-and-forget — the source of truth for the render is the
 * RenderStore, which already accepted the write before we got here.
 *
 * Absent notifier → no-op. That's the "host without a live render
 * channel (programmatic embedding, hosted Lambda one-shot)" case;
 * those hosts read state via subscribe-time snapshot, not deltas.
 */
function safelyNotifyRenderCommit(
  notifier: ChannelNotifier | undefined,
  renderId: string,
  render: Render,
  matchType?: string,
): void {
  if (!notifier) return;
  try {
    notifier.notifyRenderCommit(renderId, render, matchType);
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
 * swallowed — preview teardown is best-effort during a render
 * settlement.
 */
async function safelyFinalizePreview(
  previewDeps: ProvisionalPreviewDeps | undefined,
  renderId: string,
  reason: string,
): Promise<void> {
  const registry = previewDeps?.registry;
  if (!registry) return;
  try {
    await finalizeProvisionalPreview(registry, renderId, reason);
  } catch {
    // Swallow. The runner's own terminal outcome already fired; a
    // second-order cancel rejection isn't worth propagating.
  }
}

/**
 * Narrow-only passthrough guard so we can forward `story.context`
 * into `UIGenerationRequest` without losing type safety. The zod
 * schema on `story` is `.passthrough()` so the field arrives as
 * `unknown`; we accept the minimum structural shape the generator
 * contract requires.
 */
function isJsonObject(v: unknown): v is JsonObject {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Commit a cache-hit {@link ComponentRender}. Mirrors the happy-path
 * branch of {@link runGenerationIntoRender}, minus the generator call
 * + the cache-record write (the entry is already in the store —
 * that's why we hit). Returns `true` when the commit succeeded and
 * `false` on a render-store rejection (treated the same as a
 * generation commit failure: no crash, preview torn down, render
 * returns `codeReady: false` so the agent observes the degraded
 * state through the channel instead of a synthetic "ready" signal).
 */
async function commitCachedRender(
  renderStore: RenderStore,
  previewDeps: ProvisionalPreviewDeps | undefined,
  channelNotifier: ChannelNotifier | undefined,
  checkRenderContracts:
    | ((shape: {
        readonly actionSpec?: import('@ggui-ai/protocol').ActionSpec;
        readonly streamSpec?: import('@ggui-ai/protocol').StreamSpec;
      }) => void)
    | undefined,
  args: {
    readonly renderId: string;
    readonly appId: string;
    readonly story: { readonly intent: string };
    readonly cacheHit: GenerationCacheHit;
    /** Runtime prop values for THIS render. Validated against the
     *  resolved contract's propsSpec by the caller before this
     *  function runs. */
    readonly runtimeProps?: JsonObject;
    /**
     * Resolved descriptor subset (filtered from `App.gadgets` to
     * those referenced by the contract's wire-side
     * `(hook, package, version)` tuples). Persisted on the render as
     * `gadgetDescriptors` so the bootstrap-meta derivation reads
     * descriptor metadata without re-resolving.
     */
    readonly appGadgets?: readonly GadgetDescriptor[];
  },
): Promise<boolean> {
  const nowEpochMs = Date.now();
  // Cached path — project optional contract fields onto the
  // ComponentRender so the bootstrap-meta derivation in `resultMeta`
  // reads them off the active render.
  const componentRender: ComponentRender = {
    id: args.renderId,
    appId: args.appId,
    type: 'component',
    componentCode: args.cacheHit.componentCode,
    prompt: args.story.intent,
    contentType: 'application/javascript+react',
    createdAt: nowEpochMs,
    lastActivityAt: nowEpochMs,
    expiresAt: nowEpochMs + DEFAULT_RENDER_TTL_MS,
    eventSequence: 0,
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
    ...(args.cacheHit.agentCapabilities
      ? { agentCapabilities: args.cacheHit.agentCapabilities }
      : {}),
    ...(args.cacheHit.clientCapabilities
      ? { clientCapabilities: args.cacheHit.clientCapabilities }
      : {}),
    ...(args.appGadgets !== undefined && args.appGadgets.length > 0
      ? { gadgetDescriptors: args.appGadgets }
      : {}),
  };
  if (checkRenderContracts) {
    try {
      checkRenderContracts(componentRender);
    } catch (err) {
      await safelyFinalizePreview(
        previewDeps,
        args.renderId,
        'schema-mismatch',
      );
      throw err;
    }
  }
  try {
    await renderStore.commit({
      render: componentRender,
      appId: args.appId,
    });
  } catch {
    await safelyFinalizePreview(previewDeps, args.renderId, 'commit-failed');
    return false;
  }
  // Fan out to live subscribers — the load-bearing case for B1.
  safelyNotifyRenderCommit(
    channelNotifier,
    args.renderId,
    componentRender,
    'cached',
  );
  await safelyFinalizePreview(previewDeps, args.renderId, 'handoff');
  return true;
}

/**
 * Wrap {@link registerBlueprint} so a write-side rejection (sqlite
 * disk-full, vector-dim mismatch on a misconfigured index, etc.)
 * can't fail an otherwise-successful render. The generator has
 * already produced valid componentCode and the render has been
 * committed; the registry write is a performance optimization, not a
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
    // Best-effort registration — the live render already produced
    // valid code + the row was committed; only the future cache-hit
    // optimization is lost.
    //
    // Structured JSON for CloudWatch MetricFilter pickup.
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
    const ctx: { [k: string]: import('@ggui-ai/protocol').JsonValue } = {};
    for (const [k, v] of Object.entries(variance.context)) {
      ctx[k] = v as import('@ggui-ai/protocol').JsonValue;
    }
    out.context = ctx;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}
