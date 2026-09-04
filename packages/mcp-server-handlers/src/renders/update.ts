/**
 * `ggui_update` — handler for props mutation on an existing render.
 *
 * `sessionId` arrives on the wire input today, but a future caller
 * dispatching this handler in-process from the live channel can
 * populate the canonical `HandlerContext.sessionId` field instead; the
 * handler reads either source.
 *
 * Wire input — the NORMATIVE contract is `updateInputSchema` in
 * `@ggui-ai/protocol` (strict discriminated union, `sessionId` required
 * on both arms; SPEC.md §7.1.2):
 *   - `{sessionId, kind:'replace', props}` — full props replacement.
 *   - `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch.
 *
 * This handler's `inputSchema` is NOT that union — it is the flat
 * tool-facing projection of it, and the difference is structural, not
 * drift: MCP tool registration takes a `ZodRawShape` (a flat map of
 * fields), which cannot express a top-level discriminated union. The
 * handler therefore re-imposes the union semantics imperatively (the
 * narrowing step below), so the ACCEPTED language is the same. Two
 * declared, tested tolerances — see
 * `update-input-alignment.contract.test.ts`, which mechanizes this
 * paragraph:
 *   - `sessionId` is optional on the flat shape ONLY so an in-process
 *     dispatcher can thread it via `HandlerContext.sessionId` (the
 *     carve-out above). Absent from both places → not-found error.
 *   - Unknown keys: the MCP SDK transport parses args non-strictly and
 *     STRIPS unknown keys before this handler runs, so wire callers get
 *     tolerant-reader behavior. The handler's own parse is strict, so
 *     in-process dispatchers face exactly the protocol contract.
 *
 * Pure render-mutation flow:
 *   1. Parse the flat shape (strict), then narrow the union — surface
 *      "wrong fields for this kind" before the gate and before any
 *      tenant work, so a malformed call costs zero store reads and zero
 *      gate evaluations.
 *   2. Pre-mutation `billingGate.preCheck` (cloud traffic-class gate).
 *   3. Load + tenancy-gate the render via `renderStore.get` + `appId` cmp.
 *   4. Apply patch via the shared `applyGguiSessionPatch` helper:
 *      - throws `ContractViolationError{tool:'ggui_update'}` on schema fail
 *   5. Persist the updated render via `renderStore.commit(...)` (upserts
 *      by `render.id`, preserves lifecycle).
 *   6. Best-effort live delivery via the optional `propsUpdateNotifier`
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
import {
  ContractViolationError,
  updateOutputSchema,
  type ComponentGguiSession,
  type GguiUpdateOutput,
  type JsonObject,
} from '@ggui-ai/protocol';
import {
  GGUI_RENDER_UI_META,
  composeEpochUri,
  toMcpAppEnvelope,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  GguiSessionStore,
  RenderIdentityStore,
  TelemetrySink,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  assembleRenderSliceBase,
  deriveRenderMeta,
  withResolvedThemeBase,
  spreadRenderMetaViewOntoSlice,
  type RenderMetaView,
  type RenderSliceMetaDeps,
} from './slice-meta-derivation.js';
import { GguiSessionNotFoundError } from './errors.js';
import { type PayloadTraceSink } from './payload-trace-sink.js';
import {
  mutationInputSchema,
  runPropsMutation,
} from './props-mutation-core.js';

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
 *
 * `epoch` is the history epoch of the commit this frame carries —
 * `ggui_update` fans its freshly-advanced epoch, `ggui_amend` fans the
 * unchanged head. The notifier MUST put it on the `props_update`
 * payload verbatim: it is the freeze-latch signal (#483) that tells a
 * lower-epoch mount it has been superseded. The mutation core passes
 * the commit-time value so implementations never re-read the row (a
 * re-read races a concurrent update and can stamp an amend's frame
 * with a newer epoch, freezing the live head it belongs to).
 */
export interface PropsUpdateNotifier {
  sendPropsUpdate(
    sessionId: string,
    props: JsonObject,
    epoch: number,
  ): Promise<void>;
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
 * As of ggui#386 (2026-07-27) no first-party deployment binds a gate on
 * update — ggui_update performs no generation and no charge, so cloud's
 * former Phase-3c traffic gate here was a category error and was
 * deleted. The seam stays: it is the documented extension point for any
 * deployment that DOES want a pre-mutation policy on update, and the
 * alignment contract test uses it to pin that malformed input rejects
 * before the gate ever runs.
 */
export interface BillingGate {
  preCheck(input: {
    readonly ctx: HandlerContext;
    /**
     * Which tool the gate is firing for. Lets a single gate impl run
     * different policies per call-site (e.g. update is free / render
     * triggers a credit charge).
     */
    readonly tool: 'ggui_update' | 'ggui_amend' | 'ggui_render';
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
  /**
   * Devtools payload-trace sink (ggui#605): rides the DEPS so the
   * registrar (mcp-server console wiring) and this package's emitters
   * meet on a call path — never cross-package module-global state
   * (the split-module-instance dark-sink class, #604). Absent = the
   * zero-cost unwired hot path.
   */
  readonly payloadTraceSink?: PayloadTraceSink;
  /** GguiSession-backing store. Used to load + persist the patched render. */
  readonly renderStore: GguiSessionStore;
  /**
   * Durable render-identity side store. When present, a successful
   * patch refreshes the existing record's view of the row it just
   * re-committed — props, the sequence at that commit, and the
   * freshness stamp. The identity itself (`blueprintId`,
   * `contractKey`, `variantKey`) is carried forward untouched; this
   * tool never sees the agreed contract those keys were derived from,
   * so it is in no position to recompute them.
   *
   * A render with no record yet (store wired after it was rendered) is
   * skipped, not synthesized. Writes are best-effort and can never
   * fail the patch. Absent = no refresh, everything else unchanged.
   */
  readonly renderIdentityStore?: RenderIdentityStore;
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
   * Operational-signal sink for mutation-time contract-violation
   * events (`render.contract_violation` with `tool: 'ggui_update' |
   * 'ggui_amend'` — see `render-telemetry.ts`). Update-time
   * violations are the same failure class the render-time events
   * measure; baselining one without the other hides half the
   * surface. Lossy + non-throwing per the {@link TelemetrySink}
   * contract; absent dep = noop.
   */
  readonly telemetrySink?: TelemetrySink;
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

// Wire grammar + the mutation flow live in the shared core (#483):
// `mutationInputSchema` is the flat raw-shape BOTH tools declare, and
// `runPropsMutation` is the single resolve→gate→validate→patch→
// persist→ledger→fan flow, parameterized on the tool.
const inputSchema = mutationInputSchema;

/**
 * Canonical wire output shape — pulled from `@ggui-ai/protocol`'s
 * `updateOutputSchema`, the same way `ggui_render` pulls
 * `renderOutputSchema`. `.shape` unpacks the zod object back to a
 * field-record for SharedHandler's type-level inference and for MCP
 * registration (the spec requires the declared `Tool.outputSchema`
 * root to be a JSON Schema of type `object`).
 *
 * No `outputEnvelopeSchema`: unlike `renderOutputSchema` this schema
 * carries no cross-field refinement, so rebuilding `z.object(shape)`
 * at the transport reproduces it exactly. There is nothing a composed
 * schema would enforce that the raw shape does not.
 *
 * The field docs — including the `.describe()` strings an agent reads
 * out of `tools/list` — live on the schema in `@ggui-ai/protocol`.
 * They are deliberately NOT restated here: this used to be a parallel
 * declaration, and a docstring saying "must not drift" was the only
 * thing binding the two (ggui#798).
 */
const outputSchema = updateOutputSchema.shape;

/**
 * Build the OSS `ggui_update` handler. Handler is additive — declared
 * separately from `defaultHandlers` so server composers opt-in via the
 * dedicated `update:` slot (mirrors `handshake:` / `render:`). Servers
 * that don't expose update keep the smaller surface.
 */
export function createGguiUpdateHandler(
  deps: GguiUpdateHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiUpdateOutput> {
  return {
    name: 'ggui_update',
    title: 'Update',
    _meta: {
      // MCP-Apps UI binding — ggui_update is a RENDERING tool (#483):
      // every real update mints a new history card, and hosts mint
      // per-result views for UI-bound tools' `_meta`-carrying results.
      // (The 2026-08-11 claim that the binding was REQUIRED for
      // repaint delivery is superseded: rounds 13-16 proved mounted
      // frames repaint over the live rungs with no result `_meta` at
      // all — that in-place path now belongs to ggui_amend, which
      // deliberately carries NO binding.) Same template as
      // ggui_render — this revises the render.ts §2.4.1 "exactly one
      // tool" entry-point lock, see the note there.
      ui: GGUI_RENDER_UI_META,
    },
    audience: ['agent'],
    description:
      deps.description ??
      "Render the session's updated state as a NEW card in the conversation — a new history entry. The history number (epoch) advances by one and the previous card becomes a frozen history record; use this for state milestones worth showing in the transcript, or when the original card is no longer visible or usable. For an IN-PLACE repaint of the card the user is already looking at (the common consume → domain-tool → repaint loop), use ggui_amend instead — it changes the same card quietly and adds nothing to the conversation.  Two mutation modes:  (1) `{sessionId, kind:'replace', props}` — full props replacement; `props` IS the new state. Use when most fields change or you want deterministic restoration.  (2) `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch; send ONLY the delta. Top-level keys merge shallow, nested objects merge recursively, a `null` value DELETES that key, arrays fully replace.  Both modes validate the FINAL props (post-merge for `merge`) against the GguiSession's `propsSpec` (when declared) and reject on violation. Mutation ownership: only the GguiSession-creating identity may overwrite.",
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<GguiUpdateOutput> {
      // Shared mutation core (#483) — 'ggui_update' advances the
      // history epoch and mints a new record; the pinned URI is
      // composed here from the core's bare mount URI.
      const r = await runPropsMutation(deps, 'ggui_update', input, ctx);
      return {
        sessionId: r.sessionId,
        updated: r.updated,
        resourceUri: r.updated
          ? composeEpochUri(r.mountResourceUri, r.epoch)
          : r.mountResourceUri,
        epoch: r.epoch,
        ...(r.warning !== undefined ? { warning: r.warning } : {}),
        ...(r.propsSchemaHash !== undefined
          ? { propsSchemaHash: r.propsSchemaHash }
          : {}),
        ...(r.propsSchemaProfile !== undefined
          ? { propsSchemaProfile: r.propsSchemaProfile }
          : {}),
      };
    },
    /**
     * Result-`_meta` emitter for `ggui_update`.
     *
     * **Two shapes, keyed on `updated` (#483):** every REAL update
     * (`updated: true`) mints a new history record, so its result
     * carries the FULL bootable mount package (#481) + the
     * `_meta.ui` mount pointer with the epoch-PINNED resourceUri —
     * a frame booted from this envelope must be self-sufficient:
     * the 2026-05-13 props-only trim dropped `contextSlots` and
     * every update-minted view of a contextSpec contract crashed at
     * boot (`useGguiContext('draftText'): no Context registered`).
     * A NO-OP (`updated: false`) mints nothing and carries NO
     * `_meta` at all — the only shape live-proven (2026-08-12) to
     * make claude.ai mint no per-result view. The in-place repaint
     * path (never any `_meta`) is `ggui_amend`'s.
     *
     * Skipped entirely when no propsJson + no minter + no runtimeUrl —
     * keeps the response byte-identical for hosts that don't read
     * `_meta` (the structuredContent reply is the source of truth).
     */
    resultMeta: async (output, _input, ctx) => {
      // No-op (#483): nothing was written, no record was minted — a
      // result with `_meta` would make hosts mint a card duplicating
      // the head (hosts mint per-result views from ANY `_meta` on a
      // UI-bound success result — live-proven 2026-08-12). No `_meta`
      // is the only proven mint-nothing shape.
      if (!output.updated) return undefined;
      // Load the just-patched render and derive the FULL projected
      // view — the same `deriveRenderMeta` projection `ggui_render`
      // emits, so an update-minted frame boots identically to a
      // render-minted one (contextSlots, permissions, theme, gadgets,
      // kind, codeB64 all ride along; see the emitter docstring).
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
          view = await withResolvedThemeBase(
            deriveRenderMeta(stored.render),
            deps,
            ctx.appId,
          );
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
        channelUrls,
        themeId: resolvedThemeId,
        themeMode: resolvedThemeMode,
      } = assembleRenderSliceBase(deps, {
        sessionId: output.sessionId,
        appId: ctx.appId,
        renderThemeId,
        // ggui#589 — the session theme's own mode, from the SAME
        // projection that emits the `theme` object on this envelope.
        sessionThemeMode: view.theme?.mode,
      });

      const render: McpAppAiGguiRenderMeta = {
        sessionId: output.sessionId,
        appId: ctx.appId,
        runtimeUrl,
        ...authFields,
        // Token-bearing HTTP fallback rungs (pollingUrl + sseUrl) —
        // same ONE-helper composition as `ggui_render`, so the two
        // tools' stamping cannot drift.
        ...channelUrls,
        ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
        ...(resolvedThemeMode !== undefined
          ? { themeMode: resolvedThemeMode }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
        // State + policy view fields (incl. the #483 freeze-latch
        // self-epoch) — ONE shared spread so this emitter cannot drift
        // from ggui_render / the shell / the /state route.
        ...spreadRenderMetaViewOntoSlice(view),
        // Mode discriminators stay site-local (mutual-exclusion logic
        // differs per transport).
        ...(view.codeB64 !== undefined ? { codeB64: view.codeB64 } : {}),
        ...(view.kind ? { kind: view.kind } : {}),
      };
      // `_meta.ui.resourceUri` is the host-facing mount pointer — the
      // spec key hosts read to mint a view for this result AND to
      // route the forwarded result by URI equality.
      return {
        ...toMcpAppEnvelope(render),
        ui: { resourceUri: output.resourceUri },
        'ui/resourceUri': output.resourceUri,
      };
    },
  };
}
