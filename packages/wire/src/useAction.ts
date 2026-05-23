import { useCallback } from 'react';
import { useWireContext } from './context';
import { tryAcceptDispatch } from './dispatch-dedup';

/**
 * Fire an action to the agent. Fire-and-forget — no response, no pending state.
 *
 * Protocol V4: when the action contract sets `actions[name].tool`, the platform
 * routes the dispatch to that named MCP tool server-side. The component code is
 * identical — call `useAction(name)(payload)` either way. Treat the tool name
 * as informational (use it to inform button labels, icons, copy).
 *
 * RUNTIME DEDUP (backstop, not a feature). Same-`(name, payload)` calls within
 * one event-loop task are coalesced — the first wins, subsequent duplicates
 * are suppressed. This is the structural defense against LLM-generated
 * nested-interactive components where a Checkbox `onChange` and an outer
 * `Card as={Clickable}` `onClick` both wire to the same `useAction` binding;
 * the inner gesture bubbles to the outer handler, so without dedup one user
 * click would fire the action twice (a toggle would run back-to-back and the
 * user's change would disappear). **Do not rely on this as a feature** — wire
 * each `useAction` callback to exactly ONE interactive surface; the dedup
 * exists only because the LLM's source code can be wrong in subtle ways and
 * the runtime is the only place that can see the actual event-bubble path.
 * See `dispatch-dedup.ts` for the full failure-mode rationale.
 *
 * NEVER SILENT. When the dedup fires, a `console.warn` is emitted in BOTH dev
 * and prod with the full diagnostic. The suppression is always visible in
 * browser DevTools; operators investigating a "the second click does nothing"
 * report see the warning immediately. Hosts that want structured telemetry
 * (Sentry, Datadog, server logs) can additionally set
 * {@link WireConfig.onDispatchSuppressed} on the provided `WireConfig`.
 *
 * @param actionName - Action name from the action contract
 * @returns Stable callback that dispatches the action
 */
export function useAction<T = unknown>(actionName: string): (data: T) => void {
  const { dispatch, onDispatchSuppressed } = useWireContext();
  return useCallback(
    (data: T) => {
      const decision = tryAcceptDispatch(actionName, data);
      if (decision.suppressed) {
        // eslint-disable-next-line no-console
        console.warn(
          `[ggui] useAction('${actionName}') suppressed a duplicate dispatch ` +
            `(same name + payload, same event-loop task). This usually means ` +
            `two interactive elements nest and both wire to the same action ` +
            `(e.g. a Checkbox onChange inside a Card as={Clickable} onClick); ` +
            `the inner gesture bubbles to the outer handler so one user click ` +
            `would fire the action twice. Wire each useAction callback to ` +
            `exactly ONE interactive surface. Tier-0 'double-wired-action' ` +
            `warns on this at gen time; this runtime defense ensures the ` +
            `user-visible behavior stays correct regardless of code shape.`,
        );
        if (onDispatchSuppressed) {
          // Errors thrown by host observers must not break the agent
          // wire. Swallow + log so a bad telemetry sink can't poison
          // subsequent dispatches.
          try {
            onDispatchSuppressed({
              actionName,
              payloadSignature: decision.signature,
              payload: data,
              suppressedAt: Date.now(),
            });
          } catch (err) {
            // eslint-disable-next-line no-console
            console.warn(
              `[ggui] onDispatchSuppressed observer threw — ignoring:`,
              err,
            );
          }
        }
        return;
      }
      dispatch(actionName, data);
    },
    [actionName, dispatch, onDispatchSuppressed],
  );
}
