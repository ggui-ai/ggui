/**
 * ggui#1223 / #1305 — record a COMMITTED `oneShot` dispatch on its card, so
 * a re-served card renders the action spent after a reload.
 *
 * ONE decision, called by both ingress paths after the write each treats as
 * load-bearing: the live channel's `data:submit` after its ledger append,
 * and `ggui_runtime_submit_action` after its pipe append. "Committed" means
 * the same thing the runtime's wire guard means by it (spend only on a fire
 * that passed the card's contract), so the decision evaluates the contract
 * itself. It never changes whether a path ACCEPTS a dispatch: a dispatch the
 * contract rejects is delivered exactly as before and simply does not spend.
 *
 * The card is the head card unless the dispatch names another. A named
 * epoch other than the head's is a superseded card: nothing is written,
 * because the projection only ever shows a record on its own card, and a
 * superseded card re-serves frozen (#483). Absent ⇒ the head, which is what
 * every dispatch means before the wire carries a card epoch.
 */
import { validateActionData, type GguiSession } from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';

/**
 * What {@link recordCommittedOneShot} decided. Every arm but `recorded` wrote
 * nothing, and none of them is an error: a caller logs only a thrown store
 * failure (fail-open, the gesture has already been delivered).
 */
export type CommittedOneShotOutcome =
  /** The store applied the spend (a repeat of an already-spent action included). */
  | 'recorded'
  /** The card does not declare this action `oneShot` (or is not a component card). */
  | 'not-one-shot'
  /** The dispatch failed the card's action contract, so it never spends. */
  | 'not-committed'
  /** The dispatch named a card that is no longer the head. */
  | 'superseded-card'
  /** The store does not implement `recordSpentOneShot`; named once at server construction. */
  | 'not-durable';

export interface RecordCommittedOneShotInput {
  readonly store: GguiSessionStore;
  readonly sessionId: string;
  /** The render as stored: the head card, its `actionSpec` and its `epoch`. */
  readonly render: GguiSession;
  /** The dispatched `actionSpec` name. */
  readonly action: string;
  /** The dispatched payload (`ActionEventValue.data`). */
  readonly data: unknown;
  /** The dispatching card's history epoch, when the dispatch carries one. */
  readonly cardEpoch?: number;
}

/**
 * Decide and, when the dispatch is a committed `oneShot` on the head card,
 * record it. A store failure propagates: the caller owns its named warn line.
 */
export async function recordCommittedOneShot(
  input: RecordCommittedOneShotInput,
): Promise<CommittedOneShotOutcome> {
  const { render, action } = input;
  if (render.type !== 'component') return 'not-one-shot';
  const spec = render.actionSpec;
  if (spec?.[action]?.oneShot !== true) return 'not-one-shot';
  if (!validateActionData({ action, data: input.data }, spec).valid) return 'not-committed';
  const headEpoch = render.epoch ?? 0;
  const epoch = input.cardEpoch ?? headEpoch;
  if (epoch !== headEpoch) return 'superseded-card';
  if (input.store.recordSpentOneShot === undefined) return 'not-durable';
  await input.store.recordSpentOneShot(input.sessionId, { epoch, action });
  return 'recorded';
}
