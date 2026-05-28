/**
 * System-card registry.
 *
 * Central mapping from `SystemRender.kind` (a stable wire string)
 * to a real React component bundled inside the iframe-runtime. The
 * runtime's self-contained boot path looks up the kind here when it
 * sees a render with `type: 'system'`. Unknown kinds fall through
 * to {@link UnknownSystemCard} so an old runtime + new server still
 * surfaces something visible (vs. a blank iframe).
 *
 * Adding a new system card:
 *
 *   1. Author `MyNewCard.tsx` in this directory.
 *   2. Add an entry to {@link SYSTEM_CARD_REGISTRY} below.
 *   3. (Optional) Add the new kind string to
 *      `SystemRenderKind` in `@ggui-ai/protocol` for IDE autocomplete.
 */
import * as React from 'react';
import { ThemeProvider, lightTheme, darkTheme } from '@ggui-ai/design/themes';
import {
  NoCredentialsCard,
  type NoCredentialsCardProps,
} from './NoCredentialsCard.js';
import {
  ProtocolProbeCard,
  type ProtocolProbeCardProps,
} from './ProtocolProbeCard.js';
import { isInsideClaude, useColorScheme } from './host-detect.js';

/**
 * Generic typed-component shape for the registry. Each entry takes a
 * loosely-typed `Record<string, unknown>` (the wire `props`) and is
 * responsible for narrowing its own props internally — the runtime
 * does NOT validate against the JSX prop shape because the wire is
 * versioned independently of the bundle.
 */
export type SystemCardComponent = React.ComponentType<Record<string, unknown>>;

/**
 * Wrap a strongly-typed card component in a loosely-typed entry the
 * registry can store uniformly. Each card narrows its own props out of
 * the bag — runtime cost is negligible (a property read + typeof
 * checks).
 */
function entry<P>(
  Component: React.ComponentType<P>,
  narrow: (raw: Record<string, unknown>) => P,
): SystemCardComponent {
  return function SystemCardEntry(props) {
    // The narrowed shape is the component's actual prop type — cast
    // through `unknown` because React's typed `createElement` overloads
    // can't see through the registry's loose `Record<string, unknown>`
    // surface.
    const Comp = Component as React.ComponentType<unknown>;
    const narrowed = narrow(props) as unknown as React.Attributes;
    return React.createElement(Comp, narrowed);
  };
}

/**
 * Fallback card rendered when the runtime sees a `kind` it doesn't
 * have a registered component for — typically because the server is
 * running a newer protocol version. Surfaces the kind + raw props so
 * the user can at least file a useful bug report.
 */
function UnknownSystemCard({
  kind,
  props,
}: {
  kind: string;
  props: Record<string, unknown>;
}): React.JSX.Element {
  return React.createElement(
    'div',
    {
      style: {
        padding: '16px',
        border: '1px solid var(--ggui-color-outlineVariant, #e4e4e7)',
        borderRadius: 'var(--ggui-shape-radius-md, 10px)',
        fontFamily:
          'var(--ggui-font-family-sans, -apple-system, BlinkMacSystemFont, sans-serif)',
        background: 'var(--ggui-color-surfaceVariant, #f4f4f5)',
        color: 'var(--ggui-color-onSurfaceVariant, #52525b)',
      },
    },
    React.createElement(
      'div',
      { style: { fontWeight: 600, marginBottom: 8 } },
      `Unknown system card: ${kind}`,
    ),
    React.createElement(
      'div',
      {
        style: {
          fontSize: 12,
          fontFamily:
            'var(--ggui-font-family-mono, ui-monospace, SFMono-Regular, monospace)',
          opacity: 0.7,
          wordBreak: 'break-all',
        },
      },
      JSON.stringify(props),
    ),
  );
}

/**
 * Registered system-card kinds. Keep keys aligned with
 * `SystemRenderKind` in `@ggui-ai/protocol` so wire + bundle stay
 * in sync. New kinds added without a registry entry render as
 * {@link UnknownSystemCard}.
 */
export const SYSTEM_CARD_REGISTRY: Record<string, SystemCardComponent> = {
  'no-credentials': entry<NoCredentialsCardProps>(NoCredentialsCard, (raw) => {
    const settingsUrl =
      typeof raw['settingsUrl'] === 'string' ? raw['settingsUrl'] : '';
    const intent = typeof raw['intent'] === 'string' ? raw['intent'] : undefined;
    return {
      settingsUrl,
      ...(intent !== undefined ? { intent } : {}),
    };
  }),
  'mcp-apps-probe': entry<ProtocolProbeCardProps>(ProtocolProbeCard, (raw) => {
    const intent = typeof raw['intent'] === 'string' ? raw['intent'] : undefined;
    return {
      ...(intent !== undefined ? { intent } : {}),
    };
  }),
};

/**
 * Resolve a registered component by kind, or the fallback when the
 * kind is unknown. Always returns a renderable React element.
 */
export function renderSystemCard(
  kind: string,
  props: Record<string, unknown>,
): React.ReactElement {
  const Comp = SYSTEM_CARD_REGISTRY[kind];
  if (Comp) {
    return React.createElement(Comp, props);
  }
  return React.createElement(UnknownSystemCard, { kind, props });
}

/**
 * Top-level mount component the runtime renders for system stack
 * items. Wraps the resolved card in a {@link ThemeProvider} so design
 * tokens (`var(--ggui-*)`) resolve at `:root` even though the host's
 * shell HTML doesn't pre-stamp them. Idempotent across remounts —
 * shares the `ggui-theme-vars` style id with the rest of the design
 * system, last writer wins.
 *
 * Adapts to the embedding host:
 *
 *   - **Inside Claude** (claude.ai web's `claudemcpcontent.com` or
 *     Claude Desktop): drops the body background to `transparent` so
 *     the chat-bubble surface shows through, and follows the user's
 *     OS-level `prefers-color-scheme`. The card's own surfaces stay
 *     opaque so the content remains readable on either bubble color.
 *   - **Anywhere else**: lightTheme + opaque white background — the
 *     historical default, suitable for stand-alone preview iframes
 *     and console inspectors.
 *
 * Theme choice re-runs live: if the user toggles dark mode in their
 * OS while the card is mounted, `useColorScheme` updates and we
 * re-emit the matching theme's CSS variables.
 */
export function SystemCardHost({
  kind,
  props,
  themeId: _themeId,
}: {
  kind: string;
  props: Record<string, unknown>;
  themeId?: string | undefined;
}): React.ReactElement {
  // `themeId` reserved for future per-card theme override. Today the
  // host environment + system color scheme drive the choice.
  const inClaude = isInsideClaude();
  const scheme = useColorScheme();
  const theme = scheme === 'dark' ? darkTheme : lightTheme;
  return React.createElement(ThemeProvider, {
    theme,
    mode: scheme,
    transparent: inClaude,
    children: renderSystemCard(kind, props),
  });
}

export { NoCredentialsCard, ProtocolProbeCard };
export type { NoCredentialsCardProps, ProtocolProbeCardProps };
