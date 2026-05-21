/**
 * DynamicComponent - Alias for ReactComponentRenderer.
 *
 * Preserves the DynamicComponent and StackItemRenderer public API so
 * existing consumers (ChatShell, FullscreenShell, GguiNavigator, etc.)
 * continue to work without changes.
 */

import React, { type ReactNode } from 'react';
import type { CapabilityPermissions, ActionSpec } from '@ggui-ai/protocol';
import {
  GguiWireProvider,
  useWireContext,
  type LegacyScopableWireConfig,
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
 * DynamicComponent - Renders a compiled ESM component directly in the React tree.
 *
 * @example
 * ```tsx
 * <DynamicComponent code={stackItem.componentCode} />
 * ```
 */
export const DynamicComponent = ReactComponentRenderer;

// ---------------------------------------------------------------------------
// StackItemRenderer
// ---------------------------------------------------------------------------

/**
 * Render a stack item with optional controller wrapping
 *
 * @example
 * ```tsx
 * <StackItemRenderer stackItem={item} />
 * ```
 */
export interface StackItemRendererProps {
  /** The stack item to render */
  stackItem: {
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

export function StackItemRenderer({
  stackItem,
  fallback,
  onError,
  cssOverrides,
  themeId,
}: StackItemRendererProps): React.JSX.Element {
  const handleRepair = React.useCallback((error: Error) => {
    // Dispatch repair request — BaseShell picks this up and sends a
    // WebSocket 'generate' message to re-generate with error context.
    if (typeof window !== 'undefined' && stackItem.id) {
      window.dispatchEvent(new CustomEvent('ggui:request-repair', {
        detail: {
          stackItemId: stackItem.id,
          prompt: stackItem.prompt,
          error: error.message,
          componentCode: stackItem.componentCode,
        },
      }));
    }
  }, [stackItem.id, stackItem.prompt, stackItem.componentCode]);

  // Empty componentCode → the stack item is still being generated.
  // Route through `<ProvisionalRenderer>` so the reserved
  // `_ggui:preview` channel's A2UI envelopes (when the server preamble
  // emits them) paint the assembling surface in place of the raw
  // loading fallback. Without an active preamble, the renderer itself
  // falls back to the caller's `fallback` prop — so current consumers
  // keep today's "Spinner while empty" UX with no behavioural change.
  if (!stackItem.componentCode || stackItem.componentCode.length === 0) {
    return (
      <ScopedWireProvider stackItem={stackItem}>
        <ProvisionalRenderer fallback={fallback} />
      </ScopedWireProvider>
    );
  }

  return (
    <ScopedWireProvider stackItem={stackItem}>
      <ReactComponentRenderer
        code={stackItem.componentCode}
        props={stackItem.props}
        cssOverrides={cssOverrides}
        themeId={themeId}
        onError={onError}
        onRequestRepair={handleRepair}
        fallback={fallback}
      />
    </ScopedWireProvider>
  );
}

/**
 * Wire scope for a single stack item.
 *
 * If the parent WireConfig provides a `scope(stackItem)` factory (GguiSession does),
 * we build a per-item WireConfig whose dispatch is bound to THIS stack item's
 * stackItemId, contractHash, and actionSpec. Otherwise we render through the parent as-is.
 *
 * Without this scoping, an action emitted by an older card in a chat stack would be
 * cross-validated against the top item's contract — wrong tool, wrong page.
 */
function ScopedWireProvider({
  stackItem,
  children,
}: {
  stackItem: StackItemRendererProps['stackItem'];
  children: ReactNode;
}): React.JSX.Element {
  const parent = useWireContextOrNull();

  const scopedConfig = React.useMemo<WireConfig | null>(() => {
    // The `scope()` factory lives on `LegacyScopableWireConfig` (a
    // legacy intersection type), NOT on the base `WireConfig`
    // interface. `<GguiSession>` / `<BaseShell>` still build legacy
    // configs during the migration overlap; this narrows via a
    // presence-check rather than `instanceof`. In the renderer-iframe
    // model (`<McpAppIframe>` + `@ggui-ai/iframe-runtime`), scoping
    // happens in the renderer's standalone `scopeWireConfig` function
    // before `<GguiWireProvider>` mounts — nothing reaches this path.
    const legacy = parent as LegacyScopableWireConfig | null;
    if (!legacy || typeof legacy.scope !== 'function') return null;
    return legacy.scope({
      stackItemId: stackItem.id,
      contractHash: stackItem.contractHash,
      actionSpec: stackItem.actionSpec,
    });
  }, [parent, stackItem.id, stackItem.contractHash, stackItem.actionSpec]);

  if (scopedConfig) {
    return <GguiWireProvider config={scopedConfig}>{children}</GguiWireProvider>;
  }
  // No parent context (preview / standalone mount — e.g.
  // BlueprintViewer at `/preview/<id>`). Provide a no-op WireConfig so
  // generated components calling `useAction` / `useStream` don't
  // throw `useWireContext must be used within a WireProvider`.
  // Standalone semantics: dispatch is a no-op, subscribe never fires.
  // This matches the documented "static preview renders without a
  // session" contract that authored components depend on.
  return (
    <GguiWireProvider config={STANDALONE_WIRE_CONFIG}>{children}</GguiWireProvider>
  );
}

const STANDALONE_WIRE_CONFIG: WireConfig = {
  app: { appId: 'preview', appName: 'preview' },
  session: { sessionId: 'preview', isConnected: false },
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
