/**
 * Render-identity write-through — the best-effort side write that
 * accompanies every render commit.
 *
 * The record it produces is what lets a
 * `ui://ggui/render/{sessionId}/{blueprintKey}` locator re-create a
 * render after the render row itself is gone (the locator's segment is
 * named for its domain; the record's field is `contractKey`). Writing it is optional
 * everywhere: with no {@link RenderIdentityStore} bound, every helper
 * here is a no-op and the render path is byte-for-byte what it was.
 *
 * Failure posture — a write here can NEVER fail a render. The row is
 * already committed and is the source of truth; the identity record is
 * a durability optimization on top of it. Every failure is caught and
 * surfaced as a named structured log event, never rethrown.
 *
 * Shared by `ggui_render` (write-through at each commit site) and the
 * mutation tools that later refresh the same record.
 */
import type {
  RenderIdentityRecord,
  RenderIdentityStore,
  StoredGguiSession,
} from '@ggui-ai/mcp-server-core';

/**
 * The identity slice a caller must supply — the three fields that
 * cannot be read off the committed row. Everything else on the record
 * (tenancy, props, sequence, timestamps) comes from the row itself, so
 * the record can never disagree with what was actually persisted.
 */
export interface RenderIdentityFields {
  /**
   * Registered blueprint id, or `null` when registration did not
   * resolve one for this commit (no cache bound, registration failed
   * or was fail-closed rejected, or a probe/placeholder/error commit).
   * #460: cold generation resolves the id BEFORE its success commit,
   * so records are written complete once — `null` is a terminal state
   * (#445: structurally non-remintable), never a pending one.
   */
  readonly blueprintId: string | null;
  /**
   * MUST be `blueprintKey(contract)` — the 16-char key the blueprint
   * registry addresses a contract by. NEVER the validators-bundle
   * contract hash: they are different lengths and different domains,
   * and a record carrying the wrong one points a locator at nothing.
   */
  readonly contractKey: string;
  /** MUST be `variantKey(variance)` for the same render. */
  readonly variantKey: string;
}

/**
 * Named structured events this module emits, as a closed set.
 *
 * Each is emitted as one JSON line so log pipelines can filter on
 * `msg` without parsing prose (same shape as this package's other
 * best-effort write events). Operators alert on these names, so they
 * are a union rather than a bare `string`: a typo would produce a
 * plausible-looking event that no alert ever matches, and nothing
 * downstream could tell it from the write simply never failing.
 *
 *   - `render_identity_write_failed` — a first write could not be
 *     persisted.
 *   - `render_identity_refresh_failed` — a mutation path could not
 *     refresh an existing record.
 */
export type RenderIdentityFailureEvent =
  | 'render_identity_write_failed'
  | 'render_identity_refresh_failed';

/**
 * The registry: every named event emitted about a render-identity
 * record, by ANY writer — including storage backends outside this
 * package, which import these rather than restating the literals.
 * Enumerable from this one type is the property that makes it a
 * registry; a backend that spells its own string loses it.
 *
 * Two members sit outside {@link RenderIdentityFailureEvent} on
 * purpose, because neither carries a caught error:
 *
 *   - `render_identity_refresh_skipped` — nothing went wrong; there
 *     was simply nothing to refresh. Carries a
 *     {@link RenderIdentitySkipReason}.
 *   - `render_identity_row_unreadable` — a stored record exists but
 *     cannot be read back as a valid one. Not a failed operation and
 *     not a miss: a data-integrity signal, carrying a
 *     {@link RenderIdentityUnreadableReason}.
 *
 * Folding either into the failure union would let a caller pass it
 * where an error is expected, and would tell an operator reading the
 * type that both are things to page on.
 */
export type RenderIdentityEvent =
  | RenderIdentityFailureEvent
  | 'render_identity_refresh_skipped'
  | 'render_identity_row_unreadable'
  | RenderIdentityCapacityEvent;

/**
 * A record written successfully but at a size worth watching. Neither a
 * failure nor a skip — the write HAPPENED — so it sits in its own
 * category: a sizing signal for the offload threshold, not something to
 * page on.
 */
export type RenderIdentityCapacityEvent = 'render_props_over_cap';

/**
 * Why a refresh wrote nothing. Closed for the same reason the event
 * names are: it is a filterable field on a structured event.
 *
 * `no-record-or-not-advanced` is the honest reason for a backend whose
 * refresh is a single conditional write: the condition covers both
 * "no record" and "sequence already at/past this value", and the store
 * does not report which one rejected it.
 */
export type RenderIdentitySkipReason =
  | 'no-record'
  | 'no-record-or-not-advanced';

/**
 * Why a stored row could not be projected back into a record. Distinct
 * from {@link RenderIdentitySkipReason}: a skip means there was
 * nothing to act on, this means there WAS something and it was
 * malformed.
 */
export type RenderIdentityUnreadableReason = 'unparseable-timestamp';

/**
 * WHICH store a failure came from, on paths that touch two of them.
 *
 * A refresh reads the render's own sequence and then writes the
 * identity record; both can fail, and the same event name covers both.
 * Without this, a responder reading `render_identity_refresh_failed`
 * cannot tell whether the render store or the identity store
 * misbehaved, and starts in the wrong place. Closed, because it is a
 * filterable field like the names themselves.
 */
export type RenderIdentityFailureSource =
  | 'render-row-seq-read'
  | 'identity-record-write';

/**
 * The event names as values, so every emitter — in this package or a
 * storage backend elsewhere — spells them from one place. Importing
 * these is what turns a future rename into a compile error instead of
 * an alert filter that silently stops matching.
 */
export const RENDER_IDENTITY_EVENTS = {
  writeFailed: 'render_identity_write_failed',
  refreshFailed: 'render_identity_refresh_failed',
  refreshSkipped: 'render_identity_refresh_skipped',
  rowUnreadable: 'render_identity_row_unreadable',
  propsOverCap: 'render_props_over_cap',
} as const satisfies Record<string, RenderIdentityEvent>;

const WRITE_FAILED_EVENT: RenderIdentityFailureEvent =
  RENDER_IDENTITY_EVENTS.writeFailed;

const REFRESH_FAILED_EVENT: RenderIdentityFailureEvent =
  RENDER_IDENTITY_EVENTS.refreshFailed;

const REFRESH_SKIPPED_EVENT: RenderIdentityEvent =
  RENDER_IDENTITY_EVENTS.refreshSkipped;

/**
 * Project a committed row + its identity slice into the durable
 * record.
 *
 * `createdAt` mirrors the ROW's creation stamp rather than sampling
 * the clock: the record describes exactly one row, and every store
 * preserves `createdAt` across upserts, so a render that commits
 * several times (placeholder → generated, theme overlay) and every
 * later refresh all agree on one value instead of drifting forward.
 */
function projectRenderIdentityRecord(
  session: StoredGguiSession,
  identity: RenderIdentityFields,
): RenderIdentityRecord {
  return {
    sessionId: session.id,
    appId: session.appId,
    // `userId` is the record's whole user story: it is the subject a
    // re-mint authorizes against, and the row carries it on every
    // commit. The row's fuller `endUserIdentity` block is NOT copied
    // here — it would be personal data on an indefinitely-retained
    // record, answering a question `userId` already answers.
    ...(session.userId !== undefined ? { userId: session.userId } : {}),
    blueprintId: identity.blueprintId,
    contractKey: identity.contractKey,
    variantKey: identity.variantKey,
    props: session.render.props,
    seqAtLastCommit: session.eventSequence,
    createdAt: session.createdAt,
    updatedAt: Date.now(),
  };
}

/**
 * Write the identity record for a just-committed render. Best-effort:
 * an absent store is a no-op, and a rejecting store logs
 * `render_identity_write_failed` and returns normally.
 *
 * The caller awaits this, so it adds exactly one store round-trip to
 * the render — never a retry loop, never a background task that
 * outlives the response.
 *
 * `failureEvent` overrides the logged event name for callers whose
 * failure is a distinct operational signal (a refresh on a mutation
 * path is not a first write, and operators alert on them separately).
 */
export async function writeRenderIdentity(
  store: RenderIdentityStore | undefined,
  session: StoredGguiSession,
  identity: RenderIdentityFields,
  failureEvent: RenderIdentityFailureEvent = WRITE_FAILED_EVENT,
): Promise<void> {
  if (!store) return;
  try {
    await store.put(projectRenderIdentityRecord(session, identity));
  } catch (err) {
    logRenderIdentityFailure(failureEvent, session.id, session.appId, err);
  }
}

/**
 * Refresh an EXISTING record after a tool re-committed the render row
 * — `ggui_update` mutating props, `ggui_runtime_sync_context`
 * mirroring a context snapshot.
 *
 * Refreshes only what the row can answer for: props, the sequence at
 * this commit, and `updatedAt`. The identity slice
 * (`blueprintId` / `contractKey` / `variantKey`) is carried forward
 * from the existing record VERBATIM, never recomputed. That is not
 * caution — it is the only correct behaviour available here:
 * `contractKey` is `blueprintKey(agreed contract)`, and the agreed
 * contract lived in the handshake these tools never see. A render row
 * carries its projected specs, not the contract that keyed it, so any
 * key recomputed here would address a different blueprint (or none).
 *
 * For the same reason a MISSING record is skipped rather than
 * created: a record needs an identity, and inventing one would write a
 * locator that points at nothing — strictly worse than no record,
 * because a re-mint would trust it. The skip is announced as
 * `render_identity_refresh_skipped` so an operator who wired a store
 * mid-flight can see which renders predate it.
 *
 * Best-effort throughout, like every write in this module: the tool
 * call succeeds regardless. A consequence worth knowing: because the
 * write rebuilds the WHOLE record from the current row rather than
 * patching fields, any refresh self-heals drift left by an earlier one
 * that failed — a later context sync repairs props and sequence a
 * dropped update-refresh had gone stale on.
 */
export async function refreshRenderIdentity(
  store: RenderIdentityStore | undefined,
  session: StoredGguiSession,
): Promise<void> {
  if (!store) return;
  let existing: RenderIdentityRecord | null;
  try {
    existing = await store.get(session.id);
  } catch (err) {
    logRenderIdentityFailure(
      REFRESH_FAILED_EVENT,
      session.id,
      session.appId,
      err,
    );
    return;
  }
  if (!existing) {
    logRenderIdentitySkipped(session.id, 'no-record');
    return;
  }
  await writeRenderIdentity(
    store,
    session,
    {
      blueprintId: existing.blueprintId,
      contractKey: existing.contractKey,
      variantKey: existing.variantKey,
    },
    REFRESH_FAILED_EVENT,
  );
}

function logRenderIdentitySkipped(
  sessionId: string,
  reason: RenderIdentitySkipReason,
): void {
  // debug, not warn: severity is part of an alertable event's contract,
  // and this one fires on paths where nothing is actionable — a render
  // that predates the store has no record to refresh and never will.
  // The cloud emitter uses debug for the same event; a shared name that
  // pages on one backend and not the other is a broken contract.
  // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup
  console.debug(
    JSON.stringify({ msg: REFRESH_SKIPPED_EVENT, sessionId, reason }),
  );
}

function logRenderIdentityFailure(
  event: RenderIdentityFailureEvent,
  sessionId: string,
  appId: string,
  err: unknown,
): void {
  // eslint-disable-next-line no-console -- structured single-line event for log-pipeline pickup
  console.warn(
    JSON.stringify({
      msg: event,
      sessionId,
      appId,
      error: err instanceof Error ? err.message : String(err),
    }),
  );
}
