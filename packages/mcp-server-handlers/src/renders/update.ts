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
import type {
  GguiSessionStore,
  RenderIdentityStore,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { refreshRenderIdentity } from './render-identity.js';
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
  /**
   * Mount-identity intent (#482). Omitted/false (the tool's essential
   * semantic): this update targets the ALREADY-MOUNTED UI — the result
   * carries the props-only forwarding slice and no host mount pointer,
   * so hosts that mint per-result views mint nothing. `true`: the
   * result is a fresh, self-sufficient render at this point in the
   * conversation — full bootable mount package (#481) + `_meta.ui`
   * mount pointer.
   */
  renderAsNew: z.boolean().optional(),
} as const;

/**
 * Canonical JSON stringify — object keys sorted recursively so two
 * semantically-equal JsonObjects compare equal regardless of key
 * insertion order. Arrays keep positional order (order is meaning
 * there). Used by the no-op gate; props are validated JsonObjects, so
 * no cycles by construction.
 */
function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

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
  /**
   * Present ONLY on a no-op: the patch validated and conformed but
   * left props identical to the current state, so nothing was written
   * and nothing changes on screen. Model-visible by design — the
   * common producer of a no-op is an LLM echoing existing props back,
   * and this is its only feedback channel.
   */
  warning: z.string().optional(),
} as const;

interface UpdateOutput {
  sessionId: string;
  updated: boolean;
  resourceUri: string;
  warning?: string;
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
    _meta: {
      // MCP-Apps UI binding — REQUIRED for result delivery, not just
      // entry-point visibility. Live claude.ai evidence (2026-08-11,
      // #471 round-2 retest): hosts forward a tool's results to the
      // mounted iframe only when the tool's DECLARATION carries the
      // UI binding; without it, every ggui_update landed server-side
      // and the iframe never repainted. Same template as ggui_render
      // (one UI, two tools that feed it) — this revises the render.ts
      // §2.4.1 "exactly one tool" entry-point lock, see the note
      // there.
      ui: GGUI_RENDER_UI_META,
    },
    audience: ['agent'],
    description:
      deps.description ??
      "Refresh the rendered UI with new state. Two modes:  (1) `{sessionId, kind:'replace', props}` — full props replacement; `props` IS the new state. Use when most fields change or you want deterministic restoration.  (2) `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch; send ONLY the delta. Top-level keys merge shallow, nested objects merge recursively, a `null` value DELETES that key, arrays fully replace. Use when one or two fields change (much cheaper for the agent to construct than re-sending all props).  USE THIS TOOL AFTER ANY DOMAIN-TOOL CALL THAT CHANGED DATA THE UI SHOWS — e.g. you handled a `todo_toggle`/`cart_add`/`note_save` event from `ggui_consume`, mutated backend state, and the user is now staring at stale props. Skipping this leaves the iframe frozen on the old state and is the #1 wire bug. Pattern: `consume → domain-tool → ggui_update → loop`. The server fans a `props_update` frame to live subscribers; the mount re-renders WITHOUT losing scroll position, focus, or uncommitted input — far cheaper than re-rendering. Both modes validate the FINAL props (post-merge for `merge`) against the GguiSession's `propsSpec` (when declared) and reject on violation. Mutation ownership: only the GguiSession-creating identity may overwrite.  `renderAsNew` (optional): by DEFAULT the update repaints the mounted card in place and adds NOTHING new to the conversation — in consume/gesture loops OMIT it. Pass `renderAsNew: true` ONLY when the updated state deserves its own fresh card at this point in the conversation (a milestone result, or the original card is no longer visible/usable); the result then mounts as a new self-contained card.",
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<UpdateOutput> {
      // Strict: in-process dispatchers face exactly the protocol
      // contract (unknown keys reject, as `updateInputSchema` does). On
      // the MCP wire path this is a no-op by construction — the SDK's
      // own arg validation strips unknown keys before the handler runs.
      const parsed = z.object(inputSchema).strict().parse(input);

      // Narrow on kind FIRST. Each branch enforces required-field +
      // mutual-exclusion semantics that the flat raw-shape can't
      // express. Runs before the billing gate and before any store
      // read, so a malformed call costs nothing: no gate evaluation,
      // no DynamoDB read, no trace emission — and the caller gets the
      // contract error rather than whatever the gate would have said.
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

      // Mount-URI identity (#471 round-4 live finding): `ggui_render`
      // stamped `.../<sessionId>/<contractKey>` as the mounted iframe's
      // resource URI. Hosts that key result→iframe routing on URI
      // equality only deliver this update's result to the live card
      // when the update reproduces that EXACT URI — a bare
      // `.../<sessionId>` routes fine on OUR server but is a different
      // string to the host, so the forwarded result misses the mount
      // and the card never repaints. The contract key cannot be
      // recomputed from the render row (it hashes the handshake-agreed
      // contract — see render-identity.ts); read it from the durable
      // identity record. Absent store/record ⇒ bare session URI
      // (pre-identity renders keep the old shape).
      let contractSegment = '';
      if (deps.renderIdentityStore) {
        try {
          const identity = await deps.renderIdentityStore.get(sessionId);
          if (identity?.contractKey) {
            contractSegment = `/${identity.contractKey}`;
          }
        } catch {
          // Best-effort, matching every identity-store touch in this
          // handler: a failed read must not fail the tool call, and the
          // bare URI below stays routable on our server.
        }
      }
      const mountResourceUri = `${GGUI_RENDER_UI_META.resourceUri}/${sessionId}${contractSegment}`;

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

      // No-op gate (#471 round-3 live finding): a CONFORMING patch that
      // leaves the final props semantically identical to the current
      // state is almost always an agent error — the live failure mode
      // was an LLM echoing the card's existing props back (believing it
      // had "switched" the UI) and telling the user the card changed
      // while nothing on screen could. The contract validated it, the
      // commit would apply it, and no signal existed anywhere. Make the
      // non-change OBSERVABLE instead of silently committing: skip the
      // write + fan-out (there is nothing to deliver) and return an
      // honest `updated: false` with a model-visible warning telling
      // the agent what to do instead.
      const priorProps =
        'props' in renderTarget && renderTarget.props !== undefined
          ? (renderTarget.props as JsonObject)
          : {};
      if (stableStringify(finalProps) === stableStringify(priorProps)) {
        return {
          sessionId,
          updated: false,
          resourceUri: mountResourceUri,
          warning:
            'NO-OP: this patch left the props identical to the current state — nothing changed on screen. If you meant to refresh the UI, send values that actually differ; if the user’s gesture asks for a DIFFERENT surface (menu selection, navigation), run ggui_handshake + ggui_render for the next UI instead of updating this one.',
        };
      }

      // Persist via the commit seam — first-write mints, re-write
      // replaces visible-bits in place. Lifecycle fields owned by the
      // store (createdAt, eventSequence, hostSession) preserved across
      // the upsert.
      const committed = await deps.renderStore.commit({
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

      // Ledger append — the delivery substrate for the PULL rungs of
      // the failover ladder (HTTP `/events` polling and the
      // `ggui_runtime_pull` bridge rung read ONLY the event ledger).
      // Without this append a props update is invisible to every
      // cursor-based reader: live evidence (#471 round-3 forensics)
      // showed eventSequence stuck at 0 across real updates — pull
      // clients would poll politely forever and receive nothing.
      // Best-effort: persistence already succeeded, and the push
      // planes (WS/SSE fan-out, forwarded tool-result slice) deliver
      // independently of the ledger.
      let committedForIdentity = committed;
      try {
        // `'ui.updated'` is the canonical LEDGER taxonomy name; the
        // live-channel FRAME namespace calls the same thing
        // `props_update`. The translation lives at the client parse
        // core (events-polling), never here — the ledger speaks only
        // taxonomy types.
        const seq = await deps.renderStore.appendEvent({
          sessionId,
          type: 'ui.updated',
          data: { sessionId, props: finalProps },
        });
        // The append advanced the row's high-water mark past the
        // commit-time snapshot — thread the returned seq so the
        // identity refresh records the ledger state INCLUDING this
        // update's own event (record.seqAtLastCommit tracks the row).
        committedForIdentity = { ...committed, eventSequence: seq };
      } catch {
        // Silent — a ledger hiccup must not fail the tool call; the
        // pull rungs degrade to the ack/mount snapshot on next
        // (re)subscribe, same recovery every reader already has.
      }

      // Keep the durable identity record's view of this row current.
      // Reads the row the commit RETURNED (seq-adjusted above) so the
      // record can't disagree with what was persisted.
      await refreshRenderIdentity(deps.renderIdentityStore, committedForIdentity);

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
      // (key-suffixed via `mountResourceUri` above) — the iframe is
      // mounted against that URI, and hosts route both the forwarded
      // tool result AND the spec-canonical `resources/read` re-fetch by
      // matching it.
      return {
        sessionId,
        updated: true,
        resourceUri: mountResourceUri,
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
     * **Two shapes, keyed on `renderAsNew` (#482):** by default
     * (omitted/false) the result carries NO `_meta` at all — the only
     * shape live-proven (2026-08-12) to make claude.ai mint no
     * per-result view; the already-mounted frame repaints via its
     * live rungs. `renderAsNew: true` declares the result a fresh
     * render at this point in the conversation — it then carries the
     * FULL bootable mount package (#481) + the `_meta.ui` mount
     * pointer, because a frame booted from this envelope must be
     * self-sufficient: the 2026-05-13 props-only trim dropped
     * `contextSlots` and every update-minted view of a contextSpec
     * contract crashed at boot (`useGguiContext('draftText'): no
     * Context registered`).
     *
     * Skipped entirely when no propsJson + no minter + no runtimeUrl —
     * keeps the response byte-identical for hosts that don't read
     * `_meta` (the structuredContent reply is the source of truth).
     */
    resultMeta: async (output, input, ctx) => {
      // Default (renderAsNew omitted/false): NO `_meta` at all. Live
      // probing (2026-08-12, #482) showed claude.ai mints a per-result
      // view whenever a UI-bound tool's SUCCESS result carries
      // `_meta` — dropping just the `ui` mount pointer was not enough,
      // and the minted forwarding-slice view crashed at boot. The only
      // result shape PROVEN to mint nothing is the no-`_meta` shape
      // (error results share it). Cost, accepted deliberately: the
      // spec `ui/notifications/tool-result` forwarding fallback is
      // sacrificed on default updates — the mounted frame's repaint
      // rides the live rungs, whose terminal bridge-pull rung exists
      // on every MCP host by construction (tools/call is universal).
      if (input.renderAsNew !== true) return undefined;
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
        channelUrls,
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
        // Token-bearing HTTP fallback rungs (pollingUrl + sseUrl) —
        // same ONE-helper composition as `ggui_render`, so the two
        // tools' stamping cannot drift.
        ...channelUrls,
        ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
        ...(resolvedThemeMode !== undefined
          ? { themeMode: resolvedThemeMode }
          : {}),
        ...(lastSequence !== undefined ? { lastSequence } : {}),
        ...(view.propsJson !== undefined ? { propsJson: view.propsJson } : {}),
        ...(view.codeB64 !== undefined ? { codeB64: view.codeB64 } : {}),
        // Mount-time view fields (#481) — this envelope only exists on
        // the `renderAsNew: true` branch (see the guard above), so the
        // full bootable package is unconditional here. Spread shapes
        // mirror `ggui_render`'s emitter exactly.
        ...(view.contextSlots !== undefined
          ? { contextSlots: [...view.contextSlots] }
          : {}),
        ...(view.permissionsPolicy !== undefined
          ? { permissionsPolicy: [...view.permissionsPolicy] }
          : {}),
        ...(view.theme !== undefined ? { theme: view.theme } : {}),
        ...(view.gadgets !== undefined && view.gadgets.length > 0
          ? { gadgets: view.gadgets }
          : {}),
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
