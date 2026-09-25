import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * The spent state of a card's `oneShot` actions, as data (ggui#1223).
 *
 * The one-shot guard in {@link buildWireConfig} decides whether a dispatch of
 * a `oneShot` action is suppressed. This source answers the same question
 * BEFORE any gesture, from the SAME set: the action is spent iff the active
 * action spec declares it `oneShot` AND the name is in the card's spent set,
 * meaning this render's committed dispatches plus the persisted record the host
 * re-serves (`getSpentOneShots`). An action not declared `oneShot` is never
 * spent; the flag comes from the contract, never from a name.
 */
export interface ActionSpentSource {
  /** `true` iff `actionName` is declared `oneShot` and already spent. */
  readonly isSpent: (actionName: string) => boolean;
  /**
   * Notified when the answer can change without a re-render: this card's own
   * committed dispatch of a `oneShot` action. Changes that arrive with a render
   * update (a props patch, a record carried on a later frame) are read on that
   * render. Returns the unsubscribe.
   */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The runtime provides the card's {@link ActionSpentSource} here. It is
 * reachable only through `@ggui-ai/wire/internal`, so generated component code
 * reads spent state through {@link useActionSpent} and cannot replace it.
 */
export const ActionSpentContext = createContext<ActionSpentSource | null>(null);

const noSubscription = (): (() => void) => () => undefined;

/**
 * Whether the card's `oneShot` action `actionName` is already spent, so a
 * component can paint its control as submitted on the first paint, with no
 * press needed to find out.
 *
 * `true` iff the contract declares `actionName` `oneShot` and the card already
 * fired it, either in this render or before a reload (the record the host
 * re-serves). It is reactive, flipping to `true` when this card's own dispatch
 * commits. It returns data only: how a spent control looks (disabled,
 * "Submitted", hidden) is the component's choice. Outside a runtime that
 * provides spent state, it is `false` and the dispatch guard still holds.
 */
export function useActionSpent(actionName: string): boolean {
  const source = useContext(ActionSpentContext);
  const subscribe = useCallback(
    (listener: () => void) => (source === null ? noSubscription() : source.subscribe(listener)),
    [source],
  );
  const read = useCallback(() => (source === null ? false : source.isSpent(actionName)), [source, actionName]);
  return useSyncExternalStore(subscribe, read, read);
}
