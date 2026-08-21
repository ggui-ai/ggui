/**
 * PROPS-MUTATION CORE — the single flow behind BOTH mutation tools
 * (#483 tool split): `ggui_update` (advances the history epoch,
 * mints a new record) and `ggui_amend` (in-place, epoch untouched).
 * Extracted verbatim from the pre-split ggui_update handler; the
 * per-tool deltas are parameterized on `tool`, everything else is
 * byte-identical behavior.
 */
import { z } from 'zod';
import {
  ContractViolationError,
  buildEnforcedPropsSchema,
  classifyPropsSchemaProfile,
  type JsonObject,
  type GguiSession,
  type PropsSchemaProfile,
} from '@ggui-ai/protocol';
import { computePropsSchemaHash } from '@ggui-ai/protocol/props-schema-hash';
import { GGUI_RENDER_UI_META } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { HandlerContext } from '../types.js';
import { refreshRenderIdentity } from './render-identity.js';
import {
  applyGguiSessionPatch,
  type GguiSessionTarget,
} from './apply-ggui-session-patch.js';
import { GguiSessionNotFoundError } from './errors.js';
import { emitPayloadTraceEvent } from './payload-trace-sink.js';
import { emitRenderContractViolation } from './render-telemetry.js';
// Type-only — erased at runtime, so no import cycle with update.ts
// (which imports this module's runtime exports).
import type { GguiUpdateHandlerDeps } from './update.js';

/**
 * Input raw-shape shared by BOTH mutation tools — discriminated on
 * `kind` (`'replace'` + `props` | `'merge'` + `patch`); identical wire
 * grammar for `ggui_update` and `ggui_amend` (#483). Both validate the
 * FINAL props (post-merge for `merge`) against the render's
 * `propsSpec`.
 */
export const mutationInputSchema = {
  /**
   * Globally-unique render id. Optional on the wire so an in-process
   * dispatcher (live-channel dispatch / threaded mount) can populate it
   * via `HandlerContext.sessionId` instead. Required at the core
   * level — see the resolve step inside `runPropsMutation`.
   */
  sessionId: z.string().optional(),
  /**
   * Mode discriminator. `'replace'` requires `props`; `'merge'`
   * requires `patch`. The narrowing step inside the core enforces
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
   * rejected otherwise. The core applies the patch to the existing
   * props, then validates the merged result against `propsSpec`.
   * `null` values in the patch DELETE the corresponding key.
   */
  patch: z.record(z.string(), z.unknown()).optional(),
} as const;
const inputSchema = mutationInputSchema;

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

export interface PropsMutationResult {
  readonly sessionId: string;
  readonly updated: boolean;
  /** Bare mount URI (no epoch pin) — callers compose pinned forms. */
  readonly mountResourceUri: string;
  /** Head epoch AFTER the call (row-authoritative; 0 when absent). */
  readonly epoch: number;
  readonly warning?: string;
  /**
   * ggui#560 — schema attestation: identity hash of the enforced
   * props schema derived from the COMMITTED session's `propsSpec`
   * (the schema this leg validated against and the next mutation will
   * be validated against). Present iff the session carries a spec —
   * the mutation legs' validation no-ops on an absent spec, and
   * attesting a schema this leg does not enforce would be false.
   * Joins the handshake disclosure by hash equality: a mismatch =
   * the SESSION CONTINUITY obligation broken, observable per-turn.
   */
  readonly propsSchemaHash?: string;
  /** Present with {@link propsSchemaHash}. Same classifier as the handshake's. */
  readonly propsSchemaProfile?: PropsSchemaProfile;
}

export async function runPropsMutation(
  deps: GguiUpdateHandlerDeps,
  tool: 'ggui_update' | 'ggui_amend',
  input: unknown,
  ctx: HandlerContext,
): Promise<PropsMutationResult> {
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
            tool,
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
            tool,
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
            tool,
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
            tool,
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
        await deps.billingGate.preCheck({ ctx, tool });
      }

      // Resolve sessionId from wire OR threaded HandlerContext.
      const sessionId: string | undefined =
        parsed.sessionId ?? ctx.sessionId;
      if (!sessionId) {
        throw new GguiSessionNotFoundError(
          '',
          `${tool}: sessionId is required on the wire (or threaded via HandlerContext for in-process dispatchers).`,
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
      emitPayloadTraceEvent(deps.payloadTraceSink, {
        direction: 'outbound-update',
        sessionId,
        appId: ctx.appId,
        tool,
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
      // ggui#560 — schema attestation for the mutation outputs: the
      // enforced-schema identity this leg validates against, derived
      // from the committed spec. Computed once, spread into every
      // successful return. Absent spec → absent attestation (this
      // leg's validation no-ops there; see PropsMutationResult).
      const attestation: {
        readonly propsSchemaHash?: string;
        readonly propsSchemaProfile?: PropsSchemaProfile;
      } =
        'propsSpec' in renderTarget && renderTarget.propsSpec !== undefined
          ? (() => {
              const enforced = buildEnforcedPropsSchema(
                renderTarget.propsSpec,
              );
              return {
                propsSchemaHash: computePropsSchemaHash(enforced),
                propsSchemaProfile: classifyPropsSchemaProfile(enforced),
              };
            })()
          : {};
      // Closure keeps `applyGguiSessionPatch`'s generic inference on the
      // concrete render type — `ReturnType<typeof applyGguiSessionPatch>`
      // directly would collapse the type parameter to its constraint.
      const applyPatch = () =>
        applyGguiSessionPatch({
          render: renderTarget,
          tool,
          ...patchInput,
        });
      let patched: ReturnType<typeof applyPatch>;
      try {
        patched = applyPatch();
      } catch (err) {
        // Measurement: mutation-time propsSpec violations are the same
        // failure class the render-time `render.contract_violation`
        // events count — emit, then propagate verbatim (the transport
        // layer still maps the error; the sink is fire-and-forget).
        if (err instanceof ContractViolationError) {
          emitRenderContractViolation(deps.telemetrySink, {
            appId: ctx.appId,
            tool,
            site: 'mutation_props',
            violationClass: 'props',
            sessionId,
            kind: parsed.kind,
            violations: err.violations,
            ...(attestation.propsSchemaHash !== undefined
              ? { propsSchemaHash: attestation.propsSchemaHash }
              : {}),
          });
          // §2.3.2 Obligation 4: every props contract_violation carries
          // the ENFORCED schema's hash. The patch helper throws without
          // one (it has no schema identity in scope); the enforcing
          // SITE does — rewrap with it so the breach classifier works
          // on the mutation legs exactly as on the render leg.
          if (
            attestation.propsSchemaHash !== undefined &&
            err.propsSchemaHash === undefined
          ) {
            throw new ContractViolationError({
              tool: err.tool,
              violations: err.violations,
              hint: err.hint,
              propsSchemaHash: attestation.propsSchemaHash,
            });
          }
        }
        throw err;
      }
      const { updatedSession, finalProps } = patched;

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
          mountResourceUri,
          ...attestation,
          // No record minted on a no-op — the head epoch is untouched.
          epoch: stored.render.epoch ?? 0,
          warning:
            'NO-OP: this patch left the props identical to the current state — nothing changed on screen. If you meant to refresh the UI, send values that actually differ; if the user’s gesture asks for a DIFFERENT surface (menu selection, navigation), run ggui_handshake + ggui_render for the next UI instead of updating this one.',
        };
      }

      // Epoch (#483): the row is the AUTHORITY, advanced in the SAME
      // commit as the props write — update mints a new history record
      // (epoch + 1); amend leaves the head untouched. The reminted
      // ledger event below is the wire SIGNAL frames latch on, not the
      // counter (the event ring is horizon-bounded).
      const priorEpoch = stored.render.epoch ?? 0;
      const nextEpoch = tool === 'ggui_update' ? priorEpoch + 1 : priorEpoch;
      const sessionToCommit: GguiSession =
        tool === 'ggui_update'
          ? { ...updatedSession, epoch: nextEpoch }
          : updatedSession;

      // Persist via the commit seam — first-write mints, re-write
      // replaces visible-bits in place. Lifecycle fields owned by the
      // store (createdAt, eventSequence, hostSession) preserved across
      // the upsert.
      const committed = await deps.renderStore.commit({
        render: sessionToCommit,
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
        // The props event carries the epoch it belongs to (#483) so
        // frames can ignore props from a NEWER epoch than their own
        // instead of flashing the new state before the freeze lands.
        const seq = await deps.renderStore.appendEvent({
          sessionId,
          type: 'ui.updated',
          data: { sessionId, props: finalProps, epoch: nextEpoch },
        });
        // The append advanced the row's high-water mark past the
        // commit-time snapshot — thread the returned seq so the
        // identity refresh records the ledger state INCLUDING this
        // update's own event (record.seqAtLastCommit tracks the row).
        committedForIdentity = { ...committed, eventSequence: seq };
        // Epoch boundary AFTER the props event (#483): pinned #N
        // reconstruction replays props UP TO AND INCLUDING the N-th
        // remint boundary, so the boundary must follow its own props.
        // This is also the freeze signal older-epoch frames latch on.
        if (tool === 'ggui_update') {
          const remintSeq = await deps.renderStore.appendEvent({
            sessionId,
            type: 'ui.reminted',
            data: { epoch: nextEpoch },
          });
          committedForIdentity = {
            ...committedForIdentity,
            eventSequence: remintSeq,
          };
        }
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
          await deps.propsUpdateNotifier.sendPropsUpdate(
            sessionId,
            finalProps,
            nextEpoch,
          );
        } catch {
          // Silent: stay aligned with `safelyNotifyGguiSessionCommit`'s
          // posture in render.ts. A throwing notifier is a host-side
          // bug, not a tool-call failure.
        }
      }

      // Callers own presentation: ggui_update composes the pinned
      // `#epoch` form from this bare mount URI; ggui_amend returns it
      // bare (the live head).
      return {
        sessionId,
        updated: true,
        mountResourceUri,
        epoch: nextEpoch,
        ...attestation,
      };
}
