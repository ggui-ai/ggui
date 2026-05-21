import { useCallback } from 'react';
import { useWireContext } from './context';

/**
 * Fire an action to the agent. Fire-and-forget — no response, no pending state.
 *
 * Protocol V4: when the action contract sets `actions[name].tool`, the platform
 * routes the dispatch to that named MCP tool server-side. The component code is
 * identical — call `useAction(name)(payload)` either way. Treat the tool name
 * as informational (use it to inform button labels, icons, copy).
 *
 * @param actionName - Action name from the action contract
 * @returns Stable callback that dispatches the action
 */
export function useAction<T = unknown>(actionName: string): (data: T) => void {
  const { dispatch } = useWireContext();
  return useCallback(
    (data: T) => dispatch(actionName, data),
    [actionName, dispatch],
  );
}
