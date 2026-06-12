/**
 * `ggui_update` — handler for props mutation on an existing render.
 *
 * `sessionId` arrives on the wire input today, but a future caller
 * dispatching this handler in-process from the live channel can
 * populate the canonical `HandlerContext.sessionId` field instead; the
 * handler reads either source.
 *
 * Wire input (matches `updateInputSchema` in `@ggui-ai/protocol`):
 *   - `{sessionId, kind:'replace', props}` — full props replacement.
 *   - `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch.
 *
 * Pure render-mutation flow:
 *   1. Validate union — surface "neither arm matched" before tenant work.
 *   2. Load + tenancy-gate the render via `renderStore.get` + `appId` cmp.
 *   3. Apply patch via the shared `applyGguiSessionPatch` helper:
 *      - throws `ContractViolationError{tool:'ggui_update'}` on schema fail
 *   4. Persist the updated render via `renderStore.commit(...)` (upserts
 *      by `render.id`, preserves lifecycle).
 *   5. Best-effort live delivery via the optional `propsUpdateNotifier`
 *      seam (closure forwarded by the host onto
 *      `GguiSessionChannelServer.sendPropsUpdate`). Failures are swallowed —
 *      the persistence write is the source of truth, the WS push is a
 *      latency optimization.
 *
 * What this handler does NOT do:
 *   - Connection-id management. The standalone server uses
 *     live-channel fan-out; a cloud deployment's connection-id and
 *     stale-connection cleanup stay deployment-specific.
 *   - Billing / traffic-class gates. The standalone server is
 *     single-tenant by default; a cloud deployment layers its own
 *     gates on top.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `{sessionId, stackItemId, …}` resolution + stack mutation to a single
 * `{sessionId, …}` resolution + direct render commit. The slice meta on
 * `resultMeta` collapsed from `ai.ggui/session` + `ai.ggui/stack-item`
 * to one `ai.ggui/render`.
 */
import { z } from 'zod';
import {
  ContractViolationError,
  type ComponentGguiSession,
  type JsonObject,
  type GguiSession,
} from '@ggui-ai/protocol';
import {
  GGUI_RENDER_UI_META,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  applyGguiSessionPatch,
  type GguiSessionTarget,
} from './apply-ggui-session-patch.js';
import {
  assembleRenderSliceBase,
  deriveRenderMeta,
  type RenderMetaView,
  type RenderSliceMetaDeps,
} from './slice-meta-derivation.js';
import { GguiSessionNotFoundError } from './errors.js';
import { emitPayloadTraceEvent } from './payload-trace-sink.js';

/**
 * Live-subscriber props-update notifier. The mcp-server's
 * `GguiSessionChannelServer.sendPropsUpdate` implements this contract; the
 * handler depends on the narrowed shape so the handlers package doesn't
 * take a peer dep on the full render-channel surface.
 *
 * Mirrors the {@link import('./render.js').ChannelNotifier} shape, narrowed
 * to the props_update wire frame ggui_update produces. Hosts without a
 * render channel leave this absent — the persistence write still
 * commits, the live frame just isn't fanned.
 *
 * `Promise<void>` matches the underlying channel impl's signature; the
 * handler awaits to surface unexpected errors via the structured logger
 * (best-effort delivery; thrown errors in the seam don't fail the tool
 * call).
 */
export interface PropsUpdateNotifier {
  sendPropsUpdate(sessionId: string, props: JsonObject): Promise<void>;
}

/** Re-exported for callers that prefer to import the error from this module.
 *  These are the two typed failure shapes `ggui_update` throws:
 *  `GguiSessionNotFoundError` (render missing or cross-tenant) and
 *  `ContractViolationError` (props validation fail). */
export { GguiSessionNotFoundError, ContractViolationError };

/**
 * Pre-mutation gate. The handler invokes `preCheck` before any state
 * change. Throwing aborts the call with the error verbatim — the gate
 * implementor owns the typed error shape (cloud's `RenderForbiddenError`
 * carrying a structured envelope; OSS deployments leave the gate
 * unbound and skip the check entirely).
 *
 * Cloud's traffic-class gate (kind=user vs kind=app vs playground vs
 * RENDER_ALLOW_NON_PLAYGROUND env override) plugs in here instead of
 * cloud's update.ts owning its own gate. The same interface is used
 * for kind-aware billing pre-checks (BYOK + credit pool) on render.
 */
export interface BillingGate {
  preCheck(input: {
    readonly ctx: HandlerContext;
    /**
     * Which tool the gate is firing for. Lets a single gate impl run
     * different policies per call-site (e.g. update is free / render
     * triggers a credit charge).
     */
    readonly tool: 'ggui_update' | 'ggui_render';
  }): Promise<void> | void;
}

/**
 * Deps for the OSS `ggui_update` handler — a small narrow seam set,
 * all optional parts marked as such.
 *
 * Extends {@link RenderSliceMetaDeps} — the `ai.ggui/render`
 * envelope-base plumbing (`mintWsToken` / `runtimeUrl` / `themeId` /
 * `themeMode` / `themeProvider`) is declared ONCE and shared verbatim
 * with `ggui_render`, so the two emitting tools cannot drift on the
 * slice deps. When the minter is wired, the post-patch slice lets MCP
 * Apps hosts that forward the full `CallToolResult` (including
 * `_meta`) via `ui/notifications/tool-result` postMessage re-apply
 * patched props to a still-mounted iframe WITHOUT re-subscribing.
 * Minter absent = no `_meta` on update results; persistence + the
 * live-channel `props_update` fan-out still fire.
 */
export interface GguiUpdateHandlerDeps extends RenderSliceMetaDeps {
  /** GguiSession-backing store. Used to load + persist the patched render. */
  readonly renderStore: GguiSessionStore;
  /**
   * Optional live-subscriber notifier. When present, every successful
   * persistence fans a `{type:'props_update', payload:{sessionId, props}}`
   * live-channel frame to live subscribers via the seam. Forwarded as-is
   * to {@link PropsUpdateNotifier.sendPropsUpdate}.
   *
   * Hosts without a render channel leave this absent — the
   * persistence write still commits, no WS frame is delivered.
   * Notifier rejections / throws are caught + logged-via-throw-swallow;
   * the tool call still returns `updated: true`.
   */
  readonly propsUpdateNotifier?: PropsUpdateNotifier;
  /**
   * Optional pre-mutation gate. See {@link BillingGate}. Hosted
   * deployments bind a real gate (cloud's traffic-class /
   * non-playground / kind=user check); OSS leaves unset and the gate
   * step is a no-op.
   */
  readonly billingGate?: BillingGate;
  /**
   * Optional description override. Hosted deployments may want
   * different prose than OSS. When unset, the handler uses the OSS
   * default description below.
   */
  readonly description?: string;
  // `mintWsToken` / `runtimeUrl` / `themeId` / `themeMode` /
  // `themeProvider` are inherited from {@link RenderSliceMetaDeps} —
  // shared verbatim with `ggui_render`. (The former
  // `streamWebSocketLocalTools` dep is deleted: the post-update slice
  // is a deliberate props-only SUBSET that never emitted it — the
  // field is mount-time bootstrap data owned by `ggui_render`.)
}

/**
 * Input raw-shape — discriminated on `kind`:
 *
 *   - `kind:'replace'` + `props` — full props replacement. The new
 *     map IS the new state.
 *   - `kind:'merge'` + `patch` — RFC 7396 JSON Merge Patch.
 *
 * Both validate the FINAL props (post-merge for `merge`) against the
 * render's `propsSpec`.
 */
const inputSchema = {
  /**
   * Globally-unique render id. Optional on the wire so an in-process
   * dispatcher (live-channel dispatch / threaded mount) can populate it
   * via `HandlerContext.sessionId` instead. Required at the handler
   * level — see the resolve step inside `handler`.
   */
  sessionId: z.string().optional(),
  /**
   * Mode discriminator. `'replace'` requires `props`; `'merge'`
   * requires `patch`. The narrowing step inside `handler` enforces
   * both presence + mutual exclusion.
   */
  kind: z.enum(['replace', 'merge']),
  /**
   * Full new props map. Required when `kind === 'replace'`; rejected
   * otherwise. Validated against the GguiSession's `propsSpec` after
   * applying.
   */
  props: z.record(z.string(), z.unknown()).optional(),
  /**
   * RFC 7396 JSON Merge Patch. Required when `kind === 'merge'`;
   * rejected otherwise. The handler applies the patch to the existing
   * props, then validates the merged result against `propsSpec`.
   * `null` values in the patch DELETE the corresponding key.
   */
  patch: z.record(z.string(), z.unknown()).optional(),
} as const;

const outputSchema = {
  sessionId: z.string(),
  updated: z.boolean(),
  /**
   * Spec-canonical MCP-Apps entry-point — same `ui://ggui/render/{id}`
   * URI `ggui_render` stamped on the initial mount. Updates carry it
   * too so spec-compliant hosts can re-fetch the resource (returns the
   * SAME shell HTML with refreshed `__GGUI_META__` baked in) and apply
   * the props patch in-place. SDKs that strip `_meta` from tool_results
   * (OpenAI Agents SDK, Google ADK) reach the URI via this LLM-visible
   * field; SDKs that preserve `_meta` also see it on
   * `_meta.ui.resourceUri`.
   */
  resourceUri: z.string(),
} as const;

interface UpdateOutput {
  sessionId: string;
  updated: boolean;
  resourceUri: string;
}

/**
 * Build the OSS `ggui_update` handler. Handler is additive — declared
 * separately from `defaultHandlers` so server composers opt-in via the
 * dedicated `update:` slot (mirrors `handshake:` / `render:`). Servers
 * that don't expose update keep the smaller surface.
 */
export function createGguiUpdateHandler(
  deps: GguiUpdateHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, UpdateOutput> {
  return {
    name: 'ggui_update',
    title: 'Update',
    audience: ['agent'],
    description:
      deps.description ??
      "Refresh the rendered UI with new state. Two modes:  (1) `{sessionId, kind:'replace', props}` — full props replacement; `props` IS the new state. Use when most fields change or you want deterministic restoration.  (2) `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch; send ONLY the delta. Top-level keys merge shallow, nested objects merge recursively, a `null` value DELETES that key, arrays fully replace. Use when one or two fields change (much cheaper for the agent to construct than re-sending all props).  USE THIS TOOL AFTER ANY DOMAIN-TOOL CALL THAT CHANGED DATA THE UI SHOWS — e.g. you handled a `todo_toggle`/`cart_add`/`note_save` event from `ggui_consume`, mutated backend state, and the user is now staring at stale props. Skipping this leaves the iframe frozen on the old state and is the #1 wire bug. Pattern: `consume → domain-tool → ggui_update → loop`. The server fans a `props_update` frame to live subscribers; the mount re-renders WITHOUT losing scroll position, focus, or uncommitted input — far cheaper than re-rendering. Both modes validate the FINAL props (post-merge for `merge`) against the GguiSession's `propsSpec` (when declared) and reject on violation. Mutation ownership: only the GguiSession-creating identity may overwrite.",
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<UpdateOutput> {
      const parsed = z.object(inputSchema).parse(input);

      // Pre-mutation gate. Throws to abort BEFORE any state change.
      // OSS default: no gate bound, no-op. Cloud binds a traffic-class
      // gate here.
      if (deps.billingGate) {
        await deps.billingGate.preCheck({ ctx, tool: 'ggui_update' });
      }

      // Resolve sessionId from wire OR threaded HandlerContext.
      const sessionId: string | undefined =
        parsed.sessionId ?? ctx.sessionId;
      if (!sessionId) {
        throw new GguiSessionNotFoundError(
          '',
          'ggui_update: sessionId is required on the wire (or threaded via HandlerContext for in-process dispatchers).',
        );
      }

      // Tenancy gate. Cross-tenant + missing surface uniformly as
      // GguiSessionNotFoundError so cross-tenant existence is not leaked.
      const stored = await deps.renderStore.get(sessionId);
      if (!stored || stored.appId !== ctx.appId) {
        throw new GguiSessionNotFoundError(sessionId);
      }

      // Devtools payload trace. No-op when no sink is registered.
      // Fires AFTER the tenancy gate so cross-tenant probes never leak
      // into the trace. Payload is the validated wire shape.
      emitPayloadTraceEvent({
        direction: 'outbound-update',
        sessionId,
        appId: ctx.appId,
        tool: 'ggui_update',
        payload: parsed,
      });

      // Narrow on kind. Each branch enforces required-field + mutual-
      // exclusion semantics that the flat raw-shape can't express.
      // Mismatched fields throw before any persistence happens so the
      // caller gets a clean error pre-mutation.
      const kind = parsed.kind;
      let patchInput:
        | { mode: 'replace'; props: JsonObject }
        | { mode: 'merge'; patch: JsonObject };
      if (kind === 'replace') {
        if (parsed.props === undefined) {
          throw new ContractViolationError({
            tool: 'ggui_update',
            violations: [
              {
                code: 'CTR_UPDATE_MISSING_PROPS',
                field: 'props',
                message:
                  'kind:"replace" requires `props` — the full new props map.',
              },
            ],
          });
        }
        if (parsed.patch !== undefined) {
          throw new ContractViolationError({
            tool: 'ggui_update',
            violations: [
              {
                code: 'CTR_UPDATE_MIXED_FIELDS',
                field: 'patch',
                message:
                  'kind:"replace" must not include `patch`. Pick one mode per call.',
              },
            ],
          });
        }
        patchInput = { mode: 'replace', props: parsed.props as JsonObject };
      } else {
        // kind === 'merge'
        if (parsed.patch === undefined) {
          throw new ContractViolationError({
            tool: 'ggui_update',
            violations: [
              {
                code: 'CTR_UPDATE_MISSING_PATCH',
                field: 'patch',
                message:
                  'kind:"merge" requires `patch` — the RFC 7396 JSON Merge Patch delta.',
              },
            ],
          });
        }
        if (parsed.props !== undefined) {
          throw new ContractViolationError({
            tool: 'ggui_update',
            violations: [
              {
                code: 'CTR_UPDATE_MIXED_FIELDS',
                field: 'props',
                message:
                  'kind:"merge" must not include `props`. Pick one mode per call.',
              },
            ],
          });
        }
        patchInput = { mode: 'merge', patch: parsed.patch as JsonObject };
      }

      // applyGguiSessionPatch throws ContractViolationError{tool:'ggui_update'}
      // on propsSpec fail (validated against the FINAL props — post-merge
      // for `merge` mode). Propagates verbatim — transport layer maps.
      //
      // Pull renderTarget from `stored.render` — both ComponentGguiSession and
      // SystemGguiSession satisfy `GguiSessionTarget` (id + optional propsSpec +
      // optional props). McpAppsGguiSession has no propsSpec — the helper's
      // assertPropsContract no-ops on absent spec, so MCP Apps renders
      // accept any patch shape (the iframe owns its own validation).
      const renderTarget: GguiSessionTarget & GguiSession = stored.render;
      const { updatedSession, finalProps } = applyGguiSessionPatch({
        render: renderTarget,
        ...patchInput,
      });

      // Persist via the commit seam — first-write mints, re-write
      // replaces visible-bits in place. Lifecycle fields owned by the
      // store (createdAt, eventSequence, hostSession) preserved across
      // the upsert.
      await deps.renderStore.commit({
        render: updatedSession,
        appId: stored.appId,
        ...(stored.userId !== undefined ? { userId: stored.userId } : {}),
        ...(stored.endUserIdentity !== undefined
          ? { endUserIdentity: stored.endUserIdentity }
          : {}),
        ...(stored.themeId !== undefined ? { themeId: stored.themeId } : {}),
        ...(stored.hostSession !== undefined
          ? { hostSession: stored.hostSession }
          : {}),
      });

      // Best-effort live delivery. Persistence is the source of truth;
      // the live-channel fan-out is a latency optimization. Errors are
      // swallowed — a failed notify must not fail the tool call (the
      // renderer reads canonical state via `ack.render` on next
      // (re)subscribe).
      if (deps.propsUpdateNotifier) {
        try {
          await deps.propsUpdateNotifier.sendPropsUpdate(sessionId, finalProps);
        } catch {
          // Silent: stay aligned with `safelyNotifyGguiSessionCommit`'s
          // posture in render.ts. A throwing notifier is a host-side
          // bug, not a tool-call failure.
        }
      }

      // resourceUri MUST be the SAME URI the initial ggui_render stamped
      // — the iframe is mounted against that URI, and the host's
      // `resources/read` re-fetch (spec-canonical refresh after every
      // update tool_result) returns the fresh shell with new
      // `__GGUI_META__` baked in. Single-segment is sufficient: both
      // single + two-segment URI shapes route to the same handler.
      const resourceUri = `${GGUI_RENDER_UI_META.resourceUri}/${sessionId}`;
      return {
        sessionId,
        updated: true,
        resourceUri,
      };
    },
    /**
     * Emit the `ai.ggui/render` slice mirroring `ggui_render`'s shape
     * but **props-only** (post-2026-05-13 trim). Spec-compliant MCP
     * Apps hosts forward the full `CallToolResult` (including `_meta`)
     * via `ui/notifications/tool-result` postMessage;
     * iframe-runtime's `installPostMountListener` reads the envelope
     * and re-applies the patched props to the live mount WITHOUT a WS
     * round-trip. The WS `props_update` frame remains the first-party
     * fast path; the slice meta is the cross-host fallback.
     *
     * **Why props-only:** update mutates props, not the contract. The
     * iframe is already mounted with code + actionSpec + contextSpec +
     * permissions from its initial render slice meta; those are
     * mount-time invariants. Re-emitting them on every update wasted
     * 5-50KB per call. Today's update slice meta carries only what
     * actually changed (propsJson) plus the auth/identity/runtime
     * fields the cross-host fallback needs to re-bind.
     *
     * Skipped entirely when no propsJson + no minter + no runtimeUrl —
     * keeps the response byte-identical for hosts that don't read
     * `_meta` (the structuredContent reply is the source of truth).
     */
    resultMeta: async (output, _input, ctx) => {
      // Load the just-patched render only to derive the projected
      // propsJson. The other view fields (componentCode / kind /
      // contextSlots / permissionsPolicy / compiledValidators) are
      // mount-time invariants — the initial render already shipped
      // them, and `ggui_update` patches `props` only, never the
      // contract specs.
      let view: RenderMetaView = {};
      let renderThemeId: string | undefined;
      // `lastSequence` — monotonic event-ledger cursor stamped on every
      // emit (R6). Polling clients use it to initialize the /events
      // cursor (R7) aligned with the WS stream.
      let lastSequence: number | undefined;
      try {
        const stored = await deps.renderStore.get(output.sessionId);
        if (stored) {
          lastSequence = stored.eventSequence;
          renderThemeId = stored.themeId;
          view = deriveRenderMeta(stored.render);
          if (
            stored.render.type !== 'mcpApps' &&
            stored.render.type !== 'system'
          ) {
            renderThemeId =
              (stored.render as ComponentGguiSession).themeId ?? renderThemeId;
          }
        }
      } catch {
        // Silent — slice meta stays minimal on lookup failure.
      }

      // Nothing to emit ⇒ no _meta at all.
      if (
        view.propsJson === undefined &&
        !deps.mintWsToken &&
        deps.runtimeUrl === undefined
      ) {
        return undefined;
      }

      // Shared `ai.ggui/render` envelope base — runtimeUrl resolution,
      // minted-trio `token`→`wsToken` remap, and the 3-layer theme
      // resolution (liveTheme > render > deps.themeId) all live in ONE
      // helper shared with `ggui_render`.
      const {
        runtimeUrl,
        authFields,
        themeId: resolvedThemeId,
        themeMode: resolvedThemeMode,
      } = assembleRenderSliceBase(deps, {
        sessionId: output.sessionId,
        appId: ctx.appId,
        renderThemeId,
      });

      const render: McpAppAiGguiRenderMeta = {
        sessionId: output.sessionId,
        appId: ctx.appId,
        runtimeUrl,
        ...authFields,
        ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
        ...(resolvedThemeMode !== undefined
          ? { themeMode: resolvedThemeMode }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
        ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
      };
      return toMcpAppEnvelope(render);
    },
  };
}
