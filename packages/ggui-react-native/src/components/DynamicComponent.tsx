/**
 * DynamicComponent for React Native
 *
 * Two rendering strategies:
 * 1. **Descriptor-based** (preferred when available) — Server sends a JSON descriptor
 *    tree that maps to registered React Native components via NativeRegistry.
 * 2. **WebView-based** (fallback) — Compiled JS code is rendered in a WebView
 *    with event bridging back to React Native.
 *
 * The server currently sends `componentCode` (compiled JS). The descriptor
 * path is ready for when the server adds RN descriptor output.
 */

import React, {
  useState,
  useEffect,
  type ReactNode,
  type ComponentType,
} from 'react';
import { View, Text, ActivityIndicator, StyleSheet } from 'react-native';
import type { GguiSession } from '@ggui-ai/protocol';
import { isMcpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import { WebViewRenderer, type BridgeEvent } from './WebViewRenderer';
import { ProvisionalRenderer } from './ProvisionalRenderer';

/**
 * Component descriptor from the server — a serializable tree
 */
export interface ComponentDescriptor {
  type: string;
  props?: Record<string, unknown>;
  children?: (ComponentDescriptor | string)[];
}

/**
 * Registry of React Native components available for dynamic rendering
 */
const componentRegistry = new Map<string, ComponentType<Record<string, unknown>>>();

/**
 * Register a React Native component for use in dynamic rendering
 */
export function registerComponent(name: string, component: ComponentType<Record<string, unknown>>): void {
  componentRegistry.set(name, component);
}

/**
 * Get a registered component by name
 */
export function getComponent(name: string): ComponentType<Record<string, unknown>> | undefined {
  return componentRegistry.get(name);
}

/**
 * Clear the component registry (useful for testing)
 */
export function clearRegistry(): void {
  componentRegistry.clear();
}

/**
 * Props for DynamicComponent
 */
export interface DynamicComponentProps {
  /** Component descriptor tree (JSON from server) */
  descriptor?: ComponentDescriptor;
  /** Raw compiled code (rendered via WebView) */
  code?: string;
  /** Props to pass to the root component */
  props?: Record<string, unknown>;
  /** Children to pass to the component */
  children?: ReactNode;
  /** Fallback UI while loading */
  fallback?: ReactNode;
  /** Error handler */
  onError?: (error: Error) => void;
  /** Event handler for WebView bridge events */
  onEvent?: (event: BridgeEvent) => void;
}

/**
 * Recursively render a component descriptor tree
 */
function renderDescriptor(descriptor: ComponentDescriptor | string): ReactNode {
  if (typeof descriptor === 'string') {
    return <Text>{descriptor}</Text>;
  }

  const Component = componentRegistry.get(descriptor.type);
  if (!Component) {
    return (
      <View style={styles.unknownComponent}>
        <Text style={styles.unknownText}>Unknown: {descriptor.type}</Text>
      </View>
    );
  }

  const children = descriptor.children?.map((child, index) => (
    <React.Fragment key={index}>
      {renderDescriptor(child)}
    </React.Fragment>
  ));

  return <Component {...(descriptor.props || {})}>{children}</Component>;
}

/**
 * DynamicComponent for React Native
 *
 * Renders a component via descriptor tree (native) or WebView (compiled code).
 */
export function DynamicComponent({
  descriptor,
  code,
  props = {},
  children,
  fallback,
  onError,
  onEvent,
}: DynamicComponentProps): React.JSX.Element {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    try {
      if (!descriptor && !code) {
        throw new Error('DynamicComponent requires either descriptor or code prop');
      }
      setLoading(false);
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setLoading(false);
      onError?.(e);
    }
  }, [descriptor, code, onError]);

  if (loading) {
    return (
      <>
        {fallback || (
          <View style={styles.loading}>
            <ActivityIndicator size="small" color="#3b82f6" />
            <Text style={styles.loadingText}>Loading component...</Text>
          </View>
        )}
      </>
    );
  }

  if (error) {
    return (
      <View style={styles.error}>
        <Text style={styles.errorTitle}>Component Error</Text>
        <Text style={styles.errorMessage}>{error.message}</Text>
      </View>
    );
  }

  // Strategy 1: Render from descriptor tree (native components)
  if (descriptor) {
    try {
      const mergedDescriptor: ComponentDescriptor = {
        ...descriptor,
        props: { ...descriptor.props, ...props },
      };
      return (
        <View style={styles.container}>
          {renderDescriptor(mergedDescriptor)}
          {children}
        </View>
      );
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      onError?.(e);
      return (
        <View style={styles.error}>
          <Text style={styles.errorTitle}>Render Error</Text>
          <Text style={styles.errorMessage}>{e.message}</Text>
        </View>
      );
    }
  }

  // Strategy 2: Render compiled code via WebView
  if (code) {
    return (
      <View style={styles.container}>
        <WebViewRenderer
          code={code}
          props={props}
          onEvent={onEvent}
          onError={onError}
        />
        {children}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <Text style={styles.loadingText}>No component to render</Text>
    </View>
  );
}

/**
 * Render a {@link GguiSession} entry. Post-Phase-B every render arrives as a
 * top-level GguiSession rather than as a stacked session entry. This
 * component handles the `ComponentGguiSession` variant only — descriptor
 * tree on native, WebView for compiled code.
 *
 * The `McpAppsGguiSession` variant is the responsibility of `<McpAppIframe>`
 * (exported from the root barrel); routing it through this component
 * is a programming error and surfaces as `onError`.
 *
 * The component-variant shape additionally accepts an ad-hoc
 * `descriptor` field, preserved for the existing RN-only descriptor
 * rendering path until the descriptor tree moves into the protocol.
 */
export interface GguiSessionRendererProps {
  render:
    | GguiSession
    | {
        componentCode: string;
        props?: Record<string, unknown>;
        descriptor?: ComponentDescriptor;
      };
  fallback?: ReactNode;
  onError?: (error: Error) => void;
  onEvent?: (event: BridgeEvent) => void;
}

export function GguiSessionRenderer({
  render,
  fallback,
  onError,
  onEvent,
}: GguiSessionRendererProps): React.JSX.Element {
  // MCP Apps variant belongs to <McpAppIframe>, not this component.
  if (isMcpAppsGguiSession(render as unknown)) {
    const err = new Error(
      'GguiSessionRenderer received an McpAppsGguiSession; route mcpApps renders ' +
        'through <McpAppIframe> instead.',
    );
    onError?.(err);
    return (
      <View style={styles.error}>
        <Text style={styles.errorTitle}>Routing error</Text>
        <Text style={styles.errorMessage}>{err.message}</Text>
      </View>
    );
  }

  // Component variant — treat as the loose local shape.
  const componentItem = render as {
    componentCode?: string;
    props?: Record<string, unknown>;
    descriptor?: ComponentDescriptor;
  };

  // Prefer descriptor-based rendering (native)
  if (componentItem.descriptor) {
    return (
      <DynamicComponent
        descriptor={componentItem.descriptor}
        fallback={fallback}
        onError={onError}
        onEvent={onEvent}
      />
    );
  }

  // Neither descriptor nor compiled code has arrived yet — the render
  // is mid-generation. Route through the `ProvisionalRenderer`
  // so `_ggui:preview` envelopes (when emitted by the server preamble)
  // paint the assembling A2UI surface in place of the raw
  // "no component to render" state. When the preamble isn't live,
  // the renderer gracefully falls back to the caller's `fallback`
  // so existing consumers see unchanged behaviour.
  if (!componentItem.componentCode || componentItem.componentCode.length === 0) {
    return <ProvisionalRenderer fallback={fallback} />;
  }

  // Fall back to WebView-based rendering (compiled code)
  return (
    <DynamicComponent
      code={componentItem.componentCode}
      props={componentItem.props}
      fallback={fallback}
      onError={onError}
      onEvent={onEvent}
    />
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loading: {
    padding: 16,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
  },
  loadingText: {
    fontSize: 14,
    color: '#6b7280',
  },
  error: {
    padding: 16,
    backgroundColor: '#fee2e2',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 8,
  },
  errorTitle: {
    fontWeight: '700',
    color: '#991b1b',
    marginBottom: 4,
  },
  errorMessage: {
    fontSize: 14,
    color: '#991b1b',
  },
  unknownComponent: {
    padding: 8,
    backgroundColor: '#fef3c7',
    borderRadius: 4,
  },
  unknownText: {
    fontSize: 12,
    color: '#92400e',
  },
});
