/**
 * `dispatch-idempotency` catalog — SPEC §11.1 "A retried dispatch is one
 * gesture" (ggui#1519), graded on the `tools/call` wire.
 *
 * A host or relay that could not confirm a `ggui_runtime_submit_action`
 * dispatch may retry it. The server treats a repeat of an earlier committed
 * `(sessionId, actionId)` as the same gesture: one pending event for the
 * agent's `ggui_consume`, one `user.submitted` row in the ledger that
 * `ggui_runtime_pull` serves, even when both requests are in flight at once.
 * An `actionId` reused for a DIFFERENT gesture keeps the first.
 *
 * SHOULD LEVEL THIS RELEASE. §11.1 states the promise as a SHOULD and makes
 * it a MUST in the next release, so a case that does not hold is reported
 * `warned`, never `failed`. The next release moves every case to `failed`.
 *
 * Vendor-neutral by construction: the kit imports no server. The adopter
 * supplies a {@link ToolCallDriver} (the same one the `domain-error` catalog
 * takes) and a {@link DispatchIdempotencyHost.openSession} seam that opens a
 * live session declaring the kit's action, with a pending-event pipe, and
 * later closes it. Nothing on the wire mints such a session without
 * generation, which is why it is a host seam. A host that supplies no seam,
 * or binds none of the three tools, is SKIPPED with the reason named.
 *
 * What the cases are built to catch, beyond "no dedupe at all": the control
 * repeats the SAME gesture under a new id, so a server that dedupes by content
 * rather than by id loses it; the ids repeat across cases, each in a fresh
 * session, so a server that dedupes by id across sessions loses the later
 * cases' first gesture; and the concurrent case puts both requests in flight
 * at once, so a check-then-write dedupe lets both through. A driver that
 * throws, or a read that answers `isError`, is named on its case rather than
 * read as an empty pipe.
 *
 * Not graded here: whether a repeat re-spends a one-shot action. That clause
 * of §11.1 is visible only inside the server, and the first-party server's
 * own tests grade it.
 */
import type { ActionSpec } from '@ggui-ai/protocol';
import type { ToolCallArgs, ToolCallDriver, RawToolCallResult } from '../domain-error-conformance/index.js';

/** The one action every case dispatches; the host's session must declare it. */
export const DISPATCH_IDEMPOTENCY_ACTION = 'pick' as const;

/**
 * The action spec the host's session declares: one action whose payload is
 * `{ choice: string }`. Declared in full because a contract gate treats an
 * object schema as closed, and the cases tell gestures apart by `choice`.
 */
export const DISPATCH_IDEMPOTENCY_ACTION_SPEC: ActionSpec = {
  [DISPATCH_IDEMPOTENCY_ACTION]: {
    label: 'Pick',
    schema: { type: 'object', properties: { choice: { type: 'string' } }, required: ['choice'] },
  },
};

/** A live session the host opened for one case, and how to release it. */
export interface DispatchIdempotencySession {
  readonly sessionId: string;
  readonly appId: string;
  close(): Promise<void>;
}

/** What the adopter supplies. */
export interface DispatchIdempotencyHost {
  readonly callTool: ToolCallDriver;
  /**
   * Open a fresh session declaring {@link DISPATCH_IDEMPOTENCY_ACTION_SPEC},
   * with its pending-event pipe open. The seam owns cleanup: the kit calls
   * `close()` after the case, whatever its outcome.
   */
  readonly openSession?: () => Promise<DispatchIdempotencySession>;
}

export type DispatchIdempotencyCaseName =
  | 'sequential-retry-is-one-gesture'
  | 'concurrent-retry-is-one-gesture'
  | 'reused-id-keeps-the-first-gesture';

export interface DispatchIdempotencyCaseResult {
  /** Reported as `dispatch-idempotency/<name>`. */
  readonly name: DispatchIdempotencyCaseName;
  readonly detail: string;
}

export interface DispatchIdempotencyResult {
  readonly passed: readonly DispatchIdempotencyCaseResult[];
  /** SHOULD level: a case that does not hold lands here, not in `failed`. */
  readonly warned: readonly DispatchIdempotencyCaseResult[];
  readonly failed: readonly DispatchIdempotencyCaseResult[];
  readonly skipped: readonly DispatchIdempotencyCaseResult[];
}

const CASES: readonly DispatchIdempotencyCaseName[] = [
  'sequential-retry-is-one-gesture',
  'concurrent-retry-is-one-gesture',
  'reused-id-keeps-the-first-gesture',
];

/**
 * The ids every case uses. The SAME ids in every case, each case in its own
 * session: the promise is per `(sessionId, actionId)`, so a later case's first
 * dispatch is a new gesture, and a server that remembers ids across sessions
 * drops it.
 */
const X = 'kit-1519-x';
const Y = 'kit-1519-y';

/** Thrown inside a case when the host cannot run it at all (a tool unbound). */
class Unbound extends Error {}

function field(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined;
}

function dispatchArgs(session: DispatchIdempotencySession, actionId: string, choice: string): ToolCallArgs {
  return {
    sessionId: session.sessionId,
    appId: session.appId,
    kind: 'dispatch',
    actionId,
    firedAt: '2026-09-29T00:00:00.000Z',
    payload: { intent: DISPATCH_IDEMPOTENCY_ACTION, actionData: { choice }, uiContext: {} },
  };
}

async function call(host: DispatchIdempotencyHost, tool: string, args: ToolCallArgs): Promise<RawToolCallResult> {
  const result = await host.callTool({ tool, args });
  if (result === null) throw new Unbound(`${tool} is not bound on this deployment`);
  return result;
}

/** `ok: true` from submit_action, or the declared reuse answer where a case allows it. */
function answerOf(result: RawToolCallResult): string {
  const structured = result.structuredContent;
  if (field(structured, 'ok') === true) return 'ok';
  const code = field(structured, 'code');
  return typeof code === 'string' ? code : result.isError === true ? 'isError' : 'unknown';
}

/**
 * A read tool's `events`, or the reason there are none to count: a read that
 * answered `isError`, or no `events` array, is a problem of its own and not an
 * empty pipe (which would misreport the case as a delivery count).
 */
async function readEvents(
  host: DispatchIdempotencyHost,
  tool: 'ggui_consume' | 'ggui_runtime_pull',
  args: ToolCallArgs,
): Promise<{ readonly events: unknown[] } | { readonly problem: string }> {
  const result = await call(host, tool, args);
  if (result.isError === true) return { problem: `${tool} answered isError` };
  const events = field(result.structuredContent, 'events');
  if (!Array.isArray(events)) return { problem: `${tool} answered no events array` };
  return { events };
}

/** Run one case against a fresh session. Returns the reasons it does not hold (empty = holds). */
async function runCase(
  name: DispatchIdempotencyCaseName,
  host: DispatchIdempotencyHost,
  session: DispatchIdempotencySession,
): Promise<string[]> {
  const problems: string[] = [];
  let answers: string[];
  switch (name) {
    case 'sequential-retry-is-one-gesture':
      answers = [
        answerOf(await call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'a'))),
        answerOf(await call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'a'))),
      ];
      break;
    case 'concurrent-retry-is-one-gesture':
      answers = (
        await Promise.all([
          call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'a')),
          call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'a')),
        ])
      ).map(answerOf);
      break;
    case 'reused-id-keeps-the-first-gesture':
      answers = [
        answerOf(await call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'a'))),
        answerOf(await call(host, 'ggui_runtime_submit_action', dispatchArgs(session, X, 'b'))),
      ];
      break;
  }
  // Control: the SAME gesture under a DISTINCT id is a second gesture, so a
  // server that drops every dispatch, every second one, or every repeat of
  // content, cannot pass.
  const control = answerOf(await call(host, 'ggui_runtime_submit_action', dispatchArgs(session, Y, 'a')));

  const reuseCase = name === 'reused-id-keeps-the-first-gesture';
  if (answers[0] !== 'ok') problems.push(`the first dispatch answered ${answers[0]}, not ok`);
  // The repeat is answered as the first was; a reuse may instead be refused
  // ACTION_ID_REUSED (declared this release, emitted from the next).
  if (!(answers[1] === 'ok' || (reuseCase && answers[1] === 'ACTION_ID_REUSED'))) {
    problems.push(`the repeat answered ${answers[1]}${reuseCase ? ', not ok or ACTION_ID_REUSED' : ', not as the first'}`);
  }
  if (control !== 'ok') problems.push(`the control (a distinct actionId) answered ${control}, not ok`);

  // One consume: it clears what it returns, so a second would read nothing.
  const drained = await readEvents(host, 'ggui_consume', { sessionId: session.sessionId, timeout: 0 });
  if ('problem' in drained) {
    problems.push(drained.problem);
  } else {
    const events = drained.events.filter((e) => field(e, 'actionId') === X).map((e) => field(e, 'actionData'));
    if (events.length !== 1) problems.push(`ggui_consume delivered ${events.length} events for the repeated actionId, not 1`);
    if (reuseCase && events.length === 1 && field(events[0], 'choice') !== 'a') {
      problems.push('the delivered event is not the first gesture');
    }
    const controlEvents = drained.events.filter((e) => field(e, 'actionId') === Y).length;
    if (controlEvents !== 1) problems.push(`the control's gesture was delivered ${controlEvents} times, not once`);
  }
  const ledger = await readEvents(host, 'ggui_runtime_pull', { sessionId: session.sessionId, sinceSequence: 0, limit: 100 });
  if ('problem' in ledger) {
    problems.push(ledger.problem);
  } else {
    const rowsFor = (id: string) =>
      ledger.events.filter((e) => field(e, 'type') === 'user.submitted' && field(field(e, 'data'), 'actionId') === id)
        .length;
    const rows = rowsFor(X);
    if (rows !== 1) problems.push(`the ledger holds ${rows} user.submitted rows for the repeated actionId, not 1`);
    const controlRows = rowsFor(Y);
    if (controlRows !== 1) problems.push(`the control's gesture has ${controlRows} ledger rows, not 1`);
  }
  return problems;
}

/** Run the catalog. Each case gets its own session from the host's seam. */
export async function runDispatchIdempotencyConformance(
  host: DispatchIdempotencyHost,
): Promise<DispatchIdempotencyResult> {
  const passed: DispatchIdempotencyCaseResult[] = [];
  const warned: DispatchIdempotencyCaseResult[] = [];
  const skipped: DispatchIdempotencyCaseResult[] = [];
  for (const name of CASES) {
    if (!host.openSession) {
      skipped.push({ name, detail: 'the host supplies no openSession seam, so no session declares the kit action' });
      continue;
    }
    const session = await host.openSession();
    try {
      const problems = await runCase(name, host, session);
      if (problems.length === 0) passed.push({ name, detail: 'one gesture: one consumed event and one ledger row' });
      else warned.push({ name, detail: problems.join('; ') });
    } catch (err) {
      // An unbound tool skips the case. Any other throw (the driver's, or the
      // server's through it) is the case not holding, named, and the run goes
      // on: one case's transport failure grades that case only.
      if (err instanceof Unbound) skipped.push({ name, detail: err.message });
      else warned.push({ name, detail: `the case threw: ${err instanceof Error ? err.message : String(err)}` });
    } finally {
      await session.close();
    }
  }
  return { passed, warned, failed: [], skipped };
}
