/**
 * `ggui_update` — handler for props mutation on an existing stack
 * item.
 *
 * `sessionId` / `stackItemId` arrive on the wire input today, but a
 * future caller dispatching this handler in-process from the live
 * channel can populate the canonical `HandlerContext` fields
 * instead; the handler reads either source.
 *
 * Wire input (matches `updateInputSchema` in `@ggui-ai/protocol`):
 *
 *   1. Direct fast-path:    `{ sessionId, stackItemId, patch }`
 *      The agent knows the target. `patch` is the FULL new props for
 *      that stack item — not a deep-merge.
 *
 *   2. Handshake-paired:    `{ handshakeId, patch }`
 *      Negotiator decided what to update via a prior `ggui_handshake`.
 *      This branch is rejected today with a clear pointer to the
 *      direct path, because the default handshake handler stamps
 *      `action: 'create'` until a real negotiator is bound. The
 *      branch stays declared so the wire input shape passes through
 *      unchanged — no parallel schema, no silent drop.
 *
 * Pure stack mutation flow:
 *   1. Validate union — surface "neither arm matched" before tenant work.
 *   2. Load + tenancy-gate the session via `sessionStore.get` + `appId` cmp.
 *   3. Apply patch via the shared `applyStackItemPatch` helper:
 *      - throws `StackItemNotFoundError` when stackItemId isn't in the stack
 *      - throws `ContractViolationError{tool:'ggui_update'}` on schema fail
 *   4. Persist the updated stack via `sessionStore.appendStackItem` (the
 *      seam upserts by `entry.id`, preserving stack position — see
 *      `SessionStore.appendStackItem` JSDoc for the upsert contract).
 *   5. Best-effort live delivery via the optional `propsUpdateNotifier`
 *      seam (closure forwarded by the host onto
 *      `SessionChannelServer.sendPropsUpdate`). Failures are swallowed —
 *      the persistence write is the source of truth, the WS push is a
 *      latency optimization.
 *
 * What this handler does NOT do:
 *   - Real handshake-paired execution. Wired but rejected today;
 *     lands when a negotiator that can produce update-action
 *     decisions is bound.
 *   - Connection-id management. The standalone server uses
 *     live-channel fan-out; a cloud deployment's connection-id and
 *     stale-connection cleanup stay deployment-specific.
 *   - Billing / traffic-class gates. The standalone server is
 *     single-tenant by default; a cloud deployment layers its own
 *     gates on top.
 */
import { z } from 'zod';
import {
  ContractViolationError,
  type JsonObject,
  type SessionStackEntry,
} from '@ggui-ai/protocol';
import {
  MCP_APP_AI_GGUI_SESSION_META_KEY,
  MCP_APP_AI_GGUI_AUTH_META_KEY,
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  splitBootstrapMeta,
  type GguiBootstrapMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  applyStackItemPatch,
  type StackItemTarget,
} from './apply-stack-item-patch.js';
import {
  deriveStackItemBootstrapView,
  type StackItemBootstrapView,
} from './bootstrap-meta-derivation.js';
import { StackItemNotFoundError, SessionNotFoundError } from './errors.js';
import { emitPayloadTraceEvent } from './payload-trace-sink.js';

/**
 * Live-subscriber props-update notifier. The mcp-server's
 * `SessionChannelServer.sendPropsUpdate` implements this contract; the
 * handler depends on the narrowed shape so the handlers package doesn't
 * take a peer dep on the full session-channel surface.
 *
 * Mirrors the {@link import('./push.js').ChannelNotifier} shape, narrowed
 * to the props_update wire frame ggui_update produces. Hosts without a
 * session channel leave this absent — the persistence write still
 * commits, the live frame just isn't fanned.
 *
 * `Promise<void>` matches the underlying channel impl's signature; the
 * handler awaits to surface unexpected errors via the structured logger
 * (best-effort delivery; thrown errors in the seam don't fail the tool
 * call).
 */
export interface PropsUpdateNotifier {
  sendPropsUpdate(
    sessionId: string,
    stackItemId: string,
    props: JsonObject,
  ): Promise<void>;
}

/**
 * Thrown when ggui_update can't honor the requested shape — e.g. session
 * not found, cross-tenant access attempt, malformed stack row, or the
 * handshake-paired branch hits the OSS no-negotiator-bound surface.
 *
 * Distinct from `StackItemNotFoundError` (page id missing within an existing
 * session) and `ContractViolationError` (props validation fail). The
 * transport layer projects these three to distinct MCP error envelopes.
 */
export class UpdateUnsupportedError extends Error {
  readonly code = 'update_unsupported' as const;
  constructor(message: string) {
    super(message);
    this.name = 'UpdateUnsupportedError';
  }
}

/** Re-exported for callers that prefer to import the error from this module. */
export { StackItemNotFoundError, SessionNotFoundError, ContractViolationError };

/**
 * Pre-mutation gate. The handler invokes `preCheck` before any state
 * change. Throwing aborts the call with the error verbatim — the gate
 * implementor owns the typed error shape (cloud's `PushForbiddenError`
 * carrying a structured envelope; OSS deployments leave the gate
 * unbound and skip the check entirely).
 *
 * Cloud's traffic-class gate (kind=user vs kind=app vs playground vs
 * PUSH_ALLOW_NON_PLAYGROUND env override) plugs in here instead of
 * cloud's update.ts owning its own gate. The same interface is used
 * for kind-aware billing pre-checks (BYOK + credit pool) on push.
 */
export interface BillingGate {
  preCheck(input: {
    readonly ctx: HandlerContext;
    /**
     * Which tool the gate is firing for. Lets a single gate impl run
     * different policies per call-site (e.g. update is free / push
     * triggers a credit charge).
     */
    readonly tool: 'ggui_update' | 'ggui_push';
  }): Promise<void> | void;
}

/**
 * Deps for the OSS `ggui_update` handler. Mirrors `GguiPushHandlerDeps`
 * shape — a small narrow seam set, all optional parts marked as such.
 */
export interface GguiUpdateHandlerDeps {
  /** Session-backing store. Used to load + persist the patched stack. */
  readonly sessionStore: SessionStore;
  /**
   * Optional live-subscriber notifier. When present, every successful
   * persistence fans a `{type:'props_update', payload:{stackItemId, props}}`
   * live-channel frame to live subscribers via the seam. Forwarded as-is
   * to {@link PropsUpdateNotifier.sendPropsUpdate}.
   *
   * Hosts without a session channel leave this absent — the
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
  /**
   * Bootstrap-credential minter mirroring `GguiPushHandlerDeps.mintBootstrap`.
   * When set, the handler's `resultMeta` emits `_meta.ggui.bootstrap`
   * carrying the live trio (`wsUrl` + `token` + `expiresAt`) for the
   * post-patch stack item. MCP Apps hosts that forward the full
   * `CallToolResult` (including `_meta`) via `ui/notifications/tool-result`
   * postMessage can re-apply the patched props to a still-mounted iframe
   * WITHOUT the iframe re-subscribing — same single-source-of-truth
   * derivation `ggui_push` uses, just sourced from the patched item.
   *
   * Absent = no `_meta` on update results (matches the legacy posture).
   * Persistence + the live-channel `props_update` fan-out still fire; only
   * the spec-compliant postMessage fallback path is unwired.
   */
  readonly mintBootstrap?: (
    sessionId: string,
    appId: string,
  ) => { wsUrl: string; token: string; expiresAt: string };
  /**
   * Iframe-runtime bundle URL forwarded onto `_meta.ggui.bootstrap.runtimeUrl`.
   * Required-when-set-with-mintBootstrap; absent + minter absent = no
   * bootstrap envelope at all (no field to populate). Mirrors
   * {@link GguiPushHandlerDeps.runtimeUrl}.
   */
  readonly runtimeUrl?: string | (() => string | undefined);
  /** Theme preset id forwarded onto `_meta.ggui.bootstrap.themeId`. */
  readonly themeId?: string;
  /** Theme mode forwarded onto `_meta.ggui.bootstrap.themeMode`. */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Live theme getter (overrides static `themeId`/`themeMode` per-update).
   * Lets a console "Save to ggui.json" reach the next update without a
   * server restart. Same closure pattern `ggui_push` uses.
   */
  readonly themeProvider?: () => {
    readonly id?: string;
    readonly mode?: 'light' | 'dark';
  } | undefined;
  /**
   * Returns the names of registered tools whose `_meta.ui.visibility`
   * includes `"app"`. Forwarded onto `bootstrap.appCallableTools` so the
   * iframe-runtime can resolve pattern α (direct tools/call) vs pattern β
   * (3-message bridge) per wired action — same posture push uses.
   */
  readonly appCallableTools?: () => readonly string[];
  /**
   * Resolver for the bootstrap field `streamWebSocketLocalTools`.
   * Mirrors push's resolver so the post-update bootstrap envelope agrees
   * with what the iframe-runtime saw on initial mount.
   */
  readonly streamWebSocketLocalTools?: () => readonly string[] | undefined;
}

/**
 * Input raw-shape — discriminated on `kind`:
 *
 *   - `kind:'replace'` + `props` — full props replacement. The new
 *     map IS the new state.
 *   - `kind:'merge'` + `patch` — RFC 7396 JSON Merge Patch. Top-level
 *     keys merge shallow, nested objects merge recursively, `null`
 *     value deletes the key, arrays fully replace.
 *
 * Both validate the FINAL props (post-merge for `merge`) against the
 * stack item's `propsSpec`.
 *
 * MCP tool input is declared as a flat raw-shape (per SharedHandler
 * contract). The kind discrimination + per-kind field requirement is
 * enforced inside the handler — see the narrowing step. The wire
 * envelope is the discriminated union from
 * `@ggui-ai/protocol`'s `updateInputSchema`.
 */
const inputSchema = {
  /**
   * Globally-unique stack-item id. Optional on the wire so an
   * in-process dispatcher (live-channel dispatch / threaded mount) can
   * populate it via `HandlerContext.stackItemId` instead. Required at
   * the handler level — see the resolve step inside `handler`.
   */
  stackItemId: z.string().optional(),
  /**
   * Mode discriminator. `'replace'` requires `props`; `'merge'`
   * requires `patch`. The narrowing step inside `handler` enforces
   * both presence + mutual exclusion.
   */
  kind: z.enum(['replace', 'merge']),
  /**
   * Full new props map. Required when `kind === 'replace'`; rejected
   * otherwise. Validated against the stack item's `propsSpec` after
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
  stackItemId: z.string(),
  updated: z.boolean(),
} as const;

type UpdateOutput = {
  /**
   * Internal-only — kept on the TS type because resultMeta needs the
   * session for its bootstrap projection. Stripped by zod before
   * structuredContent serializes (same pattern as push.ts).
   */
  sessionId: string;
  stackItemId: string;
  updated: boolean;
};

/**
 * Build the OSS `ggui_update` handler. Handler is additive — declared
 * separately from `defaultHandlers` so server composers opt-in via the
 * dedicated `update:` slot (mirrors `handshake:` / `push:`). Servers
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
      "Refresh the rendered UI with new state. Two modes:  (1) `{stackItemId, kind:'replace', props}` — full props replacement; `props` IS the new state. Use when most fields change or you want deterministic restoration.  (2) `{stackItemId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch; send ONLY the delta. Top-level keys merge shallow, nested objects merge recursively, a `null` value DELETES that key, arrays fully replace. Use when one or two fields change (much cheaper for the agent to construct than re-sending all props).  USE THIS TOOL AFTER ANY DOMAIN-TOOL CALL THAT CHANGED DATA THE UI SHOWS — e.g. you handled a `todo_toggle`/`cart_add`/`note_save` event from `ggui_consume`, mutated backend state, and the user is now staring at stale props. Skipping this leaves the iframe frozen on the old state and is the #1 wire bug. Pattern: `consume → domain-tool → ggui_update → loop`. The server fans a `props_update` frame to live subscribers; the mount re-renders WITHOUT losing scroll position, focus, or uncommitted input — far cheaper than re-pushing. Both modes validate the FINAL props (post-merge for `merge`) against the stack item's `propsSpec` (when declared) and reject on violation. Mutation ownership: only the session-creating identity may overwrite.",
    // No `allowedFor` — same toolset on every pod kind. Mutation
    // ownership (only the session-creating identity may overwrite) is
    // enforced inside the handler against `ctx.appId`, not at
    // registration time.
    inputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<UpdateOutput> {
      const parsed = z.object(inputSchema).parse(input);

      // Pre-mutation gate. Throws to abort BEFORE any state change.
      // OSS default: no gate bound, no-op. Cloud binds a traffic-class
      // gate (kind=user / playground / PUSH_ALLOW_NON_PLAYGROUND
      // override) here.
      if (deps.billingGate) {
        await deps.billingGate.preCheck({ ctx, tool: 'ggui_update' });
      }

      // Direct path. Wire input carries stackItemId only — sessionId is
      // resolved server-side via the SessionStore's stackItemId
      // secondary index. Falls back to ctx.stackItemId when populated
      // by an in-process dispatcher (live-channel dispatch + future
      // mounts that thread the active stack frame).
      const stackItemId: string | undefined =
        parsed.stackItemId ?? ctx.stackItemId;
      if (!stackItemId) {
        throw new StackItemNotFoundError(
          'ggui_update: stackItemId is required on the wire (or threaded via HandlerContext for in-process dispatchers).',
        );
      }
      let sessionId: string | undefined;
      {
        const indexEntry = await deps.sessionStore.getSessionByStackItemId(stackItemId);
        // Cross-tenant access AND missing-stackItemId both project to
        // StackItemNotFoundError so the response doesn't leak whether
        // the stackItemId exists in another tenant.
        if (!indexEntry || indexEntry.appId !== ctx.appId) {
          throw new StackItemNotFoundError(
            `ggui_update: stackItemId "${stackItemId}" not found, expired, or owned by a different appId. Recovery: re-push to obtain a fresh stackItemId, or check the stackItemId from the most recent ggui_push response.`,
          );
        }
        sessionId = indexEntry.sessionId;
      }
      if (!sessionId) {
        throw new UpdateUnsupportedError(
          'ggui_update: failed to resolve target session after index lookup.',
        );
      }

      // Tenancy gate (defensive backstop). Index lookup above already
      // tenancy-checked; this is the same StackItemNotFoundError
      // projection (don't leak whether the id exists in another
      // tenant).
      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        throw new StackItemNotFoundError(
          `ggui_update: stackItemId "${stackItemId}" cannot be resolved to a live session.`,
        );
      }

      // Devtools payload trace. No-op when no sink is
      // registered. Fires AFTER the tenancy gate so cross-tenant probes
      // never leak into the trace. Payload is the validated wire shape.
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

      // Narrow the session's stack into the StackItemTarget shape the
      // shared helper requires. Both protocol StackItem and McpAppsStackItem
      // satisfy `id: string` structurally; propsSpec + props flow
      // through when present. McpAppsStackItem has no propsSpec — the
      // helper's assertPropsContract no-ops on absent spec, so MCP Apps
      // stack items accept any patch shape (the iframe owns its own
      // validation).
      const stack: ReadonlyArray<StackItemTarget & SessionStackEntry> =
        session.stack;

      // applyStackItemPatch throws StackItemNotFoundError when
      // stackItemId is missing and ContractViolationError{tool:
      // 'ggui_update'} on propsSpec fail (validated against the FINAL
      // props — post-merge for `merge` mode). Both propagate verbatim
      // — transport layer maps each.
      const { updatedItem, finalProps } = applyStackItemPatch({
        stack,
        stackItemId,
        ...patchInput,
      });

      // Persist via the seam. `appendStackItem` upserts by `entry.id`,
      // preserving the existing stack position (see SessionStore JSDoc).
      // The handler does NOT thread the full `updatedStack` through —
      // the seam is the upsert primitive.
      await deps.sessionStore.appendStackItem(sessionId, updatedItem);

      // Best-effort live delivery. Persistence is the source of truth;
      // the live-channel fan-out is a latency optimization. Errors are
      // swallowed — a failed notify must not fail the tool call (the
      // renderer reads canonical state via `ack.stack` on next
      // (re)subscribe).
      if (deps.propsUpdateNotifier) {
        try {
          await deps.propsUpdateNotifier.sendPropsUpdate(
            sessionId,
            stackItemId,
            finalProps,
          );
        } catch {
          // Silent: stay aligned with `safelyNotifyStackPush`'s posture
          // in push.ts. A throwing notifier is a host-side bug, not a
          // tool-call failure.
        }
      }

      return {
        sessionId,
        stackItemId,
        updated: true,
      };
    },
    /**
     * Emit `_meta.ggui.bootstrap` mirroring `ggui_push`'s shape but
     * **props-only** (post-2026-05-13 trim). Spec-compliant MCP Apps
     * hosts forward the full `CallToolResult` (including `_meta`) via
     * `ui/notifications/tool-result` postMessage; iframe-runtime's
     * `installPostMountListener` reads the envelope and re-applies the
     * patched props to the live mount WITHOUT a WS round-trip. The WS
     * `props_update` frame remains the first-party fast path; this
     * envelope is the cross-host fallback.
     *
     * **Why props-only:** update mutates props, not the contract. The
     * iframe is already mounted with code + actionSpec + contextSpec +
     * permissions from its initial push bootstrap; those are mount-time
     * invariants. Re-emitting them on every update wasted 5-50KB per
     * call. Today's update bootstrap carries only what actually
     * changed (propsJson) plus the auth/session/runtime fields the
     * cross-host fallback needs to re-bind: `{sessionId, appId,
     * stackItemId, runtimeUrl, propsJson?, themeId?, themeMode?,
     * wsUrl?, token?, expiresAt?}`.
     *
     * Skipped entirely when no propsJson + no minter + no runtimeUrl —
     * keeps the response byte-identical for hosts that don't read
     * `_meta` (the structuredContent reply is the source of truth).
     */
    resultMeta: async (output, _input, ctx) => {
      // Load the just-patched stack item only to derive the projected
      // propsJson. The other view fields (componentCode / kind /
      // contextSlots / actionNextSteps / permissionsPolicy /
      // compiledValidators) are mount-time invariants — the initial
      // push already shipped them, and `ggui_update` patches `props`
      // only, never the contract specs.
      let view: StackItemBootstrapView = {};
      // Capture session + stack-item themeId from the same lookup that
      // drives `deriveStackItemBootstrapView`. Without this, a session
      // minted with `ggui_new_session({themeId})` followed by a
      // `ggui_update` (props refresh) would emit a bootstrap WITHOUT
      // themeId — the iframe re-mounts with the default theme even
      // though the session has a sticky theme. Same 4-layer chain as
      // push: liveTheme > stackItem > session > deps.themeId.
      let stackItemThemeId: string | undefined;
      let sessionThemeId: string | undefined;
      try {
        const session = await deps.sessionStore.get(output.sessionId);
        if (session) {
          sessionThemeId = session.themeId;
        }
        const top = session?.stack.find((s) => s.id === output.stackItemId);
        if (top) {
          view = deriveStackItemBootstrapView(top);
          if (top.type !== 'mcpApps' && top.type !== 'system') {
            stackItemThemeId = top.themeId;
          }
        }
      } catch {
        // Silent — bootstrap stays minimal on lookup failure.
      }

      // Nothing to emit ⇒ no _meta at all.
      if (
        view.propsJson === undefined &&
        !deps.mintBootstrap &&
        deps.runtimeUrl === undefined
      ) {
        return undefined;
      }

      const runtimeUrlRaw =
        typeof deps.runtimeUrl === 'function'
          ? deps.runtimeUrl()
          : deps.runtimeUrl;
      const runtimeUrl = runtimeUrlRaw ?? '/_ggui/iframe-runtime.js';
      const partial = deps.mintBootstrap
        ? deps.mintBootstrap(output.sessionId, ctx.appId)
        : {};
      // 4-layer theme resolution. Mirror of the push.resultMeta chain
      // (liveTheme > stackItem > session > deps.themeId) so update +
      // push surface identical theme behavior. liveTheme wins because
      // it's the operator's debug-surface override (dev console
      // picker) — silently outranking it would defeat the picker's
      // purpose for sessions that already chose a theme. First non-
      // undefined wins. themeMode stays 2-layer because no agent
      // surface sets it per-stack / per-session today.
      const liveTheme = deps.themeProvider?.();
      const resolvedThemeId =
        liveTheme?.id
        ?? stackItemThemeId
        ?? sessionThemeId
        ?? deps.themeId;
      const resolvedThemeMode = liveTheme?.mode ?? deps.themeMode;
      const bootstrap: GguiBootstrapMeta = {
        ...partial,
        sessionId: output.sessionId,
        appId: ctx.appId,
        ...(output.stackItemId !== undefined
          ? { stackItemId: output.stackItemId }
          : {}),
        runtimeUrl,
        ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
        ...(resolvedThemeMode !== undefined
          ? { themeMode: resolvedThemeMode }
          : {}),
        ...(view.propsJson ? { propsJson: view.propsJson } : {}),
      };
      // Split into the five per-window `_meta` keys (#109). update.ts
      // only ever refreshes propsJson + theme; contract+component
      // slices are absent (validators + componentCode stay on the
      // initial bootstrap from push.ts).
      const split = splitBootstrapMeta(bootstrap);
      const out: Record<string, unknown> = {
        [MCP_APP_AI_GGUI_SESSION_META_KEY]: split.session,
        ...(split.auth ? { [MCP_APP_AI_GGUI_AUTH_META_KEY]: split.auth } : {}),
        ...(split.render
          ? { [MCP_APP_AI_GGUI_RENDER_META_KEY]: split.render }
          : {}),
      };
      return out;
    },
  };
}

