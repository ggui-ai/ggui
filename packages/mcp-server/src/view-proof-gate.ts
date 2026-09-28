/**
 * The view-origin proof's measuring gate (ggui#1415, release N): for a tool
 * that declares a view proof, verify the call's proof before the handler
 * runs, put the verdict on the handler context, and name it on the
 * `tool_invoked` line. It never refuses a call and never fails one: at this
 * release the proof is measured, not enforced.
 *
 * Built once per server (`createViewProofGate`, holding the secret the ws
 * envelopes are signed with) and run per call (`runViewProofGate`) from
 * `buildMcpServer`'s per-tool callback.
 */
import {
  ViewProofRepeatCache,
  mintViewRoot,
  verifyViewProof,
  type GguiSessionStore,
  type ViewProofVerdict,
  type VerifyViewProofInput,
} from '@ggui-ai/mcp-server-core';
import {
  createSessionRowReads,
  viewProofUseFor,
  type HandlerContext,
  type SharedHandler,
  type ViewProofUse,
} from '@ggui-ai/mcp-server-handlers';
import { isViewProofTool, type ViewRootSrc } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { ZodRawShape } from 'zod';

/**
 * Which era a call's session belongs to, for a `required` call whose proof
 * is not valid; the first match wins. `row_absent`: no store, no row, or
 * the read failed. `foreign`: another app owns the row. `unkeyed`: the
 * session's ids are too long for a view key. `legacy`: created before
 * `keyedSince`, or `keyedSince` is unset. `current`: everything else.
 */
export type ViewProofEra = 'current' | 'legacy' | 'unkeyed' | 'foreign' | 'row_absent';

/** How old the proof's root is on the server's clock (`now − rootIat`). */
export type ViewProofRootAge = 'lt_3m' | 'lt_1h' | 'lt_1d' | 'lt_7d' | 'lt_30d' | 'ge_30d';

/**
 * The view clock against the server's (`vtime − now`), bucketed at 30 s,
 * 5 min and 1 h on each side. Relay latency makes it negative (`behind`),
 * so `ahead` can only be the view's clock running ahead.
 */
export type ViewProofSkew =
  | 'behind_ge_1h'
  | 'behind_lt_1h'
  | 'behind_lt_5m'
  | 'within_30s'
  | 'ahead_lt_5m'
  | 'ahead_lt_1h'
  | 'ahead_ge_1h';

/**
 * The proof's fields on a `tool_invoked` line: ids, flags and buckets only.
 * Never the proof, its root, its nonce, its tags, the view key or any
 * argument.
 */
export interface ViewProofLineFields {
  readonly viewProof?: ViewProofVerdict['verdict'];
  readonly viewProofReason?: string;
  readonly viewProofErrorClass?: string;
  /** Valid only: the session the proof's root names (it equals the call's). */
  readonly viewProofSessionId?: string;
  /** Not valid: the call's session as the caller claims it, capped. */
  readonly claimedSessionId?: string;
  readonly claimedSessionIdTruncated?: true;
  readonly viewProofRootAge?: ViewProofRootAge;
  readonly viewProofRootSrc?: ViewRootSrc;
  readonly viewProofSkew?: ViewProofSkew;
  /** Dispatch only: the gesture's user-activation flag, self-asserted by any key holder. */
  readonly viewProofActivation?: boolean;
  /** This replica saw the same `(session, nonce)` within the repeat window. */
  readonly viewProofRepeat?: true;
  readonly viewProofEra?: ViewProofEra;
  /** The tool declares a proof and the server has no verifier. */
  readonly viewProofUnverifiable?: true;
}

/** A server's gate: its verifier, and what it reads to classify an era. */
export interface ViewProofGate {
  verify(input: VerifyViewProofInput): ViewProofVerdict;
  /** Whether a session's ids fit a view key's root. */
  keyable(sessionId: string, appId: string): boolean;
  readonly sessionStore: GguiSessionStore | undefined;
  /** Epoch ms from which every replica of this deployment issues view keys. */
  readonly keyedSince: number | undefined;
  readonly repeatCache: ViewProofRepeatCache;
  now(): number;
}

export interface CreateViewProofGateOptions {
  /** The secret the server's ws envelopes are signed with. */
  readonly secret: string;
  readonly sessionStore: GguiSessionStore | undefined;
  readonly keyedSince?: number;
  readonly now?: () => number;
}

/** Build a server's gate once; the secret stays in its closures. */
export function createViewProofGate(opts: CreateViewProofGateOptions): ViewProofGate {
  const now = opts.now ?? Date.now;
  return {
    verify: (input) => verifyViewProof(input, opts.secret),
    keyable: (sessionId, appId) =>
      mintViewRoot({ sessionId, appId, src: 'result' }, opts.secret).viewKey !== undefined,
    sessionStore: opts.sessionStore,
    keyedSince: opts.keyedSince,
    repeatCache: new ViewProofRepeatCache(10 * 60 * 1000, 10_000, now),
    now,
  };
}

/**
 * Refuse, at boot, a handler that declares a view proof on a tool the
 * proof's bound-argument table does not name: no view can sign a call to
 * it, so every call would read `missing` for a reason no one could find.
 */
export function assertViewProofDeclarations(
  handlers: ReadonlyArray<Pick<SharedHandler<ZodRawShape, ZodRawShape>, 'name' | 'viewProof'>>,
): void {
  const unbound = handlers.filter((h) => h.viewProof !== undefined && !isViewProofTool(h.name)).map((h) => h.name);
  if (unbound.length > 0) {
    throw new Error(
      `A view proof is declared on ${unbound.join(', ')}, which the view proof's bound-argument table does not name, so no view can sign a call to it. Remove the declaration, or add the tool to the table in @ggui-ai/protocol.`,
    );
  }
}

/** The tools whose declared proof a server without a verifier cannot check. */
export function unverifiableViewProofTools(
  handlers: ReadonlyArray<Pick<SharedHandler<ZodRawShape, ZodRawShape>, 'name' | 'viewProof'>>,
): string[] {
  return handlers.filter((h) => h.viewProof !== undefined).map((h) => h.name);
}

const CLAIMED_SESSION_ID_MAX_CHARS = 128;
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

function rootAge(ageMs: number): ViewProofRootAge {
  if (ageMs < 3 * MINUTE) return 'lt_3m';
  if (ageMs < HOUR) return 'lt_1h';
  if (ageMs < DAY) return 'lt_1d';
  if (ageMs < 7 * DAY) return 'lt_7d';
  if (ageMs < 30 * DAY) return 'lt_30d';
  return 'ge_30d';
}

function skew(deltaMs: number): ViewProofSkew {
  const size = Math.abs(deltaMs);
  if (size < 30 * SECOND) return 'within_30s';
  const side = deltaMs < 0 ? 'behind' : 'ahead';
  if (size < 5 * MINUTE) return `${side}_lt_5m`;
  if (size < HOUR) return `${side}_lt_1h`;
  return `${side}_ge_1h`;
}

function claimed(sessionId: string): Pick<ViewProofLineFields, 'claimedSessionId' | 'claimedSessionIdTruncated'> {
  if (sessionId === '') return {};
  if (sessionId.length <= CLAIMED_SESSION_ID_MAX_CHARS) return { claimedSessionId: sessionId };
  return { claimedSessionId: sessionId.slice(0, CLAIMED_SESSION_ID_MAX_CHARS), claimedSessionIdTruncated: true };
}

async function classifyEra(gate: ViewProofGate, ctx: HandlerContext, sessionId: string): Promise<ViewProofEra> {
  const store = gate.sessionStore;
  if (store === undefined || ctx.sessionRows === undefined) return 'row_absent';
  let row;
  try {
    row = await ctx.sessionRows.read(store, sessionId);
  } catch {
    // A failed read is `row_absent`. The handler reads the same memoized
    // rejection and names the failure on its own ownership line.
    return 'row_absent';
  }
  if (row === null) return 'row_absent';
  if (row.appId !== ctx.appId) return 'foreign';
  if (!gate.keyable(sessionId, row.appId)) return 'unkeyed';
  if (gate.keyedSince === undefined) return 'legacy';
  // A component or system render's creation time is epoch ms; an embedded
  // MCP App's is an ISO string. One this server cannot read is `legacy`,
  // the era that is accepted for life.
  const createdAt = row.render.createdAt;
  const createdMs = typeof createdAt === 'number' ? createdAt : Date.parse(createdAt);
  if (!Number.isFinite(createdMs) || createdMs < gate.keyedSince) return 'legacy';
  return 'current';
}

/** What the gate hands back: the context the handler runs with, and the line fields. */
export interface ViewProofGateResult {
  readonly ctx: HandlerContext;
  readonly fields: ViewProofLineFields;
}

/**
 * Run the gate for one call. `gate` is undefined on a server with no
 * verifier. Total: it never throws, and never changes what the handler
 * answers; a declaration it cannot read leaves the call as it came.
 */
export async function runViewProofGate(
  gate: ViewProofGate | undefined,
  handler: Pick<SharedHandler<ZodRawShape, ZodRawShape>, 'name' | 'viewProof'>,
  input: Record<string, unknown>,
  ctx: HandlerContext,
): Promise<ViewProofGateResult> {
  let use: ViewProofUse | undefined;
  try {
    use = viewProofUseFor(handler.viewProof, input);
  } catch (err) {
    return {
      ctx,
      fields: { viewProof: 'invalid', viewProofReason: 'verifier_error', viewProofErrorClass: errorName(err) },
    };
  }
  if (use === undefined) return { ctx, fields: {} };
  if (gate === undefined) return { ctx, fields: { viewProofUnverifiable: true } };
  const toolName = handler.name;
  if (!isViewProofTool(toolName)) return { ctx, fields: { viewProofUnverifiable: true } };
  const sessionId = typeof input['sessionId'] === 'string' ? input['sessionId'] : '';
  const verdict = gate.verify({ requestMeta: ctx.requestMeta, toolName, args: input, sessionId, appId: ctx.appId });
  const withProof: HandlerContext = { ...ctx, viewProof: verdict, sessionRows: ctx.sessionRows ?? createSessionRowReads() };
  if (verdict.verdict === 'valid') {
    const t = gate.now();
    return {
      ctx: withProof,
      fields: {
        viewProof: 'valid',
        viewProofSessionId: sessionId,
        viewProofRootAge: rootAge(t - verdict.rootIat * SECOND),
        ...(verdict.src !== undefined ? { viewProofRootSrc: verdict.src } : {}),
        viewProofSkew: skew(verdict.vtime - t),
        ...(toolName === 'ggui_runtime_submit_action' && input['kind'] === 'dispatch'
          ? { viewProofActivation: verdict.userActivation }
          : {}),
        ...(gate.repeatCache.observe(sessionId, verdict.nonce) ? { viewProofRepeat: true } : {}),
      },
    };
  }
  const era = use === 'required' ? await classifyEra(gate, withProof, sessionId) : undefined;
  return {
    ctx: withProof,
    fields: {
      viewProof: verdict.verdict,
      viewProofReason: verdict.reason,
      ...(verdict.verdict === 'invalid' && verdict.reason === 'verifier_error'
        ? { viewProofErrorClass: verdict.errorClass }
        : {}),
      ...claimed(sessionId),
      ...(era !== undefined ? { viewProofEra: era } : {}),
    },
  };
}

function errorName(err: unknown): string {
  return (err instanceof Error ? err.name : typeof err).slice(0, 64);
}
