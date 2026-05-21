/**
 * CanvasShell.
 *
 * Top-level component for canvas-mode iframes. Owns:
 *
 *   1. Layout: animator chrome (centered or navbar) + content area
 *   2. Navigation state via {@link NavStackModel}
 *   3. Active stack-item mount (one at a time — the top of navStack)
 *   4. Display-mode escalation requests (escalation policy applied at
 *      navStack transitions + on host-context-changed)
 *
 * Subscriptions/transport are wired by the parent boot path
 * (`bootProduction` branching on `bootstrap.canvasMode`) — the shell
 * receives a pre-built navStack model, an AnimatorEventStream
 * (subscribed to live-channel lifecycle envelopes), and callbacks for
 * the side-effecting concerns (display-mode requests, live-channel
 * `canvas_navigated` envelope emission).
 *
 * Active-item rendering reuses the existing stack-item dispatcher
 * via a render-prop slot.
 *
 * Boundary discipline:
 *
 *   - The shell renders the animator pill via `<AnimatorHost>` — but
 *     doesn't subscribe to the live channel itself. Caller passes the
 *     event stream + nav model in.
 *   - Display-mode requests fire through a caller-supplied callback,
 *     not directly via `requestDisplayModeInParent` from `runtime.ts`.
 *     Keeps the shell testable without DOM/postMessage.
 *   - Back-arrow click → caller-supplied `onBackGesture()` (also lets
 *     the caller emit the `canvas_navigated` envelope).
 */

import { useEffect, useState, type ReactNode } from 'react';
import type { McpUiDisplayMode, SessionStackEntry } from '@ggui-ai/protocol';
import {
  AnimatorHost,
  type AnimatorEventStream,
} from './animator/animator-host.js';
import { NavStackModel } from './nav-stack.js';

export interface CanvasShellProps {
  readonly navStack: NavStackModel;
  readonly events: AnimatorEventStream;
  /**
   * Host's `availableDisplayModes` from `HostContext`. Drives the
   * display-mode escalation policy. Undefined when the host doesn't
   * speak the spec — escalation collapses to a no-op.
   */
  readonly availableDisplayModes?: readonly McpUiDisplayMode[];
  /** Host's current display mode. Tracks updates from `host-context-changed`. */
  readonly currentDisplayMode?: McpUiDisplayMode;
  /**
   * Fire a `ui/request-display-mode` postMessage to the host. The
   * shell calls this when {@link reconcileDisplayMode} returns a
   * `request` decision. Tests inject a recorder; production wires it
   * to `requestDisplayModeInParent` from `runtime.ts`.
   */
  readonly onRequestDisplayMode: (mode: McpUiDisplayMode) => void;
  /**
   * Called when the user back-navigates. The shell handles the local
   * `navStack.pop()`; this callback lets the caller emit the
   * `canvas_navigated` envelope on the live channel + any other side effects.
   */
  readonly onBackGesture: (args: {
    readonly previousActiveItemId: string;
    readonly activeItemId: string | null;
  }) => void;
  /**
   * Render-prop for the active stack item. Called with the current
   * top of navStack (or null when empty); production wires this to
   * `mountStackItem` from `stack-item-renderer.ts`. Tests inject a
   * simple component.
   *
   * Why a render-prop: keeps the shell testable without the full
   * `mountStackItem` dependency graph (WireConfig, StreamBus, theme
   * resolution, ContextStateHost) — those are bootProduction's
   * concern, not the shell's.
   */
  readonly renderActiveItem: (item: SessionStackEntry | null) => ReactNode;
}

export function CanvasShell({
  navStack,
  events,
  onBackGesture,
  renderActiveItem,
}: CanvasShellProps): ReactNode {
  // Subscribe to navStack's version counter so React re-renders when
  // it mutates. Mirrors useSyncExternalStore pattern with a manual
  // useState bridge (avoids a React 18+ requirement for the
  // dependency that's not necessarily satisfied in older callers).
  //
  // Uses `onMutation` (not `onNavChange`) so in-place replaces from
  // `ggui_update` props patches re-render too — otherwise the active
  // item shows stale props after the first turn. The version value
  // itself is unread — only the setVersion side effect matters.
  const [, setVersion] = useState(navStack.version());
  useEffect(() => {
    const unsubscribe = navStack.onMutation(() => {
      setVersion(navStack.version());
    });
    return unsubscribe;
  }, [navStack]);

  // Layout selector — centered animator pill (empty) vs. navbar
  // (content present). The version-tracked `useState` above ensures
  // this re-evaluates on every navStack mutation.
  const contentState: 'empty' | 'has-content' =
    navStack.size() === 0 ? 'empty' : 'has-content';

  // Display-mode escalation is policy-driven by `reconcileDisplayMode`,
  // but auto-firing it on every navStack transition is too aggressive:
  // a canvas with one item would silently request `fullscreen`, taking
  // over the host's viewport without user intent. The policy stays in
  // the codebase + remains tested for the eventual user-driven trigger
  // (e.g. a fullscreen-toggle control in the animator chrome), but the
  // shell does NOT auto-fire it. `onRequestDisplayMode` is wired on
  // the props; the call site moves from here to whatever UI affordance
  // gives the user explicit consent. Until then: display mode only
  // changes when the user requests it manually.

  const activeItem = navStack.peek();

  const handleBack = (): void => {
    const previous = navStack.peek();
    if (!previous) return;
    const newActive = navStack.pop();
    onBackGesture({
      previousActiveItemId: previous.id,
      activeItemId: newActive?.id ?? null,
    });
  };

  // Inline layout styles for the placeholder shell. Designer pass
  // refines exact dimensions / transitions.
  const containerStyle = {
    position: 'relative' as const,
    width: '100%',
    height: '100%',
    display: 'flex',
    flexDirection: 'column' as const,
    overflow: 'hidden' as const,
  };
  const navbarStyle = {
    flexShrink: 0,
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '8px 12px',
    borderBottom:
      '1px solid var(--ggui-color-outlineVariant, rgba(148, 163, 184, 0.2))',
    background: 'var(--ggui-color-surface, rgba(255, 255, 255, 0.98))',
  };
  const contentStyle = {
    flex: 1,
    overflow: 'auto' as const,
    position: 'relative' as const,
  };
  const emptyStateStyle = {
    flex: 1,
    position: 'relative' as const,
  };

  if (contentState === 'empty') {
    return (
      <div style={containerStyle} data-ggui-canvas-shell="empty">
        <div style={emptyStateStyle}>
          <AnimatorHost events={events} layout="centered" />
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle} data-ggui-canvas-shell="content">
      <div style={navbarStyle} data-ggui-canvas-navbar="true">
        {navStack.size() > 1 ? (
          <button
            type="button"
            onClick={handleBack}
            aria-label="Go back"
            data-ggui-canvas-back="true"
            style={{
              background: 'transparent',
              border: 'none',
              cursor: 'pointer',
              padding: '4px 8px',
              fontSize: 16,
              color: 'var(--ggui-color-onSurface, #1a1a1a)',
            }}
          >
            ←
          </button>
        ) : null}
        <AnimatorHost events={events} layout="navbar" />
      </div>
      <div style={contentStyle} data-ggui-canvas-content="true">
        {renderActiveItem(activeItem)}
      </div>
    </div>
  );
}
