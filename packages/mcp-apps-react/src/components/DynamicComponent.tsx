/**
 * DynamicComponent — alias for ReactComponentRenderer.
 *
 * Public mount surface for compiled component code outside the
 * `<GguiRender>` lifecycle — preview routes and ad-hoc blueprint
 * viewers pass `{ id, componentCode }`.
 *
 * Post-Phase-B: the old `StackItemRenderer` (which scoped a wire
 * provider per stack item via `LegacyScopableWireConfig.scope()`) is
 * retired. The replacement `<GguiSessionRenderer>` is a leaf — it
 * consumes the ambient wire context when a host provides one, or falls
 * back to a standalone no-op WireConfig. The provisional path (empty
 * `componentCode` → static placeholder) is preserved.
 */

import React, { type ReactNode } from 'react';
import {
  GguiWireProvider,
  useWireContext,
  type WireConfig,
} from '@ggui-ai/wire';
import { ReactComponentRenderer } from './ReactComponentRenderer';
import type { ReactComponentRendererProps } from './ReactComponentRenderer';
import { ProvisionalRenderer } from './ProvisionalRenderer';
import { UiFeedback, type UiFeedbackPayload } from './UiFeedback';

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
// GguiSessionRenderer
// ---------------------------------------------------------------------------

/**
 * Render a single component-variant render.
 *
 * Loose input shape (componentCode + props) because callers — preview
 * routes, ad-hoc viewers — pass a fragment of
 * {@link ComponentGguiSession} rather than the full type. These two
 * fields are exactly what the renderer reads.
 *
 * @example
 * ```tsx
 * <GguiSessionRenderer render={render} />
 * ```
 */
export interface GguiSessionRendererProps {
  /** The render to display (component variant). */
  render: {
    componentCode: string;
    /** Props to pass to the component at render time */
    props?: Record<string, unknown>;
  };
  /** Fallback UI while loading */
  fallback?: ReactNode;
  /** Error handler */
  onError?: (error: Error) => void;
  /** Extra CSS injected into the component (e.g. dark-mode overrides) */
  cssOverrides?: string;
  /** Theme ID from the design system registry (e.g. 'ggui', 'premium-zen') */
  themeId?: string;
  /**
   * End-user feedback sink (ggui#244). ABSENT = nothing renders — a host
   * that doesn't collect feedback never shows a dead affordance, and
   * this component gains no chrome. When present, the `<UiFeedback>`
   * affordance mounts BELOW the rendered component and every payload is
   * stamped with `sessionId` / `toolName` when those are supplied.
   *
   * Threaded here (2026-07-30) because renderer-only hosts — e.g. a
   * platform portal whose surface IS `<GguiSessionRenderer>` — own no
   * separate chrome layer to mount the standalone component into.
   * Feedback stays host-app chrome with ZERO wire surface: the agent
   * cannot observe it (Data vs Behavior), which is why it leaves
   * through this callback rather than a contract field.
   */
  onUiFeedback?: (feedback: UiFeedbackPayload) => void;
  /** GguiSession id stamped onto emitted feedback payloads. */
  feedbackSessionId?: string;
  /** Producing tool name stamped onto emitted feedback payloads. */
  feedbackToolName?: string;
}

export function GguiSessionRenderer({
  render,
  fallback,
  onError,
  cssOverrides,
  themeId,
  onUiFeedback,
  feedbackSessionId,
  feedbackToolName,
}: GguiSessionRendererProps): React.JSX.Element {
  // Empty componentCode → the render is still being generated.
  // Route through `<ProvisionalRenderer>`, which paints the caller's
  // `fallback` prop (or a centred Spinner) until the authoritative
  // component code lands.
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
        fallback={fallback}
      />
      {onUiFeedback ? (
        <UiFeedback
          onUiFeedback={onUiFeedback}
          {...(feedbackSessionId !== undefined
            ? { sessionId: feedbackSessionId }
            : {})}
          {...(feedbackToolName !== undefined
            ? { toolName: feedbackToolName }
            : {})}
        />
      ) : null}
    </EnsureWireContext>
  );
}

/**
 * Ensure a WireConfig is present in context.
 *
 * If a parent host already provided one, pass through. Otherwise —
 * preview / standalone mounts e.g. BlueprintViewer at `/preview/<id>`
 * — inject a no-op WireConfig so generated components calling
 * `useAction` / `useStream` don't throw.
 *
 * Standalone semantics: dispatch is a no-op, subscribe never fires.
 * Matches the documented "static preview renders without a live
 * channel" contract authored components depend on.
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
  render: { sessionId: 'preview', isConnected: false },
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
