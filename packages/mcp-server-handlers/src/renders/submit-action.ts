/**
 * `ggui_runtime_submit_action` — server-side receiver for the
 * iframe-runtime's user-action envelopes.
 *
 * Registered with `_meta.ui.visibility: ['app']` per MCP Apps spec
 * §401: hosts MUST relay `tools/call` from views (iframes) for tools
 * carrying `'app'` visibility, AND MUST reject calls from views for
 * tools that don't. The iframe holds no auth credential; the host's
 * MCP client is the relay party.
 *
 * **Wire shape** (what iframe-runtime postMessages via `tools/call`
 * and the host relays to the MCP server):
 *
 * ```jsonc
 * {
 *   "method": "tools/call",
 *   "params": {
 *     "name": "ggui_runtime_submit_action",
 *     "arguments": {
 *       "kind": "dispatch",                   // closed primary set + ext slot
 *       "payload": {
 *         "intent": "submit",                 // actionSpec[*] key
 *         "actionData": { "answer": "yes" },  // payload satisfying actionSpec[intent].schema; null for bare clicks
 *         "uiContext": { "draft": "" }        // iframe-local contextSpec snapshot at gesture time
 *       },
 *       "sessionId":  "rnd_…",                 // bootstrap.sessionId
 *       "appId":     "app_…",                 // bootstrap.appId
 *       "actionId":  "a3f2b1d4",              // 8-hex correlation hash
 *       "firedAt":   "2026-05-12T10:00:00Z"   // ISO-8601 client-monotonic
 *     }
 *   }
 * }
 * ```
 *
 * **Behavior per `kind`:**
 *
 *   - `kind === 'dispatch'`: appends the action envelope onto the
 *     render-keyed pending-events pipe so the agent's
 *     `ggui_consume` long-poll unblocks mid-turn. If the pipe is
 *     closed/missing (render closed, never opened) the handler
 *     returns `{ok:false, code:'PIPE_NOT_FOUND'}` so the
 *     iframe-runtime can fall through to `ui/message` chat-shortcut
 *     postMessage (the gesture reaches the agent on its next turn).
 *   - `kind ∈ {'openLink','requestDisplayMode'}`: pure audit. The
 *     user-visible host effect (ui/open-link, ui/request-display-mode)
 *     already fired iframe-side; the server just records the gesture
 *     for the RenderInspector feed.
 *
 * **Failure modes:**
 *   - Malformed envelope → `{ok:false, code:'INVALID_ACTION_KIND',
 *     message}`. The iframe-runtime SHOULD log and fall through to
 *     `ui/message` (same as PIPE_NOT_FOUND) so the gesture isn't
 *     silently lost.
 *   - Pipe missing for a `dispatch` → `{ok:false,
 *     code:'PIPE_NOT_FOUND'}`. Iframe-runtime falls through to
 *     `ui/message`.
 *
 * Post-Phase-B (flatten-render-identity): collapsed from
 * `{sessionId, stackItemId, appId, ...}` input → `{sessionId, appId,
 * ...}` input. Every render IS the addressable scope.
 */
import { z } from 'zod';
import {
  SUBMIT_ACTION_KINDS,
  isGguiSubmitActionInput,
  type GguiSubmitActionInput,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  PendingPipeNotFoundError,
  type ActiveConsumerRegistry,
} from '@ggui-ai/mcp-server-core';
import type { SharedHandler } from '../types.js';

// `kind` accepts the closed primary set OR an extension string. Zod
// can't represent `(string & {})` directly; we use `z.string().min(1)`
// and rely on `isGguiSubmitActionInput` (from protocol) for the
// per-kind payload narrowing — same source of truth as the type guard
// callers use elsewhere.
const inputSchema = {
  kind: z
    .string()
    .min(1, 'kind is required')
    .describe(
      `Action-kind discriminator. Closed primary set: ${SUBMIT_ACTION_KINDS.join(' | ')}. Extensibly-closed for forward-compat — extension handlers own their own payload-shape validation.`,
    ),
  payload: z
    .record(z.string(), z.unknown())
    .describe(
      'Per-kind payload. Shape narrowed by `kind`. See `SubmitActionEnvelope` in `@ggui-ai/protocol/integrations/mcp-apps` for the canonical per-kind shapes.',
    ),
  sessionId: z
    .string()
    .min(1, 'sessionId is required')
    .describe(
      'Active render id — sourced from `_meta["ai.ggui/render"].sessionId` on the iframe boot envelope. Required for every dispatch / audit kind; the server keys the pending-events pipe + audit log by this id.',
    ),
  appId: z
    .string()
    .min(1, 'appId is required')
    .describe(
      'Active app id — sourced from `_meta["ai.ggui/render"].appId` on the iframe boot envelope.',
    ),
  actionId: z
    .string()
    .min(1, 'actionId is required')
    .describe(
      '8-hex FNV-1a correlation hash. Lets a host LLM cross-verify a `[ggui:pending-action]` context entry against a `ui/message` consent prompt by id.',
    ),
  firedAt: z
    .string()
    .min(1, 'firedAt is required')
    .describe(
      'ISO-8601 client-monotonic timestamp. Server uses its own clock for authoritative log ordering; this is a diagnostic.',
    ),
} as const;

const outputSchema = {
  /** `true` when the envelope validated and was accepted; `false` on rejection (shape OR pipe missing). */
  ok: z.boolean(),
  /**
   * On `ok:false`, the canonical contract-error code:
   *   - `'INVALID_ACTION_KIND'` — top-level field validation failed
   *     OR per-kind payload shape mismatch.
   *   - `'PIPE_NOT_FOUND'` — `kind:"dispatch"` envelope arrived for a
   *     sessionId whose pipe is closed/missing. iframe-runtime
   *     branches on this to fall through to `ui/message`.
   */
  code: z.enum(['INVALID_ACTION_KIND', 'PIPE_NOT_FOUND']).optional(),
  /** Human-readable diagnostic on `ok:false`. */
  message: z.string().optional(),
  /**
   * On `ok:true` for `kind:"dispatch"`, whether a `ggui_consume`
   * long-poll is currently registered on the active-consumer registry
   * for the targeted render:
   *   - `true`  — at least one consumer is draining. The toast holds
   *     `pending` until the matching `drain_ack` frame arrives.
   *   - `false` — no consumer registered. The action IS on the pipe,
   *     but the agent won't wake on its own. Iframe SHOULD immediately
   *     emit the `ai.ggui/userAction` pure doorbell on a `ui/message`
   *     (`content[0]._meta["ai.ggui/userAction"].kind: 'user-action'`)
   *     so the agent's next turn calls `ggui_consume({sessionId})`.
   *   - `undefined` — server has no active-consumer registry wired
   *     (graceful degradation). Iframe assumes a consumer is present.
   *
   * Absent on `ok:false` (no append happened) and on the `openLink` /
   * `requestDisplayMode` audit kinds (no pipe involvement).
   */
  consumerPresent: z.boolean().optional(),
} as const;

interface UserActionAccepted {
  readonly ok: true;
  /**
   * Surfaced for `kind:'dispatch'` when the server has an
   * {@link ActiveConsumerRegistry} wired. See `outputSchema.consumerPresent`
   * for semantics. Absent for audit kinds (no pipe append) and when the
   * registry seam isn't wired.
   */
  readonly consumerPresent?: boolean;
}

interface UserActionRejected {
  readonly ok: false;
  readonly code: 'INVALID_ACTION_KIND' | 'PIPE_NOT_FOUND';
  readonly message: string;
}

type UserActionOutput = UserActionAccepted | UserActionRejected;

/**
 * Optional deps for the submit_action handler. Wires the pending-events
 * pipe: when an iframe-runtime envelope has `kind === 'dispatch'`,
 * the handler appends the action envelope onto the sessionId-keyed
 * pipe so the agent's `ggui_consume` long-poll can drain it.
 *
 * Absence is tolerated — the handler falls back to validate + echo
 * only (the pre-Model-C behavior). Cloud may keep this absent until
 * its Dynamo adapter implements `append`.
 */
export interface GguiSubmitActionHandlerDeps {
  readonly pendingEventConsumer?: import('@ggui-ai/mcp-server-core').PendingEventConsumer;
  /**
   * Optional active-consumer awareness. When wired (typically shared
   * with the `consume.ts` handler from the same composition root), the
   * handler queries `hasActive(sessionId)` after a successful pipe
   * append and surfaces the result as `consumerPresent` on the response.
   * Absent → `consumerPresent` is omitted (iframe assumes a consumer
   * is present and lets drain_ack dismiss the toast).
   */
  readonly activeConsumerRegistry?: ActiveConsumerRegistry;
  /**
   * Optional append-only event ledger. When wired, the handler
   * dual-writes every successful dispatch envelope to BOTH:
   *
   *   1. {@link pendingEventConsumer.append} — the queue that wakes
   *      `ggui_consume` (load-bearing for the live click loop;
   *      throws → `PIPE_NOT_FOUND`).
   *   2. `renderStore.appendEvent({type:'user.submitted', data})` —
   *      the retained audit ledger (best-effort; errors logged but
   *      do NOT fail the dispatch — the user's gesture reaching the
   *      agent is more important than audit persistence).
   *
   * The two streams have orthogonal semantics by design (per
   * `pending-event-consumer.ts`): queue drains on every consume,
   * ledger is append-only retained. The dual-write restores the
   * audit visibility the pre-spec-mig WS `handleInboundAction` path
   * had (operator-side RenderInspector queries, cross-process
   * replay, hosted multi-pod observability).
   *
   * Absence is tolerated — the handler falls back to queue-only
   * writes. Tests + minimal composers can omit; production OSS +
   * cloud wire it from the shared render store.
   */
  readonly renderStore?: import('@ggui-ai/mcp-server-core').GguiSessionStore;
  /**
   * Optional logger for best-effort audit-write failures. When the
   * dual-write to `renderStore.appendEvent` errors (e.g., SQLite
   * write contention, DynamoDB throttle), we log + swallow rather
   * than fail the dispatch. Absent → silent swallow.
   */
  readonly logger?: {
    readonly warn?: (msg: string, data?: Record<string, unknown>) => void;
  };
}

export function createGguiSubmitActionHandler(
  deps: GguiSubmitActionHandlerDeps = {},
): SharedHandler<typeof inputSchema, typeof outputSchema, UserActionOutput> {
  return {
    name: 'ggui_runtime_submit_action',
    title: '[runtime] Submit Action',
    audience: ['runtime'],
    description:
      'Receives a user-action envelope from the rendered ggui UI (iframe → host relay → MCP server). Validates the discriminated `{kind, payload, …}` envelope; for `kind:"dispatch"` appends the action envelope onto the sessionId-keyed pending-events pipe so the agent\'s `ggui_consume` long-poll unblocks mid-turn — when the pipe is closed/missing, returns `{ok:false, code:"PIPE_NOT_FOUND"}` so the iframe-runtime can fall through to `ui/message` chat-shortcut. For `kind:"openLink"` / `kind:"requestDisplayMode"`, pure audit — the user-visible host effect has already fired iframe-side. Never invoked by the model directly — `_meta.ui.visibility: [\'app\']` restricts callers to MCP Apps views per spec §401; the iframe holds no auth credential so the host is the relay party.',
    inputSchema,
    outputSchema,
    _meta: {
      ui: {
        // Spec §401: only an MCP Apps view (iframe) can call.
        // Outer agent does NOT see this tool.
        visibility: ['app'] as const,
      },
    },
    async handler(input): Promise<UserActionOutput> {
      // Two-tier validation: zod for top-level field presence + types,
      // then `isGguiSubmitActionInput` for per-kind payload narrowing
      // (same source of truth callers use elsewhere — single point of
      // truth for envelope shape).
      const parsed = z.object(inputSchema).safeParse(input);
      if (!parsed.success) {
        return {
          ok: false,
          code: 'INVALID_ACTION_KIND',
          message: `action envelope rejected at top-level: ${parsed.error.issues
            .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
            .join('; ')}`,
        };
      }
      // Pull `kind` into a local before the negative guard call —
      // TS narrows `parsed.data` to `never` after `!isGguiSubmitActionInput`
      // because the zod-inferred type fully overlaps with the guard's
      // type predicate. The local survives the narrowing.
      const observedKind: string = parsed.data.kind;
      if (!isGguiSubmitActionInput(parsed.data)) {
        return {
          ok: false,
          code: 'INVALID_ACTION_KIND',
          message: `action envelope rejected: kind '${observedKind}' payload shape mismatch (see SubmitActionEnvelope for canonical per-kind schemas)`,
        };
      }
      // After both guards `parsed.data` narrows to GguiSubmitActionInput.
      const env = parsed.data as GguiSubmitActionInput;

      // Dispatch envelopes land on the sessionId-keyed pending-events
      // pipe. The agent's `ggui_consume` long-poll drains it. `openLink`
      // / `requestDisplayMode` are host effects and don't need pipe
      // append (no agent-side react step).
      //
      // Every dispatch failure mode below surfaces as
      // `{ok:false, code:'PIPE_NOT_FOUND'}` so the iframe-runtime's
      // dispatch closure observes a non-success outcome and falls
      // through to `ui/message` — the consent-gated chat-shortcut.
      if (env.kind === 'dispatch') {
        if (!deps.pendingEventConsumer) {
          return {
            ok: false,
            code: 'PIPE_NOT_FOUND',
            message: `submit_action: no pending-events consumer wired on this server. Operator must configure \`consume.pendingEventConsumer\` (defaults to in-memory when render is bound). Iframe should fall through to ui/message.`,
          };
        }
        // Dispatch payload is `{intent, actionData, uiContext}` post-2026-05-14.
        // The iframe captures BOTH halves of the gesture atomically:
        // `actionData` is what the user did; `uiContext` is the snapshot
        // of every contextSpec slot at the moment they did it. We carry
        // them through the pipe so the agent reads `{actionData, uiContext}`
        // on each drained event instead of a separate top-level
        // contextSnapshot on the consume output.
        const dispatchPayload = env.payload as {
          intent: string;
          actionData: unknown;
          uiContext: Record<string, unknown>;
        };
        const actionEnvelope = {
          type: 'action' as const,
          sessionId: env.sessionId,
          intent: dispatchPayload.intent,
          actionData: dispatchPayload.actionData ?? null,
          uiContext: dispatchPayload.uiContext,
          actionId: env.actionId,
          firedAt: env.firedAt,
        };
        try {
          // Dual-write: queue (load-bearing) + ledger (best-effort
          // audit). Fired concurrently via `Promise.allSettled` so
          // each outcome is inspected independently — queue rejection
          // re-thrown to surface as `PIPE_NOT_FOUND`; ledger rejection
          // logged + swallowed so audit-store hiccups never silence
          // the user's click. The audit fires regardless of queue
          // success — the gesture happened either way, and the ledger
          // reflects that.
          const ledgerWrite: Promise<unknown> = deps.renderStore
            ? deps.renderStore.appendEvent({
                sessionId: env.sessionId,
                type: 'user.submitted',
                data: actionEnvelope,
              })
            : Promise.resolve();
          const [queueResult, ledgerResult] = await Promise.allSettled([
            deps.pendingEventConsumer.append(env.sessionId, {
              // Use the iframe-supplied `actionId` as the pipe entry's
              // stable id so consume's drain_ack frame carries the SAME
              // id the iframe-runtime's toast resolution is keyed on.
              id: env.actionId,
              envelope: actionEnvelope,
              createdAt: env.firedAt,
            }),
            ledgerWrite,
          ]);
          if (queueResult.status === 'rejected') {
            throw queueResult.reason;
          }
          if (ledgerResult.status === 'rejected') {
            deps.logger?.warn?.('submit_action_ledger_write_failed', {
              sessionId: env.sessionId,
              actionId: env.actionId,
              error:
                ledgerResult.reason instanceof Error
                  ? ledgerResult.reason.message
                  : String(ledgerResult.reason),
            });
          }
          // Pipe append succeeded — query the active-consumer registry
          // (if wired) so the iframe knows whether an in-flight
          // `ggui_consume` long-poll will drain this event soon. When
          // `false`, the iframe immediately emits a `ui/message`
          // queued-userAction nudge so the agent's next turn drains
          // the pipe. When the seam isn't wired, the field is omitted
          // and the iframe assumes a consumer is present (drain_ack
          // will resolve the toast).
          if (deps.activeConsumerRegistry !== undefined) {
            return {
              ok: true,
              consumerPresent: deps.activeConsumerRegistry.hasActive(
                env.sessionId,
              ),
            };
          }
        } catch (err) {
          if (
            err instanceof PendingPipeNotFoundError ||
            (err instanceof Error && err.name === 'PendingPipeNotFoundError')
          ) {
            return {
              ok: false,
              code: 'PIPE_NOT_FOUND',
              message: `submit_action: no pending-events pipe for sessionId "${env.sessionId}". The GguiSession may have been closed, or the pipe never opened. Iframe should fall through to ui/message.`,
            };
          }
          // Non-pipe-class error: still surface as PIPE_NOT_FOUND so
          // the iframe falls through gracefully; the operator sees the
          // root cause in server logs.
          return {
            ok: false,
            code: 'PIPE_NOT_FOUND',
            message: `submit_action: pipe append failed: ${err instanceof Error ? err.message : String(err)}`,
          };
        }
      }

      return { ok: true };
    },
  };
}
