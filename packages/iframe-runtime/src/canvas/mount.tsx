/**
 * Canvas mount — wires the React-tree CanvasShell into bootProduction.
 *
 * The canvas-mode iframe is session-scoped — a single React root lives
 * for the lifetime of the session, with the active stack item rendered
 * inside its content slot. This module bridges the React/DOM boundary
 * for that mount:
 *
 *   - Renders `<CanvasShell>` into a host-supplied DOM element.
 *   - Exposes a stable `contentEl` div via `renderActiveItem` that the
 *     existing stack renderer can write into (one slot, swapped per
 *     navStack-top transition).
 *   - Returns a `NavStackModel` so the caller (bootSequence) can keep
 *     it synced with the server's stack snapshots on every ack.
 *   - Returns a dispose handle that unmounts the React tree on
 *     teardown.
 *
 * Why this lives next to `canvas-shell.tsx` instead of `runtime.ts`:
 * keeps the DOM/React seam co-located with the shell so anyone adding
 * a new piece of canvas chrome sees the wiring point. `runtime.ts`
 * already pulls React + design under a dynamic import — this file
 * piggybacks on those modules being available at call time, taking
 * them as constructor args rather than top-level imports.
 */

import type {
  CanvasLifecyclePayload,
  McpUiDisplayMode,
  SessionStackEntry,
} from '@ggui-ai/protocol';
import type { AnimatorEventStream } from './animator/animator-host.js';
import type { AnimatorEvent } from './animator/state-machine.js';
import { CanvasShell } from './canvas-shell.js';
import { NavStackModel } from './nav-stack.js';

/**
 * Multi-subscriber AnimatorEventStream backed by a Set of listeners.
 * Boot publishes via `publish(event)`; the shell's AnimatorHost
 * subscribes through the {@link AnimatorEventStream} interface.
 *
 * Kept small and inline because the only call site is `mountCanvas`
 * — extracting it to its own file would be ceremony.
 */
export class AnimatorEventBus implements AnimatorEventStream {
  private readonly listeners = new Set<(e: AnimatorEvent) => void>();
  subscribe = (listener: (event: AnimatorEvent) => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  publish(event: AnimatorEvent): void {
    for (const fn of this.listeners) fn(event);
  }
  /**
   * Translate a wire-shape {@link CanvasLifecyclePayload} from the
   * `_ggui:lifecycle` channel into the matching {@link AnimatorEvent}
   * variant and publish. The wire union is closed, so the switch is
   * exhaustive.
   */
  publishLifecycle(payload: CanvasLifecyclePayload): void {
    switch (payload.kind) {
      case 'handshake_started':
        this.publish({ kind: 'handshake_started', payload });
        return;
      case 'handshake_completed':
        this.publish({ kind: 'handshake_completed', payload });
        return;
      case 'push_started':
        this.publish({ kind: 'push_started', payload });
        return;
      case 'consume_polling':
        this.publish({ kind: 'consume_polling', payload });
        return;
    }
  }
}

/**
 * Minimal React/ReactDOM surface the mount needs. Constructor accepts
 * pre-imported modules so it doesn't duplicate the dynamic-import
 * graph runtime.ts already pays for. Type loose-typed because tests
 * may pass stubs; production wires the real `react` + `react-dom/client`.
 */
export interface CanvasMountReactDeps {
  readonly react: typeof import('react');
  readonly reactDomClient: typeof import('react-dom/client');
}

/**
 * Side-effecting callbacks the canvas shell threads up to the boot
 * layer. The boot layer owns the live-channel transport so it knows how
 * to emit envelopes; this module knows nothing about WS.
 */
export interface CanvasMountCallbacks {
  /**
   * Fire a `ui/request-display-mode` postMessage to the host. The
   * shell calls this when the display-mode policy says to escalate
   * (e.g. content state ⇒ fullscreen). Boot wires it to the existing
   * `requestDisplayModeInParent` helper.
   */
  readonly onRequestDisplayMode?: (mode: McpUiDisplayMode) => void;
  /**
   * Fire when the user back-navigates. Boot wires this to the
   * live-channel `canvas_navigated` envelope so the server can update
   * its `activeStackItemId` + abort in-flight cold-gen for the popped
   * item.
   */
  readonly onBackGesture?: (args: {
    readonly previousActiveItemId: string;
    readonly activeItemId: string | null;
  }) => void;
}

export interface CanvasMountHandle {
  /**
   * The NavStackModel the shell renders from. Boot syncs this with
   * the server's stack snapshot on every ack via `setStack()`.
   */
  readonly navStack: NavStackModel;
  /**
   * Bus for live-channel lifecycle envelopes. Boot calls
   * `events.publish(event)` when an `_ggui:lifecycle` envelope arrives
   * on the WS; AnimatorHost subscribes through the read-side
   * {@link AnimatorEventStream} interface.
   */
  readonly events: AnimatorEventBus;
  /**
   * Stable DOM element the stack renderer writes into. Mirrors the
   * shape of the legacy `refs.stack` element — bootSequence hands
   * this to `triadWiring.setup({ renderInto })` instead of the raw
   * `refs.stack`. The shell guarantees only the active stack item's
   * subtree lives here at any moment.
   */
  readonly contentEl: HTMLElement;
  /**
   * Replace the entire nav stack. Used on the first ack (seed from
   * snapshot) AND on every subsequent ack that delivers a fresh
   * stack array.
   */
  setStack(stack: readonly SessionStackEntry[]): void;
  /**
   * Push a single item — used by the live-channel `push` envelope path
   * where the server delivers one item at a time after the canvas is
   * up. Idempotent in-place replace on duplicate id (matches server
   * upsert semantics).
   */
  pushItem(item: SessionStackEntry): void;
  /**
   * Update the host's currently-reported display mode. Boot calls
   * this when the host's `host-context-changed` notification arrives,
   * so the policy reconciles against the latest mode.
   */
  setDisplayMode(mode: McpUiDisplayMode | undefined): void;
  /**
   * Update the host's declared `availableDisplayModes`. Same
   * provenance as `setDisplayMode` — comes from
   * `host-context-changed` payloads.
   */
  setAvailableDisplayModes(available: readonly McpUiDisplayMode[] | undefined): void;
  /**
   * Register a cleanup callback that fires when {@link dispose} runs.
   * Used by boot to attach external teardown (e.g., the
   * host-context-emitter local subscription's unsubscribe fn) to the
   * canvas lifecycle so a re-mount doesn't leak the prior callback.
   * Idempotent re-registration is fine; each fires exactly once on
   * the first dispose.
   */
  registerCleanup(fn: () => void): void;
  /**
   * React unmount + cleanup. Called by `triadWiring.teardown` on
   * boot-failure / explicit dispose paths. Also fires every
   * registered cleanup callback in registration order.
   */
  dispose(): void;
}

/**
 * Mount the canvas shell into `mountTarget`. The shell takes over
 * `mountTarget`'s child layout — boot SHOULD pass an empty container
 * (`refs.stack`), not the document root.
 */
export function mountCanvas(
  mountTarget: HTMLElement,
  deps: CanvasMountReactDeps,
  callbacks: CanvasMountCallbacks = {},
): CanvasMountHandle {
  const navStack = new NavStackModel();
  const events = new AnimatorEventBus();
  const cleanups: Array<() => void> = [];

  // The content element is stable across re-renders — we keep a
  // single div and let the existing stack renderer mutate it. The
  // shell receives `() => contentSlot` as `renderActiveItem`.
  const contentEl = mountTarget.ownerDocument.createElement('div');
  contentEl.setAttribute('data-ggui-canvas-content-slot', 'true');
  contentEl.style.width = '100%';
  contentEl.style.height = '100%';

  // Mutable display-mode state lives in closure refs. The Wrapper
  // captures a useState setter on first render; external setters
  // route through it to push updates into React. Single consumer so
  // a Set+broadcast pattern would be over-built — one nullable ref
  // matches the architecture exactly.
  let availableDisplayModes: readonly McpUiDisplayMode[] | undefined;
  let currentDisplayMode: McpUiDisplayMode | undefined;
  type WrapperState = {
    readonly available: readonly McpUiDisplayMode[] | undefined;
    readonly current: McpUiDisplayMode | undefined;
  };
  let setWrapperState: ((s: WrapperState) => void) | null = null;
  const bumpState = (): void => {
    setWrapperState?.({
      available: availableDisplayModes,
      current: currentDisplayMode,
    });
  };

  const { react, reactDomClient } = deps;
  const root = reactDomClient.createRoot(mountTarget);

  function Wrapper(): ReturnType<typeof react.createElement> {
    const [state, setState] = react.useState<WrapperState>({
      available: availableDisplayModes,
      current: currentDisplayMode,
    });
    react.useEffect(() => {
      setWrapperState = setState;
      return () => {
        if (setWrapperState === setState) setWrapperState = null;
      };
    }, []);
    const props: Parameters<typeof CanvasShell>[0] = {
      navStack,
      events,
      ...(state.available !== undefined
        ? { availableDisplayModes: state.available }
        : {}),
      ...(state.current !== undefined
        ? { currentDisplayMode: state.current }
        : {}),
      onRequestDisplayMode: (mode) => {
        callbacks.onRequestDisplayMode?.(mode);
      },
      onBackGesture: (args) => {
        callbacks.onBackGesture?.(args);
      },
      renderActiveItem: () => {
        // Render the content slot DIV via a portal-ish ref pattern —
        // we wrap it in a no-op React element that mounts the
        // existing DOM node. Avoids React owning the slot's children
        // (the stack renderer writes them imperatively).
        return react.createElement(SlotMount, { node: contentEl });
      },
    };
    return react.createElement(CanvasShell, props);
  }

  function SlotMount({ node }: { readonly node: HTMLElement }) {
    const hostRef = react.useRef<HTMLDivElement | null>(null);
    react.useEffect(() => {
      const host = hostRef.current;
      if (host === null) return undefined;
      host.appendChild(node);
      return () => {
        if (node.parentNode === host) host.removeChild(node);
      };
    }, [node]);
    return react.createElement('div', {
      ref: hostRef,
      style: { width: '100%', height: '100%' },
    });
  }

  // React 18+ createRoot.render. The `unstable_strictMode` etc. are
  // host-supplied; we don't opt into them here.
  root.render(react.createElement(Wrapper, null));

  return {
    navStack,
    events,
    contentEl,
    setStack(stack) {
      navStack.reset(stack);
    },
    pushItem(item) {
      navStack.push(item);
    },
    setDisplayMode(mode) {
      currentDisplayMode = mode;
      bumpState();
    },
    setAvailableDisplayModes(available) {
      availableDisplayModes = available;
      bumpState();
    },
    registerCleanup(fn) {
      cleanups.push(fn);
    },
    dispose() {
      // Run external cleanups first so subscribers that touch the
      // navStack / events bus get a chance to detach before React
      // tears down its tree underneath them.
      while (cleanups.length > 0) {
        const fn = cleanups.shift();
        try {
          fn?.();
        } catch {
          // Cleanup threw — keep going so one bad callback doesn't
          // strand the rest.
        }
      }
      try {
        root.unmount();
      } catch {
        // React already unmounted (e.g. host removed the iframe).
      }
    },
  };
}
