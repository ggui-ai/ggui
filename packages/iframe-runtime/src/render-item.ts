/**
 * GguiSession dispatcher — routes a single {@link GguiSession} to the
 * appropriate renderer based on its discriminator.
 *
 * Post-render-identity-collapse (2026-05-27): the iframe-runtime mounts
 * EXACTLY ONE render per iframe, in a single container. This module
 * exposes one entry point — {@link mountRender} — that returns a
 * {@link RenderItemHandle} the runtime uses to apply subsequent
 * patches (props_update) or unmount on teardown. The earlier
 * `StackRenderer` / `StackRenderContext` orchestrator (a stack-of-N
 * map keyed by item id) was retired along with `StackModel`.
 *
 * The dispatch tree mirrors `@ggui-ai/react::DynamicComponent` +
 * `GguiRender`'s MCP-Apps branch:
 *
 *   - `type === 'mcpApps'` → `mountMcpAppIframe` (vanilla iframe
 *     host; the recursive foreign-MCP-App path).
 *   - `componentCode` empty OR absent → `mountProvisional` (A2UI
 *     preview fed by the `_ggui:preview` reserved channel).
 *   - otherwise → `mountReactRoot` with a per-render `WireConfig`
 *     built by the caller. The mounted component is wrapped in
 *     `<GguiWireProvider config={scopedConfig}>` through the
 *     `renderWrapper` seam.
 *
 * Per-render lifecycle:
 *
 *   The handle's `update()` either transitions in-place (props-only,
 *   same kind) or tears down + remounts (kind changed — provisional
 *   → react when componentCode lands).
 *
 * StreamBus integration:
 *
 *   The dispatcher subscribes the mounted provisional renderer to
 *   `_ggui:preview` envelopes via the caller-provided StreamBus. On
 *   ReactComponentRenderer mount (componentCode lands), the
 *   provisional surface is `suspend()`-ed so the authoritative render
 *   takes over — matches DynamicComponent's componentCode-present
 *   gate.
 */
import { createElement } from 'react';
import type { ReactNode } from 'react';
import type { GguiSession } from '@ggui-ai/protocol';
import type { McpAppsGguiSession } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { GguiSessionSeedInput } from './types.js';
import { GguiWireProvider, type WireConfig } from '@ggui-ai/wire';
import { mountReactRoot, type ReactRootMount } from './react-renderer.js';
import {
  mountProvisional,
  type ProvisionalMount,
} from './provisional-renderer.js';
import {
  mountMcpAppIframe,
  type McpAppIframeMount,
} from './mcp-app-iframe-host.js';
import type { StreamBus } from './wire-config.js';

// =============================================================================
// Types
// =============================================================================

export interface RenderItemOptions {
  /** The render to mount. */
  readonly render: GguiSession | GguiSessionSeedInput;
  /** Wire config for this render — caller builds it via the runtime's
   *  `buildRootWireConfig(...)` (see `wire-config.ts`). `null` ⇒ the
   *  component mounts without a wire provider (standalone — matches
   *  today's DynamicComponent fallback when no GguiRender parent is
   *  present). */
  readonly scopedWireConfig: WireConfig | null;
  /** Shared stream bus — provisional renderer subscribes to
   *  `_ggui:preview` for this render. */
  readonly streamBus: StreamBus;
  /** GguiSession id — used by the mcp-apps iframe host for proxy URLs. */
  readonly sessionId: string;
  /**
   * 3rd-party gadget package names whose direct imports the rewriter
   * must resolve to per-package shims. FALLBACK source used only when
   * the render carries no `gadgetDescriptors` sidecar — i.e. the static
   * seed mount ({@link GguiSessionSeedInput}, which has no descriptors). The
   * caller threads the bootstrap's `meta.gadgets` package names here so a
   * generated component importing a non-STDLIB gadget on a no-WS host
   * (claude.ai / ChatGPT) still resolves its shim on first paint. A
   * WS-delivered full `GguiSession` carries `gadgetDescriptors` and ignores
   * this. STDLIB `@ggui-ai/gadgets` is always rewritten regardless.
   */
  readonly gadgetPackages?: readonly string[];
  /** Theme id passed to ReactComponentRenderer for scoped CSS. */
  readonly themeId?: string;
  /**
   * Theme color mode. Resolves the dark variant of `themeId` when set
   * to `'dark'`. Falls through to `'light'` if absent — matches the
   * design registry's `getTheme(id, mode?)` default.
   */
  readonly themeMode?: 'light' | 'dark';
  /**
   * Per-app theme overlay forwarded to {@link ReactRootMountOptions.appTheme}
   * so the renderer injects the `--ggui-*` overrides + `color-scheme` at
   * `:root`. Sourced from the bootstrap's `_meta["ai.ggui/render"].theme`.
   * A structural subset of protocol's `AppTheme` (`name` is display-only).
   */
  readonly appTheme?: {
    readonly mode: 'light' | 'dark';
    readonly cssVariables: Record<string, string>;
  };
  readonly cssOverrides?: string;
  readonly onError?: (err: Error) => void;
  /**
   * Optional outer wrapper applied AROUND the GguiWireProvider — used
   * by `bootProduction` to install the `<ContextStateHost>` provider
   * tree. Composition order:
   *
   *     wrapOuter(<GguiWireProvider><userComponent/></GguiWireProvider>)
   *
   * `wrapOuter` returns the wrapped node; passing `undefined` is
   * equivalent to the identity function (no extra wrapping). The
   * self-contained boot path inlines its own ContextStateHost via the
   * top-level `renderWrapper`; this seam exists for the WS-driven
   * renderer path where the per-render React mount is the only mount
   * surface.
   */
  readonly wrapOuter?: (mountedTree: ReactNode) => ReactNode;
}

/**
 * Discriminator for WHICH renderer is currently mounted under this
 * render handle. Transitions: 'provisional' → 'react' when
 * componentCode lands; 'react' → 'react' on code/prop updates;
 * 'mcpApps' is terminal for its lifetime (mcp-apps renders never
 * become components + vice versa).
 */
type MountedKind = 'provisional' | 'react' | 'mcpApps' | 'system' | 'none';

export interface RenderItemHandle {
  /**
   * Apply an update to the render handle. Kind changes (e.g.
   * provisional → react when componentCode lands) tear down the old
   * mount and stand up the replacement; same-kind updates route to
   * the inner renderer's `update()`.
   */
  update(next: RenderItemOptions): Promise<void>;
  /** Tear down the active mount + unsubscribe from the StreamBus. */
  unmount(): void;
  /** Current render kind. Test-only — not load-bearing. */
  readonly kind: MountedKind;
}

// =============================================================================
// Kind detection
// =============================================================================

function detectKind(render: GguiSession | GguiSessionSeedInput): 'mcpApps' | 'react' | 'provisional' | 'system' {
  if (render.type === 'mcpApps') return 'mcpApps';
  // System renders mount via the built-in `SystemCardHost` registry
  // (the `'system'` branch in `mountByKind`). This is the single mount
  // surface for server-emitted `kind` cards post boot-consolidation —
  // the old self-contained path that hand-rolled `SystemCardHost` is
  // gone, so this MUST route to `'system'`, not the A2UI placeholder.
  if (render.type === 'system') return 'system';
  const code = render.componentCode;
  if (typeof code === 'string' && code.trim().length > 0) return 'react';
  return 'provisional';
}

// =============================================================================
// Mount
// =============================================================================

export async function mountRender(
  container: HTMLElement,
  opts: RenderItemOptions,
): Promise<RenderItemHandle> {
  let currentOpts = opts;
  let currentKind: MountedKind = 'none';
  let reactMount: ReactRootMount | null = null;
  let provisionalMount: ProvisionalMount | null = null;
  let mcpMount: McpAppIframeMount | null = null;
  let previewUnsubscribe: (() => void) | null = null;
  // System-card mount (type:'system'). The render-only `SystemCardHost`
  // tree has no wire/context wrap; we hold the react-dom Root for
  // teardown + a re-render closure for same-kind prop updates.
  let systemRoot: { render: (node: ReactNode) => void; unmount: () => void } | null = null;
  let systemRerender: ((render: GguiSession | GguiSessionSeedInput) => void) | null = null;

  function teardown(): void {
    if (reactMount !== null) {
      reactMount.unmount();
      reactMount = null;
    }
    if (provisionalMount !== null) {
      provisionalMount.unmount();
      provisionalMount = null;
    }
    if (mcpMount !== null) {
      mcpMount.unmount();
      mcpMount = null;
    }
    if (systemRoot !== null) {
      systemRoot.unmount();
      systemRoot = null;
      systemRerender = null;
    }
    if (previewUnsubscribe !== null) {
      previewUnsubscribe();
      previewUnsubscribe = null;
    }
    currentKind = 'none';
  }

  async function mountByKind(kind: 'mcpApps' | 'react' | 'provisional' | 'system'): Promise<void> {
    if (kind === 'mcpApps') {
      // GguiSession narrows to McpAppsGguiSession when type='mcpApps'.
      const render = currentOpts.render as McpAppsGguiSession;
      mcpMount = mountMcpAppIframe(container, {
        render,
        sessionId: currentOpts.sessionId,
      });
      currentKind = 'mcpApps';
      return;
    }

    if (kind === 'system') {
      // System card — server-emitted `kind` mapped to a built-in
      // `.tsx` via `SystemCardHost`. GguiSession-only: no `__ggui__` shim,
      // no GguiWireProvider, no contextSpec wrap (system cards don't
      // dispatch wire actions or read contexts). The registry handles
      // unknown kinds via a typed fallback. Dynamic-import keeps the
      // system-cards module out of the base graph (boot.test.ts +
      // non-system mounts never pull it).
      const render = currentOpts.render;
      if (render.type !== 'system') return;
      const [reactDomClient, systemCardsMod] = await Promise.all([
        import('react-dom/client'),
        import('./system-cards/index.js'),
      ]);
      const root = reactDomClient.createRoot(container);
      const renderCard = (r: GguiSession | GguiSessionSeedInput): void => {
        if (r.type !== 'system') return;
        root.render(
          createElement(systemCardsMod.SystemCardHost, {
            kind: r.kind,
            props: r.props ?? {},
            ...(currentOpts.themeId !== undefined
              ? { themeId: currentOpts.themeId }
              : {}),
          }),
        );
      };
      renderCard(render);
      systemRoot = root;
      systemRerender = renderCard;
      currentKind = 'system';
      return;
    }

    if (kind === 'provisional') {
      provisionalMount = mountProvisional(container);
      previewUnsubscribe = currentOpts.streamBus.subscribe('_ggui:preview', (env) => {
        provisionalMount?.pushEnvelope(env);
      });
      currentKind = 'provisional';
      return;
    }

    // kind === 'react' — detectKind guarantees a generated component
    // variant (no mcpApps, no system) by this point.
    const render = currentOpts.render;
    if (render.type === 'mcpApps' || render.type === 'system') return;
    // GG.8.2 — gadget package names from the render's descriptor sidecar
    // so the rewriter resolves each direct gadget import to its
    // per-package shim. STDLIB `@ggui-ai/gadgets` is always rewritten.
    const gadgetPackages =
      'gadgetDescriptors' in render && render.gadgetDescriptors !== undefined
        ? render.gadgetDescriptors.map((d) => d.package)
        : currentOpts.gadgetPackages;
    reactMount = await mountReactRoot(container, {
      render: {
        ...(render.id !== undefined ? { id: render.id } : {}),
        componentCode: render.componentCode ?? '',
        ...(render.props !== undefined
          ? { props: render.props }
          : {}),
      },
      ...(gadgetPackages !== undefined ? { gadgetPackages } : {}),
      ...(currentOpts.themeId !== undefined ? { themeId: currentOpts.themeId } : {}),
      ...(currentOpts.themeMode !== undefined ? { themeMode: currentOpts.themeMode } : {}),
      ...(currentOpts.appTheme !== undefined ? { appTheme: currentOpts.appTheme } : {}),
      ...(currentOpts.cssOverrides !== undefined
        ? { cssOverrides: currentOpts.cssOverrides }
        : {}),
      ...(currentOpts.onError !== undefined ? { onError: currentOpts.onError } : {}),
      renderWrapper: wrapInScopedProvider,
    });
    currentKind = 'react';
  }

  /**
   * Wrap the mounted component in `<GguiWireProvider
   * config={scopedConfig}>` when the caller supplied one. Without a
   * scoped config, the component renders standalone — matches
   * today's DynamicComponent fallback when no GguiRender parent is
   * present.
   *
   * Composition order (outer → inner):
   *
   *     wrapOuter(<GguiWireProvider><userComponent/></GguiWireProvider>)
   *
   * `wrapOuter` is supplied by `bootProduction` to install the
   * `<ContextStateHost>` provider tree around the per-render React
   * mount. When absent, the wire provider is the only wrapper.
   */
  function wrapInScopedProvider(mountedComponent: ReactNode): ReactNode {
    const wireWrapped =
      currentOpts.scopedWireConfig === null
        ? mountedComponent
        : createElement(
            GguiWireProvider,
            { config: currentOpts.scopedWireConfig, children: mountedComponent },
          );
    return currentOpts.wrapOuter !== undefined
      ? currentOpts.wrapOuter(wireWrapped)
      : wireWrapped;
  }

  // Initial mount.
  const initialKind = detectKind(opts.render);
  await mountByKind(initialKind);

  return {
    get kind() {
      return currentKind;
    },
    async update(next) {
      const prevKind = currentKind;
      currentOpts = next;
      const nextKind = detectKind(next.render);

      if (nextKind !== prevKind) {
        // Kind changed — tear down old + mount new.
        teardown();
        await mountByKind(nextKind);
        return;
      }

      // Same-kind update — route to the inner renderer's update.
      if (nextKind === 'react' && reactMount !== null) {
        const render = next.render;
        if (render.type === 'mcpApps' || render.type === 'system') return;
        await reactMount.update({
          render: {
            ...(render.id !== undefined ? { id: render.id } : {}),
            componentCode: render.componentCode ?? '',
            ...(render.props !== undefined
              ? { props: render.props }
              : {}),
          },
          ...(next.themeId !== undefined ? { themeId: next.themeId } : {}),
          ...(next.themeMode !== undefined ? { themeMode: next.themeMode } : {}),
          ...(next.appTheme !== undefined ? { appTheme: next.appTheme } : {}),
          ...(next.cssOverrides !== undefined ? { cssOverrides: next.cssOverrides } : {}),
          ...(next.onError !== undefined ? { onError: next.onError } : {}),
          renderWrapper: wrapInScopedProvider,
        });
        return;
      }

      // Same-kind system update — re-render the card with new props
      // through the retained root (no teardown). System cards are
      // pure functions of (kind, props); a props delta just re-renders.
      if (nextKind === 'system' && systemRerender !== null) {
        const render = next.render;
        if (render.type !== 'system') return;
        systemRerender(render);
        return;
      }
      // provisional / mcpApps same-kind: no in-place update surface.
      // Provisional keeps accumulating envelopes; mcpApps iframe
      // doesn't rebind its src during its lifetime.
    },
    unmount: teardown,
  };
}
