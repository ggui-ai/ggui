/**
 * Stack-item dispatcher — routes each SessionStackEntry to the
 * appropriate renderer based on its discriminator.
 *
 * The dispatch tree mirrors `@ggui-ai/react::DynamicComponent` +
 * `McpAppsStackItemRenderer`:
 *
 *   - `type === 'mcpApps'` → `mountMcpAppIframe` (vanilla iframe
 *     host; the recursive foreign-MCP-App path).
 *   - `componentCode` empty OR absent → `mountProvisional` (A2UI
 *     preview fed by the `_ggui:preview` reserved channel).
 *   - otherwise → `mountReactRoot` with a per-item `WireConfig`
 *     built via the renderer's `buildScopedConfig(item)` closure.
 *     The mounted component is wrapped in
 *     `<GguiWireProvider config={scopedConfig}>` through the
 *     `renderWrapper` seam.
 *
 * Per-item lifecycle:
 *
 *   Each stack entry owns a SINGLE `StackItemHandle` for its visible
 *   lifetime. When the entry gets replaced in-place (push matched by
 *   id), the dispatcher transitions the existing handle rather than
 *   unmount + remount — props-only changes skip the React eval; kind
 *   changes unmount the current and mount the replacement.
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
import type { SessionStackEntry } from '@ggui-ai/protocol';
import type { McpAppsStackItem } from '@ggui-ai/protocol/integrations/mcp-apps';
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

export interface StackItemRendererOptions {
  /** The stack item to render. */
  readonly stackItem: SessionStackEntry;
  /** Wire config for this item — pre-scoped via the renderer's
   *  `buildScopedConfig(item)` (see
   *  `wire-config.ts::RootWireConfigBundle`). */
  readonly scopedWireConfig: WireConfig | null;
  /** Shared stream bus — provisional renderer subscribes to
   *  `_ggui:preview` for this item. */
  readonly streamBus: StreamBus;
  /** Session id — used by the mcp-apps iframe host for proxy URLs. */
  readonly sessionId: string;
  /** ggui-server base URL (for mcp-apps proxy). Empty = same-origin. */
  readonly mcpAppsServerBaseUrl?: string;
  /** Theme id passed to ReactComponentRenderer for scoped CSS. */
  readonly themeId?: string;
  /**
   * Theme color mode. Resolves the dark variant of `themeId` when set
   * to `'dark'`. Falls through to `'light'` if absent — matches the
   * design registry's `getTheme(id, mode?)` default.
   */
  readonly themeMode?: 'light' | 'dark';
  readonly cssOverrides?: string;
  readonly onError?: (err: Error) => void;
  readonly onRequestRepair?: (err: Error) => void;
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
   * renderer path where the per-item React mount is the only mount
   * surface.
   */
  readonly wrapOuter?: (mountedTree: ReactNode) => ReactNode;
}

/**
 * Discriminator for WHICH renderer is currently mounted under this
 * stack-item handle. Transitions: 'provisional' → 'react' when
 * componentCode lands; 'react' → 'react' on code/prop updates;
 * 'mcpApps' is terminal for its lifetime (mcp-apps items never
 * become components + vice versa).
 */
type MountedKind = 'provisional' | 'react' | 'mcpApps' | 'none';

export interface StackItemHandle {
  /**
   * Apply an update to the stack-item handle. Kind changes (e.g.
   * provisional → react when componentCode lands) tear down the old
   * mount and stand up the replacement; same-kind updates route to
   * the inner renderer's `update()`.
   */
  update(next: StackItemRendererOptions): Promise<void>;
  /** Tear down the active mount + unsubscribe from the StreamBus. */
  unmount(): void;
  /** Current render kind. Test-only — not load-bearing. */
  readonly kind: MountedKind;
}

// =============================================================================
// Kind detection
// =============================================================================

function detectKind(stackItem: SessionStackEntry): 'mcpApps' | 'react' | 'provisional' {
  if (stackItem.type === 'mcpApps') return 'mcpApps';
  // System items don't route through this stack-item dispatcher — the
  // self-contained boot path renders them via `SystemCardHost` directly.
  // If one accidentally lands here, fall through to provisional so the
  // user at least sees the A2UI placeholder rather than a crash.
  if (stackItem.type === 'system') return 'provisional';
  const code = stackItem.componentCode;
  if (typeof code === 'string' && code.trim().length > 0) return 'react';
  return 'provisional';
}

// =============================================================================
// Mount
// =============================================================================

export async function renderStackItem(
  container: HTMLElement,
  opts: StackItemRendererOptions,
): Promise<StackItemHandle> {
  let currentOpts = opts;
  let currentKind: MountedKind = 'none';
  let reactMount: ReactRootMount | null = null;
  let provisionalMount: ProvisionalMount | null = null;
  let mcpMount: McpAppIframeMount | null = null;
  let previewUnsubscribe: (() => void) | null = null;

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
    if (previewUnsubscribe !== null) {
      previewUnsubscribe();
      previewUnsubscribe = null;
    }
    currentKind = 'none';
  }

  async function mountByKind(kind: 'mcpApps' | 'react' | 'provisional'): Promise<void> {
    if (kind === 'mcpApps') {
      // SessionStackEntry narrows to McpAppsStackItem when type='mcpApps'.
      const item = currentOpts.stackItem as McpAppsStackItem;
      mcpMount = mountMcpAppIframe(container, {
        stackItem: item,
        sessionId: currentOpts.sessionId,
        ...(currentOpts.mcpAppsServerBaseUrl !== undefined
          ? { serverBaseUrl: currentOpts.mcpAppsServerBaseUrl }
          : {}),
      });
      currentKind = 'mcpApps';
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
    const item = currentOpts.stackItem;
    if (item.type === 'mcpApps' || item.type === 'system') return;
    // GG.8.2 — gadget package names from the item's descriptor sidecar
    // so the rewriter resolves each direct gadget import to its
    // per-package shim. STDLIB `@ggui-ai/gadgets` is always rewritten.
    const gadgetPackages =
      'gadgetDescriptors' in item && item.gadgetDescriptors !== undefined
        ? item.gadgetDescriptors.map((d) => d.package)
        : undefined;
    reactMount = await mountReactRoot(container, {
      stackItem: {
        ...(item.id !== undefined ? { id: item.id } : {}),
        componentCode: item.componentCode ?? '',
        ...(item.props !== undefined
          ? { props: item.props }
          : {}),
      },
      ...(gadgetPackages !== undefined ? { gadgetPackages } : {}),
      ...(currentOpts.themeId !== undefined ? { themeId: currentOpts.themeId } : {}),
      ...(currentOpts.themeMode !== undefined ? { themeMode: currentOpts.themeMode } : {}),
      ...(currentOpts.cssOverrides !== undefined
        ? { cssOverrides: currentOpts.cssOverrides }
        : {}),
      ...(currentOpts.onError !== undefined ? { onError: currentOpts.onError } : {}),
      ...(currentOpts.onRequestRepair !== undefined
        ? { onRequestRepair: currentOpts.onRequestRepair }
        : {}),
      renderWrapper: wrapInScopedProvider,
    });
    currentKind = 'react';
  }

  /**
   * Wrap the mounted component in `<GguiWireProvider
   * config={scopedConfig}>` when the caller supplied one. Without a
   * scoped config, the component renders standalone — matches
   * today's DynamicComponent fallback when no GguiSession parent is
   * present.
   *
   * Composition order (outer → inner):
   *
   *     wrapOuter(<GguiWireProvider><userComponent/></GguiWireProvider>)
   *
   * `wrapOuter` is supplied by `bootProduction` to install the
   * `<ContextStateHost>` provider tree around the per-item React
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
  const initialKind = detectKind(opts.stackItem);
  await mountByKind(initialKind);

  return {
    get kind() {
      return currentKind;
    },
    async update(next) {
      const prevKind = currentKind;
      currentOpts = next;
      const nextKind = detectKind(next.stackItem);

      if (nextKind !== prevKind) {
        // Kind changed — tear down old + mount new.
        teardown();
        await mountByKind(nextKind);
        return;
      }

      // Same-kind update — route to the inner renderer's update.
      if (nextKind === 'react' && reactMount !== null) {
        const item = next.stackItem;
        if (item.type === 'mcpApps' || item.type === 'system') return;
        await reactMount.update({
          stackItem: {
            ...(item.id !== undefined ? { id: item.id } : {}),
            componentCode: item.componentCode ?? '',
            ...(item.props !== undefined
              ? { props: item.props }
              : {}),
          },
          ...(next.themeId !== undefined ? { themeId: next.themeId } : {}),
          ...(next.themeMode !== undefined ? { themeMode: next.themeMode } : {}),
          ...(next.cssOverrides !== undefined ? { cssOverrides: next.cssOverrides } : {}),
          ...(next.onError !== undefined ? { onError: next.onError } : {}),
          ...(next.onRequestRepair !== undefined
            ? { onRequestRepair: next.onRequestRepair }
            : {}),
          renderWrapper: wrapInScopedProvider,
        });
      }
      // provisional / mcpApps same-kind: no in-place update surface.
      // Provisional keeps accumulating envelopes; mcpApps iframe
      // doesn't rebind its src during its lifetime.
    },
    unmount: teardown,
  };
}

// =============================================================================
// Stack-level dispatcher
// =============================================================================

export interface StackRenderContext {
  readonly containerFor: (stackItemId: string) => HTMLElement;
  readonly getScopedWireConfig: (item: SessionStackEntry) => WireConfig | null;
  readonly streamBus: StreamBus;
  readonly sessionId: string;
  readonly mcpAppsServerBaseUrl?: string;
  readonly themeId?: string;
  /** Theme color mode — see {@link StackItemRendererOptions.themeMode}. */
  readonly themeMode?: 'light' | 'dark';
  readonly onError?: (err: Error) => void;
  readonly onRequestRepair?: (err: Error) => void;
  /**
   * Optional outer wrapper for each stack-item React mount — see
   * {@link StackItemRendererOptions.wrapOuter}. `bootProduction` uses
   * this to inject `<ContextStateHost>` around every per-item React
   * root, mirroring the wrap `bootSelfContained` performs at its
   * single React root. Returning the input unchanged is equivalent
   * to passing `undefined`.
   */
  readonly getOuterWrapper?: (
    item: SessionStackEntry,
  ) => ((mountedTree: ReactNode) => ReactNode) | undefined;
}

/**
 * Minimal stack-level orchestrator — keyed by stackItem.id, mounts
 * new items, updates existing ones, unmounts removed ones.
 *
 * The production renderer tree uses this; tests can drive the
 * individual `renderStackItem` entry point directly.
 */
export class StackRenderer {
  private handles = new Map<string, StackItemHandle>();

  constructor(private readonly ctx: StackRenderContext) {}

  async applyStack(stack: readonly SessionStackEntry[]): Promise<void> {
    const nextIds = new Set(stack.map((s) => s.id));

    // Unmount removed items.
    for (const [id, handle] of this.handles) {
      if (!nextIds.has(id)) {
        handle.unmount();
        this.handles.delete(id);
      }
    }

    // Mount or update each item in stack order.
    for (const item of stack) {
      const container = this.ctx.containerFor(item.id);
      const scopedWireConfig = this.ctx.getScopedWireConfig(item);
      const wrapOuter = this.ctx.getOuterWrapper?.(item);
      const opts: StackItemRendererOptions = {
        stackItem: item,
        scopedWireConfig,
        streamBus: this.ctx.streamBus,
        sessionId: this.ctx.sessionId,
        ...(this.ctx.mcpAppsServerBaseUrl !== undefined
          ? { mcpAppsServerBaseUrl: this.ctx.mcpAppsServerBaseUrl }
          : {}),
        ...(this.ctx.themeId !== undefined ? { themeId: this.ctx.themeId } : {}),
        ...(this.ctx.themeMode !== undefined ? { themeMode: this.ctx.themeMode } : {}),
        ...(this.ctx.onError !== undefined ? { onError: this.ctx.onError } : {}),
        ...(this.ctx.onRequestRepair !== undefined
          ? { onRequestRepair: this.ctx.onRequestRepair }
          : {}),
        ...(wrapOuter !== undefined ? { wrapOuter } : {}),
      };

      const existing = this.handles.get(item.id);
      if (existing === undefined) {
        const handle = await renderStackItem(container, opts);
        this.handles.set(item.id, handle);
      } else {
        await existing.update(opts);
      }
    }
  }

  unmountAll(): void {
    for (const handle of this.handles.values()) {
      handle.unmount();
    }
    this.handles.clear();
  }
}
