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
// `hoistImports` / `loadModule` come from the dedicated subpath (the
// `/rendering` barrel deliberately excludes them to keep blob-URL
// loading out of React Native bundles) — same route the other
// in-repo consumers of the compile pipeline use.
import { hoistImports, loadModule } from '@ggui-ai/design/module-loader';
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
  | { readonly status: 'action-not-rendered'; readonly diagnostic: string }
  | { readonly status: 'action-no-effect'; readonly diagnostic: string }
  | {
      readonly status: 'ok';
      readonly dispatchFired: boolean;
      readonly domChanged: boolean;
      /** Which pass found the control that produced the signal, and how many were clicked to get there. */
      readonly via?: 'named' | 'fallback';
      readonly clicked?: number;
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

/**
 * What a generated component may wire an action to. Kept to real controls
 * (a `<div onClick>` that names nothing is not a contract affordance).
 */
const CLICKABLE_SELECTOR =
  'button, [role="button"], input[type="submit"], input[type="button"], ' +
  'input[type="checkbox"], input[type="radio"], [role="switch"], [role="checkbox"], ' +
  '[role="menuitem"], [role="tab"], [role="option"], a[href], [data-action], summary';
/** Per-control wait in the fallback pass — enough for a synchronous dispatch + a render. */
const FALLBACK_CLICK_WAIT_MS = 600;
/** The fallback pass shares one budget so a busy screen cannot run past the caller's timeout. */
const FALLBACK_BUDGET_FLOOR_MS = 6000;

function norm(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * The controls to try, the way the harness's render-check finds them (#996):
 * pass 1 = controls that NAME the action — `data-action` by value (the one
 * hook that names the action rather than its label), then aria-label / text
 * carrying the label or the name; pass 2 = every other enabled clickable, in
 * DOM order. A generated component that wires `useAction('toggleItem')` to an
 * unnamed checkbox is found by pass 2 and judged by what its click dispatches.
 */
function collectActionCandidates(
  root: HTMLElement,
  name: string,
  label: string,
): { readonly named: readonly HTMLElement[]; readonly fallback: readonly HTMLElement[] } {
  const all = Array.from(root.querySelectorAll(CLICKABLE_SELECTOR)).filter(
    (el): el is HTMLElement =>
      el instanceof HTMLElement &&
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-disabled') !== 'true',
  );
  const lcName = name.toLowerCase();
  const lcLabel = label.toLowerCase();
  const nameKey = norm(name);
  const labelKey = norm(label);
  const byValue: HTMLElement[] = [];
  const byText: HTMLElement[] = [];
  const rest: HTMLElement[] = [];
  for (const el of all) {
    const dataAction = (el.getAttribute('data-action') ?? '').toLowerCase();
    if (dataAction === lcName) {
      byValue.push(el);
      continue;
    }
    const aria = (el.getAttribute('aria-label') ?? '').toLowerCase();
    const txt = (el.textContent ?? '').trim().toLowerCase();
    const ariaNames =
      aria.length > 0 && (aria.includes(lcLabel) || (nameKey.length > 0 && norm(aria).includes(nameKey)));
    const textNames =
      txt.length > 0 &&
      (txt.includes(lcLabel) ||
        (nameKey.length > 0 && norm(txt).includes(nameKey)) ||
        (labelKey.length > 0 && norm(txt).includes(labelKey)));
    (ariaNames || textNames ? byText : rest).push(el);
  }
  return { named: [...byValue, ...byText], fallback: rest };
}

interface Snapshot {
  readonly text: string;
  readonly html: string;
  readonly named: number;
  readonly total: number;
}

function countNamedDispatches(actionName: string): number {
  return (window.__ggui_test_dispatches__ ?? []).filter((d) => d.actionName === actionName).length;
}

function snapshot(container: HTMLElement, actionName: string): Snapshot {
  return {
    text: container.textContent ?? '',
    html: container.innerHTML,
    named: countNamedDispatches(actionName),
    total: (window.__ggui_test_dispatches__ ?? []).length,
  };
}

interface Observation {
  readonly dispatchFired: boolean;
  readonly domChanged: boolean;
  /** Actions OTHER than the one under test that the click dispatched — reported, never counted. */
  readonly otherActions: readonly string[];
}

/** Poll for the required signal after a click. `dispatchFired` counts only dispatches of THIS action. */
async function observe(
  container: HTMLElement,
  actionName: string,
  before: Snapshot,
  req: SignalRequirement,
  waitMs: number,
): Promise<Observation> {
  const start = Date.now();
  let dispatchFired = false;
  let domChanged = false;
  while (Date.now() - start < waitMs) {
    await delay(50);
    if (!dispatchFired && countNamedDispatches(actionName) > before.named) {
      dispatchFired = true;
    }
    if (!domChanged) {
      const afterText = container.textContent ?? '';
      const afterHtml = container.innerHTML;
      if (afterText !== before.text || afterHtml !== before.html) {
        domChanged = true;
      }
    }
    if (dispatchFired && domChanged) break;
    // Early-exit once the REQUIRED signal has fired (don't wait for the other one).
    if (req.requireDispatch && dispatchFired) break;
    if (req.requireDom && domChanged) break;
  }
  const otherActions = (window.__ggui_test_dispatches__ ?? [])
    .slice(before.total)
    .map((d) => d.actionName)
    .filter((n) => n !== actionName);
  return { dispatchFired, domChanged, otherActions: [...new Set(otherActions)] };
}

function satisfied(req: SignalRequirement, obs: Observation): boolean {
  return (req.requireDispatch ? obs.dispatchFired : true) && (req.requireDom ? obs.domChanged : true);
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
    render: { sessionId: 'vt-render', isConnected: true },
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

    const req = signalRequirement(input.classification);
    const container = handles.container;
    const { named, fallback } = collectActionCandidates(container, input.actionName, entry.label);
    if (named.length === 0 && fallback.length === 0) {
      return {
        status: 'action-not-rendered',
        diagnostic: `no clickable control in the rendered DOM for actionSpec.${input.actionName} (label "${entry.label}")`,
      };
    }
    // Named controls each get the caller's full wait; the fallback pass is
    // bounded per control and as a whole (a busy screen has many clickables).
    const fallbackEachMs = Math.min(input.waitMs, FALLBACK_CLICK_WAIT_MS);
    const fallbackBudgetMs = Math.max(input.waitMs * 3, FALLBACK_BUDGET_FLOOR_MS);
    let clicked = 0;
    let bestDispatch = false;
    let bestDom = false;
    const otherActions = new Set<string>();
    const attempt = async (el: HTMLElement, waitMs: number, via: 'named' | 'fallback'): Promise<RunOutcome | null> => {
      const before = snapshot(container, input.actionName);
      clicked += 1;
      el.click();
      const obs = await observe(container, input.actionName, before, req, waitMs);
      bestDispatch = bestDispatch || obs.dispatchFired;
      bestDom = bestDom || obs.domChanged;
      for (const a of obs.otherActions) otherActions.add(a);
      return satisfied(req, obs)
        ? { status: 'ok', dispatchFired: obs.dispatchFired, domChanged: obs.domChanged, via, clicked }
        : null;
    };
    for (const el of named) {
      const hit = await attempt(el, input.waitMs, 'named');
      if (hit !== null) return hit;
    }
    const fallbackStart = Date.now();
    let exhausted = false;
    for (const el of fallback) {
      if (Date.now() - fallbackStart > fallbackBudgetMs) {
        exhausted = true;
        break;
      }
      const hit = await attempt(el, fallbackEachMs, 'fallback');
      if (hit !== null) return hit;
    }
    const missing: string[] = [];
    if (req.requireDispatch && !bestDispatch) missing.push('dispatch');
    if (req.requireDom && !bestDom) missing.push('DOM change');
    const others = otherActions.size > 0 ? `; other actions dispatched: ${[...otherActions].join(', ')}` : '';
    return {
      status: 'action-no-effect',
      diagnostic:
        `${req.description}; clicked ${clicked} control(s) (${named.length} named, ${fallback.length} fallback` +
        `${exhausted ? ', budget exhausted' : ''}); best observed dispatch=${bestDispatch}, domChanged=${bestDom}; ` +
        `missing=${missing.join('+')}${others}`,
    };
  } finally {
    window.removeEventListener('error', onWindowError);
    if (handles !== null) tearDown(handles);
  }
}

window.__validateContractBehavior_run__ = run;
