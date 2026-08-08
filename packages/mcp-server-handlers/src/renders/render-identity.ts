/**
 * Render-identity write-through — the best-effort side write that
 * accompanies every render commit.
 *
 * The record it produces is what lets a
 * `ui://ggui/render/{sessionId}/{contractKey}` locator re-create a
 * render after the render row itself is gone. Writing it is optional
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
   * Registered blueprint id, or `null` when none is resolved yet.
   * Cold generation commits before registration mints the id, so that
   * path writes `null` and backfills via
   * {@link backfillRenderIdentityBlueprintId} once it resolves.
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
 * Named structured event for a failed identity write. Emitted as one
 * JSON line so log pipelines can filter on `msg` without parsing prose
 * (same shape as this package's other best-effort write events).
 */
const WRITE_FAILED_EVENT = 'render_identity_write_failed';

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
    ...(session.userId !== undefined ? { userId: session.userId } : {}),
    ...(session.endUserIdentity !== undefined
      ? { endUserIdentity: session.endUserIdentity }
      : {}),
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
  failureEvent: string = WRITE_FAILED_EVENT,
): Promise<void> {
  if (!store) return;
  try {
    await store.put(projectRenderIdentityRecord(session, identity));
  } catch (err) {
    logRenderIdentityFailure(failureEvent, session.id, session.appId, err);
  }
}

/**
 * Set `blueprintId` on an existing record once cold-gen registration
 * resolves it. `put` replaces whole records, so this reads the current
 * one and writes the merged result back.
 *
 * A missing record is a normal outcome, not an error: the write-through
 * that would have created it may itself have failed, or no store was
 * bound when the render committed. There is nothing to backfill onto,
 * and inventing a record from the id alone would be a record with no
 * identity — so we skip.
 */
export async function backfillRenderIdentityBlueprintId(
  store: RenderIdentityStore | undefined,
  session: { readonly sessionId: string; readonly appId: string },
  blueprintId: string,
): Promise<void> {
  if (!store) return;
  try {
    const existing = await store.get(session.sessionId);
    if (!existing) return;
    await store.put({ ...existing, blueprintId, updatedAt: Date.now() });
  } catch (err) {
    logRenderIdentityFailure(
      WRITE_FAILED_EVENT,
      session.sessionId,
      session.appId,
      err,
    );
  }
}

function logRenderIdentityFailure(
  event: string,
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
