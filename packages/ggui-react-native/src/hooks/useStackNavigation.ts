/**
 * useStackNavigation — React Native hook for navigating ggui stack items.
 *
 * Identical to the web version — both use only React APIs.
 * Wraps the pure shared reducer with React state management.
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
  currentIndex: number;
  currentItem: StackItem | undefined;
  overviewOpen: boolean;
  goToIndex: (i: number) => void;
  goHome: () => void;
  goBack: () => void;
  goForward: () => void;
  toggleOverview: () => void;
  closeOverview: () => void;
  canGoBack: boolean;
  canGoForward: boolean;
  isHome: boolean;
  stackLength: number;
}

export function useStackNavigation(
  stack: StackItem[],
  options?: UseStackNavigationOptions,
): UseStackNavigationReturn {
  const stackLength = stack.length;

  const wrappedReducer = useCallback(
    (state: StackNavigationState, action: StackNavigationAction) =>
      stackNavigationReducer(state, action, stackLength),
    [stackLength],
  );

  const [state, dispatch] = useReducer(wrappedReducer, {
    ...initialNavigationState,
    autoFollow: options?.autoFollow ?? true,
  });

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
