/**
 * useStackNavigation — React hook for navigating ggui stack items.
 *
 * Wraps the pure shared reducer with React state management.
 * Auto-follows new pushes by default; disables auto-follow when
 * the user manually navigates away from the latest item.
 */

import { useReducer, useEffect, useCallback, useMemo } from 'react';
import type { StackItem } from '@ggui-ai/protocol';
import {
  stackNavigationReducer,
  initialNavigationState,
} from '@ggui-ai/protocol';
import type { StackNavigationState, StackNavigationAction } from '@ggui-ai/protocol';

export interface UseStackNavigationOptions {
  /** Auto-follow new stack pushes (default: true) */
  autoFollow?: boolean;
}

export interface UseStackNavigationReturn {
  /** Currently viewed stack index */
  currentIndex: number;
  /** Currently viewed stack item (undefined if stack is empty) */
  currentItem: StackItem | undefined;
  /** Whether the stack overview panel is open */
  overviewOpen: boolean;
  /** Navigate to a specific stack index */
  goToIndex: (i: number) => void;
  /** Navigate to the first stack item */
  goHome: () => void;
  /** Navigate to the previous stack item */
  goBack: () => void;
  /** Navigate to the next stack item */
  goForward: () => void;
  /** Toggle the stack overview panel */
  toggleOverview: () => void;
  /** Close the stack overview panel */
  closeOverview: () => void;
  /** Whether back navigation is possible */
  canGoBack: boolean;
  /** Whether forward navigation is possible */
  canGoForward: boolean;
  /** Whether the current index is the first item */
  isHome: boolean;
  /** Number of items in the stack */
  stackLength: number;
}

/**
 * Hook for navigating a ggui session's stack items.
 *
 * @example
 * ```tsx
 * const nav = useStackNavigation(stack);
 * // nav.currentItem — the item to render
 * // nav.goBack() — navigate back
 * // nav.toggleOverview() — show/hide stack overview
 * ```
 */
export function useStackNavigation(
  stack: StackItem[],
  options?: UseStackNavigationOptions,
): UseStackNavigationReturn {
  const stackLength = stack.length;

  // Wrap the pure reducer so it always receives current stackLength
  const wrappedReducer = useCallback(
    (state: StackNavigationState, action: StackNavigationAction) =>
      stackNavigationReducer(state, action, stackLength),
    [stackLength],
  );

  const [state, dispatch] = useReducer(wrappedReducer, {
    ...initialNavigationState,
    autoFollow: options?.autoFollow ?? true,
  });

  // Sync stack length changes into the reducer
  useEffect(() => {
    dispatch({ type: 'STACK_UPDATED', stackLength });
  }, [stackLength]);

  const goToIndex = useCallback((i: number) => dispatch({ type: 'GO_TO_INDEX', index: i }), []);
  const goHome = useCallback(() => dispatch({ type: 'GO_HOME' }), []);
  const goBack = useCallback(() => dispatch({ type: 'GO_BACK' }), []);
  const goForward = useCallback(() => dispatch({ type: 'GO_FORWARD' }), []);
  const toggleOverview = useCallback(() => dispatch({ type: 'TOGGLE_OVERVIEW' }), []);
  const closeOverview = useCallback(() => dispatch({ type: 'CLOSE_OVERVIEW' }), []);

  return useMemo(
    () => ({
      currentIndex: state.currentIndex,
      currentItem: stack[state.currentIndex],
      overviewOpen: state.overviewOpen,
      goToIndex,
      goHome,
      goBack,
      goForward,
      toggleOverview,
      closeOverview,
      canGoBack: state.currentIndex > 0,
      canGoForward: state.currentIndex < stackLength - 1,
      isHome: state.currentIndex === 0,
      stackLength,
    }),
    [state, stack, stackLength, goToIndex, goHome, goBack, goForward, toggleOverview, closeOverview],
  );
}
