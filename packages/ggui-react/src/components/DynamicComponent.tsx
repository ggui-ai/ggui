/**
 * DynamicComponent — alias for ReactComponentRenderer.
 *
 * Preserves the DynamicComponent public API so existing consumers
 * (ChatShell, FullscreenShell, etc.) continue to work after the
 * Phase B render-identity collapse.
 *
 * Post-Phase-B: the old `StackItemRenderer` (which scoped a wire
 * provider per stack item via `LegacyScopableWireConfig.scope()`) is
 * retired. Renders mount one-at-a-time inside `<GguiRender>`; the
 * scoping factory it composed against is gone. The replacement
 * `<RenderRenderer>` is a leaf — it consumes the ambient wire context
 * established by `<GguiRender>` directly. The provisional path (empty
 * `componentCode`, A2UI preview channel) is preserved unchanged.
 */

import React, { type ReactNode } from 'react';
import type { CapabilityPermissions, ActionSpec } from '@ggui-ai/protocol';
import {
  GguiWireProvider,
  useWireContext,
  type WireConfig,
} from '@ggui-ai/wire';
import { ReactComponentRenderer } from './ReactComponentRenderer';
import type { ReactComponentRendererProps } from './ReactComponentRenderer';
import { ProvisionalRenderer } from './ProvisionalRenderer';

// ---------------------------------------------------------------------------
// DynamicComponent — alias for ReactComponentRenderer
// ---------------------------------------------------------------------------

/**
 * Props for DynamicComponent (alias for ReactComponentRendererProps)
 */
export type DynamicComponentProps = ReactComponentRendererProps;

/**
 * DynamicComponent — Renders a compiled ESM component directly in the
 * React tree.
 *
 * @example
 * ```tsx
 * <DynamicComponent code={render.componentCode} />
 * ```
 */
export const DynamicComponent = ReactComponentRenderer;

// ---------------------------------------------------------------------------
// RenderRenderer
// ---------------------------------------------------------------------------

/**
 * Render a single component-variant render.
 *
 * Loose input shape (id + componentCode + props + caps + actionSpec +
 * contractHash) because callers — preview routes, ad-hoc viewers, the
 * shells — historically passed a fragment of {@link ComponentRender}
 * rather than the full type. The shape is internally a superset of the
 * fields the renderer actually reads.
 *
 * @example
 * ```tsx
 * <RenderRenderer render={render} />
 * ```
 */
export interface RenderRendererProps {
  /** The render to display (component variant). */
  render: {
    id?: string;
    componentCode: string;
    prompt?: string;
    /** Props to pass to the component at render time */
    props?: Record<string, unknown>;
    /** Capability permissions granted to this component */
    capabilities?: CapabilityPermissions;
    /** Action contract — used by the wire layer to resolve action → MCP tool bindings */
    actionSpec?: ActionSpec;
    /** Contract hash — included in event context for traceability and cross-validation */
    contractHash?: string;
  };
  /** Fallback UI while loading */
  fallback?: ReactNode;
  /** Error handler */
  onError?: (error: Error) => void;
  /** Extra CSS injected into the component (e.g. dark-mode overrides) */
  cssOverrides?: string;
  /** Theme ID from the design system registry (e.g. 'ggui', 'premium-zen') */
  themeId?: string;
}

export function RenderRenderer({
  render,
  fallback,
  onError,
  cssOverrides,
  themeId,
}: RenderRendererProps): React.JSX.Element {
  const handleRepair = React.useCallback((error: Error) => {
    // Dispatch repair request — picked up by host shells which forward
    // it to the agent so it can re-generate with error context.
    if (typeof window !== 'undefined' && render.id) {
      window.dispatchEvent(new CustomEvent('ggui:request-repair', {
        detail: {
          renderId: render.id,
          prompt: render.prompt,
          error: error.message,
          componentCode: render.componentCode,
        },
      }));
    }
  }, [render.id, render.prompt, render.componentCode]);

  // Empty componentCode → the render is still being generated.
  // Route through `<ProvisionalRenderer>` so the reserved
  // `_ggui:preview` channel's A2UI envelopes (when the server preamble
  // emits them) paint the assembling surface in place of the raw
  // loading fallback. Without an active preamble, the renderer itself
  // falls back to the caller's `fallback` prop — so current consumers
  // keep today's "Spinner while empty" UX with no behavioural change.
  if (!render.componentCode || render.componentCode.length === 0) {
    return (
      <EnsureWireContext>
        <ProvisionalRenderer fallback={fallback} />
      </EnsureWireContext>
    );
  }

  return (
    <EnsureWireContext>
      <ReactComponentRenderer
        code={render.componentCode}
        props={render.props}
        cssOverrides={cssOverrides}
        themeId={themeId}
        onError={onError}
        onRequestRepair={handleRepair}
        fallback={fallback}
      />
    </EnsureWireContext>
  );
}

/**
 * Ensure a WireConfig is present in context.
 *
 * If a parent `<GguiRender>` already provided one (the production
 * path), pass through. Otherwise — preview / standalone mounts e.g.
 * BlueprintViewer at `/preview/<id>` — inject a no-op WireConfig so
 * generated components calling `useAction` / `useStream` don't throw.
 *
 * Standalone semantics: dispatch is a no-op, subscribe never fires.
 * Matches the documented "static preview renders without a live
 * channel" contract authored components depend on.
 *
 * Post-Phase-B: there is no per-render scoping factory. `<GguiRender>`
 * provides one WireConfig keyed by the single mounted renderId; this
 * leaf either consumes that or provides the standalone fallback.
 */
function EnsureWireContext({
  children,
}: {
  children: ReactNode;
}): React.JSX.Element {
  const parent = useWireContextOrNull();
  if (parent) {
    // Production path — ambient context is sufficient.
    return <>{children}</>;
  }
  return (
    <GguiWireProvider config={STANDALONE_WIRE_CONFIG}>{children}</GguiWireProvider>
  );
}

const STANDALONE_WIRE_CONFIG: WireConfig = {
  app: { appId: 'preview', appName: 'preview' },
  render: { renderId: 'preview', isConnected: false },
  auth: { isAuthenticated: false },
  dispatch: () => {
    /* no-op — preview mounts have no host to route actions to */
  },
  subscribe: () => () => {
    /* no-op — no live channel in standalone mode */
  },
};

/** Like useWireContext but returns null instead of throwing — for standalone renders. */
function useWireContextOrNull(): WireConfig | null {
  try {
    return useWireContext();
  } catch {
    return null;
  }
}

/**
 * Clear the module cache (no-op — kept for API compatibility)
 */
export function clearModuleCache(): void {
  // No-op: kept for API compatibility.
}
