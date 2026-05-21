/**
 * Browser-side fixture runtime for `validateContractBehavior`.
 *
 * Bundled to an IIFE by `scripts/build-fixture-bundle.mjs` and injected
 * into the test page via `addScriptTag({content: bundle})`. Exposes
 * one global function:
 *
 *   window.__validateContractBehavior_run__(input): Promise<RunOutcome>
 *
 * The Node-side driver (`validate.ts`) calls this once per action with
 * the compiled component source + the classification gate (Option C —
 * `agent-bound` vs `context-bound`). The fixture mounts the component
 * once, finds the button by label, clicks it, then waits for the
 * required signal to fire.
 */
import * as React from 'react';
import * as ReactDomClient from 'react-dom/client';
import * as DesignPrimitives from '@ggui-ai/design/primitives';
import * as DesignComponents from '@ggui-ai/design/components';
import * as DesignCompositions from '@ggui-ai/design/compositions';
import * as DesignInteract from '@ggui-ai/design/interact';
import * as Wire from '@ggui-ai/wire';
import {
  rewriteImports,
  stripMarkers,
} from '@ggui-ai/design/rendering';

interface ParsedActionEntry {
  readonly label: string;
}

interface ContractView {
  readonly actionSpec: Record<string, ParsedActionEntry>;
}

function parseActionEntry(raw: unknown): ParsedActionEntry | null {
  if (raw === null || typeof raw !== 'object') return null;
  const r = raw as { label?: unknown };
  if (typeof r.label !== 'string') return null;
  return { label: r.label };
}

function parseContract(raw: unknown): ContractView {
  const out: Record<string, ParsedActionEntry> = {};
  if (raw === null || typeof raw !== 'object') return { actionSpec: out };
  const v = raw as { actionSpec?: unknown };
  if (v.actionSpec === null || typeof v.actionSpec !== 'object') {
    return { actionSpec: out };
  }
  for (const [name, entry] of Object.entries(
    v.actionSpec as Record<string, unknown>,
  )) {
    const parsed = parseActionEntry(entry);
    if (parsed !== null) out[name] = parsed;
  }
  return { actionSpec: out };
}

interface DispatchRecord {
  readonly actionName: string;
  readonly data: unknown;
  readonly t: number;
}

type ActionClassification = 'agent-bound' | 'context-bound';

interface RunInput {
  readonly componentCode: string;
  readonly contract: unknown;
  readonly actionName: string;
  readonly classification: ActionClassification;
  readonly settleMs: number;
  readonly waitMs: number;
}

type RunOutcome =
  | { readonly status: 'render-failed'; readonly diagnostic: string }
  | { readonly status: 'action-not-rendered' }
  | { readonly status: 'action-no-effect'; readonly diagnostic: string }
  | {
      readonly status: 'ok';
      readonly dispatchFired: boolean;
      readonly domChanged: boolean;
    };

declare global {
  interface Window {
    __ggui_test_dispatches__?: DispatchRecord[];
    __validateContractBehavior_run__?: (input: RunInput) => Promise<RunOutcome>;
    __ggui__?: GguiRegistry;
    __REACT?: typeof React;
    __GGUI_PRIMITIVES?: typeof DesignPrimitives;
    __GGUI_COMPONENTS?: typeof DesignComponents;
    __GGUI_COMPOSITIONS?: typeof DesignCompositions;
    __GGUI_INTERACT?: typeof DesignInteract;
    __GGUI_APP_COMPONENTS?: Record<string, unknown>;
  }
}

interface GguiRegistry {
  react: typeof React;
  reactDom: typeof ReactDomClient;
  primitives: typeof DesignPrimitives;
  components: typeof DesignComponents;
  compositions: typeof DesignCompositions;
  interact: typeof DesignInteract;
  /**
   * App-components slot — populated by the renderer when an app's
   * `appComponents` table is in scope. ui-visual-tester leaves it empty
   * (the validator's job is to verify a generated component's contract
   * wiring, not its app-component composition); generated code that
   * imports `@ggui-ai/design/app-components` will get an empty named
   * shim. If a real failure occurs from this, the diagnostic surfaces
   * it via render-failed.
   */
  appComponents: Record<string, unknown>;
  wire: typeof Wire;
  adapters: Record<string, unknown>;
}

function installRegistry(): GguiRegistry {
  const registry: GguiRegistry = {
    react: React,
    reactDom: ReactDomClient,
    primitives: DesignPrimitives,
    components: DesignComponents,
    compositions: DesignCompositions,
    interact: DesignInteract,
    appComponents: {},
    wire: Wire,
    adapters: {},
  };
  window.__ggui__ = registry;
  window.__REACT = React;
  window.__GGUI_PRIMITIVES = DesignPrimitives;
  window.__GGUI_COMPONENTS = DesignComponents;
  window.__GGUI_COMPOSITIONS = DesignCompositions;
  window.__GGUI_INTERACT = DesignInteract;
  window.__GGUI_APP_COMPONENTS = registry.appComponents;
  return registry;
}

function findActionButton(
  root: HTMLElement,
  label: string,
): HTMLElement | null {
  const ariaMatch = root.querySelector(
    `[aria-label="${CSS.escape(label)}"]`,
  );
  if (ariaMatch instanceof HTMLElement) return ariaMatch;
  const lc = label.toLowerCase();
  const candidates = root.querySelectorAll(
    'button, [role="button"], a, [data-action]',
  );
  for (const el of Array.from(candidates)) {
    if (!(el instanceof HTMLElement)) continue;
    const txt = (el.textContent ?? '').trim().toLowerCase();
    if (txt.length > 0 && txt.includes(lc)) return el;
  }
  for (const el of Array.from(root.querySelectorAll('*'))) {
    if (!(el instanceof HTMLElement)) continue;
    const txt = (el.textContent ?? '').trim().toLowerCase();
    if (txt === lc) return el;
  }
  return null;
}

async function loadModule(code: string): Promise<Record<string, unknown>> {
  const blob = new Blob([code], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  try {
    return await import(/* @vite-ignore */ url);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function hoistImports(code: string): string {
  const parts = code.split(';');
  const imports: string[] = [];
  const rest: string[] = [];
  for (const part of parts) {
    const trimmed = part.trimStart();
    if (trimmed.startsWith('import')) {
      imports.push(part);
    } else {
      rest.push(part);
    }
  }
  if (imports.length === 0) return code;
  return imports.join(';') + ';' + rest.join(';');
}

async function evaluateComponent(
  code: string,
): Promise<React.ComponentType<Record<string, unknown>>> {
  const cleaned = stripMarkers(code);
  const hoisted = hoistImports(cleaned);
  const rewritten = rewriteImports(hoisted, { mode: 'data-url' });
  const mod = await loadModule(rewritten);
  const Comp =
    (mod.default as React.ComponentType<Record<string, unknown>> | undefined) ??
    Object.values(mod).find(
      (v): v is React.ComponentType => typeof v === 'function',
    );
  if (Comp === undefined) {
    throw new Error('Module does not export a default component');
  }
  return Comp;
}

interface MountHandles {
  readonly container: HTMLElement;
  readonly root: ReactDomClient.Root;
}

function mountTree(
  Comp: React.ComponentType<Record<string, unknown>>,
): MountHandles {
  const container = document.createElement('div');
  container.id = 'ggui-vt-mount';
  document.body.replaceChildren(container);

  installRegistry();

  const dispatches: DispatchRecord[] = window.__ggui_test_dispatches__ ?? [];
  window.__ggui_test_dispatches__ = dispatches;

  /**
   * Minimal `WireConfig` for the fixture. The fixture only needs
   * `dispatch` (records into `__ggui_test_dispatches__` for the
   * agent-bound classification gate) and `subscribe` (no-op — no
   * streams in the validator's scope).
   */
  const wireConfig: Wire.WireConfig = {
    app: { appId: 'vt-app', appName: 'vt-app' },
    session: { sessionId: 'vt-session', isConnected: true },
    auth: { isAuthenticated: false },
    dispatch: (actionName, data) => {
      dispatches.push({ actionName, data, t: Date.now() });
    },
    subscribe: () => () => {},
  };

  const root = ReactDomClient.createRoot(container);
  const componentElement = React.createElement(Comp, {});
  const tree = React.createElement(Wire.GguiWireProvider, {
    config: wireConfig,
    children: componentElement,
  });

  root.render(tree);
  return { container, root };
}

function tearDown(handles: MountHandles): void {
  handles.root.unmount();
  handles.container.remove();
  if (window.__ggui_test_dispatches__) {
    window.__ggui_test_dispatches__.length = 0;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface SignalRequirement {
  readonly requireDispatch: boolean;
  readonly requireDom: boolean;
  readonly description: string;
}

function signalRequirement(
  classification: ActionClassification,
): SignalRequirement {
  if (classification === 'agent-bound') {
    return {
      requireDispatch: true,
      requireDom: false,
      description:
        'agent-bound (nextStep present): require dispatch(...) to fire',
    };
  }
  // context-bound — local state / DOM mutation expected.
  return {
    requireDispatch: false,
    requireDom: true,
    description:
      'context-bound (no nextStep): require DOM change post-click',
  };
}

async function run(input: RunInput): Promise<RunOutcome> {
  installRegistry();
  let Comp: React.ComponentType<Record<string, unknown>>;
  try {
    Comp = await evaluateComponent(input.componentCode);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { status: 'render-failed', diagnostic: msg };
  }

  const errSlot: { current: Error | null } = { current: null };
  const onWindowError = (event: ErrorEvent): void => {
    if (errSlot.current === null) {
      errSlot.current =
        event.error instanceof Error ? event.error : new Error(event.message);
    }
  };
  window.addEventListener('error', onWindowError);

  const view = parseContract(input.contract);

  let handles: MountHandles | null = null;
  try {
    try {
      handles = mountTree(Comp);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { status: 'render-failed', diagnostic: msg };
    }

    await delay(input.settleMs);

    if (errSlot.current !== null) {
      return { status: 'render-failed', diagnostic: errSlot.current.message };
    }

    const entry = view.actionSpec[input.actionName];
    if (entry === undefined) {
      return {
        status: 'render-failed',
        diagnostic: `actionSpec.${input.actionName} missing`,
      };
    }

    const button = findActionButton(handles.container, entry.label);
    if (button === null) {
      return { status: 'action-not-rendered' };
    }

    const beforeText = handles.container.textContent ?? '';
    const beforeHtml = handles.container.innerHTML;
    const dispatchesBefore = (window.__ggui_test_dispatches__ ?? []).length;

    button.click();

    const start = Date.now();
    let dispatchFired = false;
    let domChanged = false;
    while (Date.now() - start < input.waitMs) {
      await delay(50);
      if (
        !dispatchFired &&
        (window.__ggui_test_dispatches__ ?? []).length > dispatchesBefore
      ) {
        dispatchFired = true;
      }
      if (!domChanged) {
        const afterText = handles.container.textContent ?? '';
        const afterHtml = handles.container.innerHTML;
        if (afterText !== beforeText || afterHtml !== beforeHtml) {
          domChanged = true;
        }
      }
      if (dispatchFired && domChanged) break;
      // Early-exit if the REQUIRED signal has fired (don't wait for the
      // other one — speeds up the slow stage when the wiring is correct).
      const req = signalRequirement(input.classification);
      if (req.requireDispatch && dispatchFired) break;
      if (req.requireDom && domChanged) break;
    }

    const req = signalRequirement(input.classification);
    const required =
      (req.requireDispatch ? dispatchFired : true) &&
      (req.requireDom ? domChanged : true);
    if (!required) {
      const missing: string[] = [];
      if (req.requireDispatch && !dispatchFired) missing.push('dispatch');
      if (req.requireDom && !domChanged) missing.push('DOM change');
      return {
        status: 'action-no-effect',
        diagnostic: `${req.description}; observed dispatch=${dispatchFired}, domChanged=${domChanged}; missing=${missing.join('+')}`,
      };
    }
    return { status: 'ok', dispatchFired, domChanged };
  } finally {
    window.removeEventListener('error', onWindowError);
    if (handles !== null) tearDown(handles);
  }
}

window.__validateContractBehavior_run__ = run;
