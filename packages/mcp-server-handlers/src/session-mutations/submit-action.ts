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
 *       "sessionId": "sess_…",                // bootstrap.sessionId
 *       "stackItemId": "stk_…",               // bootstrap.stackItemId
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
 *     stackItem-keyed pending-events pipe so the agent's
 *     `ggui_consume` long-poll unblocks mid-turn. If the pipe is
 *     closed/missing (popped, session closed, never opened) the
 *     handler returns `{ok:false, code:'PIPE_NOT_FOUND'}` so the
 *     iframe-runtime can fall through to `ui/message` chat-shortcut
 *     postMessage (the gesture reaches the agent on its next turn).
 *   - `kind ∈ {'openLink','requestDisplayMode'}`: pure audit. The
 *     user-visible host effect (ui/open-link, ui/request-display-mode)
 *     already fired iframe-side; the server just records the gesture
 *     for the SessionInspector feed.
 *
 * **Failure modes:**
 *   - Malformed envelope → `{ok:false, code:'INVALID_ACTION_KIND',
 *     message}`. The iframe-runtime SHOULD log and fall through to
 *     `ui/message` (same as PIPE_NOT_FOUND) so the gesture isn't
 *     silently lost.
 *   - Pipe missing for a `dispatch` → `{ok:false,
 *     code:'PIPE_NOT_FOUND'}`. Iframe-runtime falls through to
 *     `ui/message`.
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
      'Active session id — sourced from `_meta.ggui.bootstrap.sessionId` on the iframe boot envelope.',
    ),
  stackItemId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Active stack item id — sourced from `_meta.ggui.bootstrap.stackItemId` on the iframe boot envelope. Required when `kind === "dispatch"` so the handler can append the action envelope onto the stackItem-keyed pending-events pipe (Model C). Other kinds (`openLink`, `requestDisplayMode`) only need this for audit log keying; absent is tolerated for boot scenarios that pre-date a push (system-cards, provisional previews).',
    ),
  appId: z
    .string()
    .min(1, 'appId is required')
    .describe(
      'Active app id — sourced from `_meta.ggui.bootstrap.appId` on the iframe boot envelope.',
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
   *     stackItemId whose pipe is closed/missing. iframe-runtime
   *     branches on this to fall through to `ui/message`.
   */
  code: z.enum(['INVALID_ACTION_KIND', 'PIPE_NOT_FOUND']).optional(),
  /** Human-readable diagnostic on `ok:false`. */
  message: z.string().optional(),
  /**
   * On `ok:true` for `kind:"dispatch"`, whether a `ggui_consume`
   * long-poll is currently registered on the active-consumer registry
   * for the targeted stack item:
   *   - `true`  — at least one consumer is draining. The toast holds
   *     `pending` until the matching `drain_ack` frame arrives.
   *   - `false` — no consumer registered. The action IS on the pipe,
   *     but the agent won't wake on its own. Iframe SHOULD immediately
   *     emit a `ui/message` with `_meta.ggui.userAction.kind: 'queued'`
   *     so the agent's next turn calls `ggui_consume({stackItemId})`.
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
 * Build the `ggui_runtime_submit_action` handler. Registers as app-visible
 * (`_meta.ui.visibility: ['app']`) so MCP Apps hosts route
 * iframe-issued `tools/call` invocations to it instead of rejecting
 * them per spec §401.
 *
 * Today: validate + echo + log per-kind. Future slices wire the
 * envelope onto the session channel as an `ActionEnvelope`.
 */
/**
 * Optional deps for the submit_action handler. Wires the pending-events
 * pipe: when an iframe-runtime envelope has `kind === 'dispatch'`,
 * the handler appends the action envelope onto the stackItemId-keyed
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
   * handler queries `hasActive(stackItemId)` after a successful pipe
   * append and surfaces the result as `consumerPresent` on the response.
   * Absent → `consumerPresent` is omitted (iframe assumes a consumer
   * is present and lets drain_ack dismiss the toast).
   */
  readonly activeConsumerRegistry?: ActiveConsumerRegistry;
}

export function createGguiSubmitActionHandler(
  deps: GguiSubmitActionHandlerDeps = {},
): SharedHandler<typeof inputSchema, typeof outputSchema, UserActionOutput> {
  return {
    name: 'ggui_runtime_submit_action',
    title: '[runtime] Submit Action',
    audience: ['runtime'],
    description:
      'Receives a user-action envelope from the rendered ggui UI (iframe → host relay → MCP server). Validates the discriminated `{kind, payload, …}` envelope; for `kind:"dispatch"` appends the action envelope onto the stackItemId-keyed pending-events pipe so the agent\'s `ggui_consume` long-poll unblocks mid-turn — when the pipe is closed/missing, returns `{ok:false, code:"PIPE_NOT_FOUND"}` so the iframe-runtime can fall through to `ui/message` chat-shortcut. For `kind:"openLink"` / `kind:"requestDisplayMode"`, pure audit — the user-visible host effect has already fired iframe-side. Never invoked by the model directly — `_meta.ui.visibility: [\'app\']` restricts callers to MCP Apps views per spec §401; the iframe holds no auth credential so the host is the relay party.',
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
      // Round-trip echo gives the caller (iframe) a confirmation
      // signal; per-kind logging at the operator surface is layered on
      // by SessionInspector reading from the structured logger.
      const env = parsed.data as GguiSubmitActionInput;

      // Model C wire: dispatch envelopes land on the stackItem-keyed
      // pending-events pipe. The agent's `ggui_consume` long-poll
      // drains it. `openLink` / `requestDisplayMode` are host effects
      // and don't need pipe append (no agent-side react step).
      //
      // Every dispatch failure mode below surfaces as
      // `{ok:false, code:'PIPE_NOT_FOUND'}` so the iframe-runtime's
      // dispatch closure observes a non-success outcome and falls
      // through to `ui/message` — the consent-gated chat-shortcut. The
      // gesture is then visible to the agent on its next chat turn
      // instead of being silently dropped (the 2026-05-13 live-debug
      // finding: claude.ai's iframe was firing dispatch with no
      // stackItemId; pre-fix the handler returned `ok:true` without
      // appending, the iframe saw success, the fallback never fired,
      // and the agent's consume long-poll waited for events that would
      // never arrive).
      if (env.kind === 'dispatch') {
        if (
          typeof env.stackItemId !== 'string' ||
          env.stackItemId.length === 0
        ) {
          return {
            ok: false,
            code: 'PIPE_NOT_FOUND',
            message: `submit_action: kind="dispatch" requires a non-empty stackItemId. The active stack item is exposed on the iframe boot envelope as \`_meta.ggui.bootstrap.stackItemId\`; the runtime should thread it through. Iframe should fall through to ui/message.`,
          };
        }
        if (!deps.pendingEventConsumer) {
          return {
            ok: false,
            code: 'PIPE_NOT_FOUND',
            message: `submit_action: no pending-events consumer wired on this server. Operator must configure \`consume.pendingEventConsumer\` (defaults to in-memory when push is bound). Iframe should fall through to ui/message.`,
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
          stackItemId: env.stackItemId,
          intent: dispatchPayload.intent,
          actionData: dispatchPayload.actionData ?? null,
          uiContext: dispatchPayload.uiContext,
          actionId: env.actionId,
          firedAt: env.firedAt,
        };
        try {
          await deps.pendingEventConsumer.append(env.stackItemId, {
            // Use the iframe-supplied `actionId` as the pipe entry's
            // stable id so consume's drain_ack frame carries the SAME
            // id the iframe-runtime's toast resolution is keyed on.
            // Without this, drain_ack rows ship with `id: ''` and the
            // iframe can't match the frame against its outstanding toast.
            id: env.actionId,
            envelope: actionEnvelope,
            createdAt: env.firedAt,
          });
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
                env.stackItemId,
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
              message: `submit_action: no pending-events pipe for stackItemId "${env.stackItemId}". The stack item may have been popped, the session closed, or the pipe never opened. Iframe should fall through to ui/message.`,
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
