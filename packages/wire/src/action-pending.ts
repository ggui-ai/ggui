import { createContext, useCallback, useContext, useSyncExternalStore } from 'react';

/**
 * Whether a card's action is waiting for the agent's answer, as data
 * (ggui#1398).
 *
 * An action is pending from the moment this card's dispatch of it COMMITS (the
 * envelope was handed to the transport, so the agent will receive it) until
 * the session's next frame lands: a props update, an amend, a new render for
 * the same session. That frame is the agent's answer. So that a host that never
 * answers cannot leave a control frozen, pending also clears after a bound
 * (20 s by default). A dispatch the validator refused, or a suppressed repeat
 * of a spent `oneShot` action, never reached the agent and is never pending.
 */
export interface ActionPendingSource {
  /** `true` iff this card dispatched `actionName` and no answer has landed yet. */
  readonly isPending: (actionName: string) => boolean;
  /** Notified whenever an action becomes pending or stops being pending. Returns the unsubscribe. */
  readonly subscribe: (listener: () => void) => () => void;
}

/**
 * The runtime provides the card's {@link ActionPendingSource} here. Like
 * `ActionSpentContext`, it is reachable only through `@ggui-ai/wire/internal`,
 * so generated component code reads pending state through
 * {@link useActionPending} and cannot provide its own.
 */
export const ActionPendingContext = createContext<ActionPendingSource | null>(null);

const noSubscription = (): (() => void) => () => undefined;

/**
 * Whether this card's action `actionName` was dispatched and is still waiting
 * for the agent's answer, so the control can show it is working (disabled,
 * `aria-busy`, "Sending…") instead of looking untouched while the agent
 * reacts.
 *
 * `true` from the committed dispatch until the session's next frame lands, or
 * the bound elapses. It is reactive. It returns data only: how a pending
 * control looks is the component's choice. Outside a runtime that provides
 * pending state, it is `false`.
 *
 * @example
 * const send = useAction<ActionSendPayload>('send');
 * const sending = useActionPending('send');
 *
 * // In JSX — the control shows it is working until the agent's answer repaints the card:
 * <Button variant="primary" disabled={sending} aria-busy={sending} onClick={() => send({ text })}>
 *   {sending ? 'Sending…' : 'Send'}
 * </Button>
 */
export function useActionPending(actionName: string): boolean {
  const source = useContext(ActionPendingContext);
  const subscribe = useCallback(
    (listener: () => void) => (source === null ? noSubscription() : source.subscribe(listener)),
    [source],
  );
  const read = useCallback(() => (source === null ? false : source.isPending(actionName)), [source, actionName]);
  return useSyncExternalStore(subscribe, read, read);
}
