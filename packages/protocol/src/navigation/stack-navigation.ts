/**
 * Stack Navigation — pure reducer for navigating ggui stack items.
 *
 * Framework-agnostic state machine. Used by both @ggui-ai/react and
 * @ggui-ai/react-native hooks.
 */

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Actions that can be dispatched to the {@link stackNavigationReducer}.
 *
 * - `GO_TO_INDEX` -- Navigate to a specific stack index (clamped to valid range)
 * - `GO_HOME` -- Navigate to the first item (index 0)
 * - `GO_BACK` -- Navigate one item backward (no-op if already at index 0)
 * - `GO_FORWARD` -- Navigate one item forward (no-op if already at the latest)
 * - `STACK_UPDATED` -- Notify the reducer that the stack length changed (push/pop)
 * - `TOGGLE_OVERVIEW` -- Toggle the stack overview panel open/closed
 * - `CLOSE_OVERVIEW` -- Close the stack overview panel
 */
export type StackNavigationAction =
  | { type: 'GO_TO_INDEX'; index: number }
  | { type: 'GO_HOME' }
  | { type: 'GO_BACK' }
  | { type: 'GO_FORWARD' }
  | { type: 'STACK_UPDATED'; stackLength: number }
  | { type: 'TOGGLE_OVERVIEW' }
  | { type: 'CLOSE_OVERVIEW' };

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export interface StackNavigationState {
  /** Currently viewed stack index */
  currentIndex: number;
  /** Whether the stack overview panel is open */
  overviewOpen: boolean;
  /**
   * When true, the navigator auto-follows new pushes (jumps to latest item).
   * Disabled when the user manually navigates away from the latest item.
   */
  autoFollow: boolean;
}

export const initialNavigationState: StackNavigationState = {
  currentIndex: 0,
  overviewOpen: false,
  autoFollow: true,
};

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/**
 * Pure reducer for stack navigation state.
 *
 * @param state   Current navigation state
 * @param action  Navigation action to dispatch
 * @param stackLength  Current number of items in the stack
 */
export function stackNavigationReducer(
  state: StackNavigationState,
  action: StackNavigationAction,
  stackLength: number,
): StackNavigationState {
  const maxIndex = Math.max(0, stackLength - 1);

  switch (action.type) {
    case 'GO_TO_INDEX': {
      const clamped = Math.max(0, Math.min(action.index, maxIndex));
      return {
        ...state,
        currentIndex: clamped,
        overviewOpen: false,
        // Disable auto-follow if user navigated away from latest
        autoFollow: clamped === maxIndex,
      };
    }

    case 'GO_HOME':
      return {
        ...state,
        currentIndex: 0,
        overviewOpen: false,
        autoFollow: maxIndex === 0,
      };

    case 'GO_BACK':
      if (state.currentIndex <= 0) return state;
      return {
        ...state,
        currentIndex: state.currentIndex - 1,
        autoFollow: false,
      };

    case 'GO_FORWARD':
      if (state.currentIndex >= maxIndex) return state;
      return {
        ...state,
        currentIndex: state.currentIndex + 1,
        autoFollow: state.currentIndex + 1 === maxIndex,
      };

    case 'STACK_UPDATED': {
      const newMax = Math.max(0, action.stackLength - 1);
      // If auto-follow is on, jump to the latest item
      if (state.autoFollow) {
        return {
          ...state,
          currentIndex: newMax,
        };
      }
      // Otherwise, clamp to valid range (handles pops)
      return {
        ...state,
        currentIndex: Math.min(state.currentIndex, newMax),
      };
    }

    case 'TOGGLE_OVERVIEW':
      return { ...state, overviewOpen: !state.overviewOpen };

    case 'CLOSE_OVERVIEW':
      return { ...state, overviewOpen: false };

    default:
      return state;
  }
}
