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
  /** Parsed JSON of the commit's fixture props; a plain object or nothing. */
  readonly sampleProps: unknown;
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
  '[role="menuitem"], [role="tab"], [role="option"], [data-action]';
// Deliberately NOT candidates: <a href> (a click navigates the fixture page
// away and aborts every remaining check) and <summary> (its click toggles the
// parent <details> — a DOM change that says nothing about the action).
/** Per-control wait in the fallback pass — enough for a synchronous dispatch + a render. */
const FALLBACK_CLICK_WAIT_MS = 600;
/**
 * ONE deadline covers both passes for an action: max(the caller's wait, this
 * floor). A few loosely-matching decoys can no longer run an action for
 * minutes; the floor keeps very short test waits from starving the fallback.
 */
const ACTION_BUDGET_FLOOR_MS = 6000;

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
): { readonly named: readonly HTMLElement[]; readonly fallback: readonly HTMLElement[]; readonly disabled: number } {
  const every = Array.from(root.querySelectorAll(CLICKABLE_SELECTOR)).filter(
    (el): el is HTMLElement => el instanceof HTMLElement,
  );
  const isDisabled = (el: HTMLElement): boolean => el.hasAttribute('disabled') || el.getAttribute('aria-disabled') === 'true';
  const disabled = every.filter(isDisabled).length;
  const all = every.filter(
    (el) =>
      !isDisabled(el) &&
      // an already-checked radio fires no change on click — nothing to observe
      !(el instanceof HTMLInputElement && el.type === 'radio' && el.checked),
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
  return { named: [...byValue, ...byText], fallback: rest, disabled };
}

const TEXT_LIKE_INPUT_TYPES = new Set(['text', 'email', 'search', 'url', 'tel', 'number', 'password', '']);

function sampleValueFor(el: HTMLInputElement | HTMLTextAreaElement): string {
  const type = el instanceof HTMLInputElement ? el.type : 'textarea';
  switch (type) {
    case 'number':
      return '1';
    case 'email':
      return 'probe@example.com';
    case 'url':
      return 'https://example.com';
    case 'tel':
      return '5550100';
    default:
      return 'probe';
  }
}

/** Set a value the way React notices it: through the prototype's native setter, then an input + change event. */
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement
    ? HTMLTextAreaElement.prototype
    : el instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  if (setter) setter.call(el, value);
  else el.value = value;
  el.dispatchEvent(new Event('input', { bubbles: true }));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/**
 * The generic minimum a user does before pressing Send / Submit / Complete
 * (#1021): give every empty text-like input and textarea a value, every
 * unset select its first real option, every unchecked radio group its first
 * radio. Checkboxes are never touched — they are often the action itself.
 * Returns how many controls were primed.
 */
function primeInputs(root: HTMLElement): number {
  let primed = 0;
  const editable = (el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement): boolean =>
    !el.disabled && !(el instanceof HTMLSelectElement) ? !(el as HTMLInputElement | HTMLTextAreaElement).readOnly : !el.disabled;
  for (const el of Array.from(root.querySelectorAll('input, textarea'))) {
    if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) || !editable(el)) continue;
    if (el instanceof HTMLInputElement && !TEXT_LIKE_INPUT_TYPES.has(el.type)) continue;
    if (el.value.trim().length > 0) continue;
    setNativeValue(el, sampleValueFor(el));
    primed += 1;
  }
  for (const el of Array.from(root.querySelectorAll('select'))) {
    if (!(el instanceof HTMLSelectElement) || el.disabled) continue;
    const current = el.options[el.selectedIndex];
    if (current !== undefined && current.value.trim().length > 0) continue;
    const first = Array.from(el.options).find((o) => o.value.trim().length > 0 && !o.disabled);
    if (first === undefined) continue;
    setNativeValue(el, first.value);
    primed += 1;
  }
  const seenGroups = new Set<string>();
  for (const el of Array.from(root.querySelectorAll('input[type="radio"]'))) {
    if (!(el instanceof HTMLInputElement) || el.disabled) continue;
    const group = el.name || '';
    if (seenGroups.has(group)) continue;
    seenGroups.add(group);
    const members = group
      ? Array.from(root.querySelectorAll(`input[type="radio"][name="${CSS.escape(group)}"]`)).filter((m): m is HTMLInputElement => m instanceof HTMLInputElement)
      : [el];
    if (members.some((m) => m.checked)) continue;
    const first = members.find((m) => !m.disabled);
    if (first === undefined) continue;
    first.click();
    primed += 1;
  }
  return primed;
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

/**
 * A control's identity across re-renders: its path from the mount root by tag
 * and sibling index (plus an input's type). A re-rendered equivalent at the
 * same position counts as already tried; a detached node never gets clicked.
 */
function signatureOf(root: HTMLElement, el: HTMLElement): string {
  const parts: string[] = [];
  let cur: HTMLElement | null = el;
  while (cur !== null && cur !== root) {
    const parent: HTMLElement | null = cur.parentElement;
    const idx = parent === null ? 0 : Array.prototype.indexOf.call(parent.children, cur);
    const type = cur instanceof HTMLInputElement ? `[${cur.type}]` : '';
    parts.push(`${cur.tagName.toLowerCase()}${type}:${idx}`);
    cur = parent;
  }
  return parts.reverse().join('/');
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

function propsOf(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function mountTree(
  Comp: React.ComponentType<Record<string, unknown>>,
  props: Record<string, unknown>,
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
  // The commit's fixture props: a component that draws its controls from
  // props (a board's tasks, a list's items) mounts EMPTY without them.
  const componentElement = React.createElement(Comp, props);
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
      handles = mountTree(Comp, propsOf(input.sampleProps));
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
    // Prime inputs first (#1021): Send/Submit/Complete are commonly disabled
    // until something is typed or chosen — the minimum a user does before them.
    const primed = primeInputs(container);
    if (primed > 0) await delay(150);
    const first = collectActionCandidates(container, input.actionName, entry.label);
    if (first.named.length === 0 && first.fallback.length === 0) {
      if (first.disabled > 0) {
        return {
          status: 'action-no-effect',
          diagnostic:
            `${first.disabled} control(s) rendered, all disabled — the action is gated on input the probe did not provide ` +
            `(primed ${primed} input(s)); actionSpec.${input.actionName} (label "${entry.label}")`,
        };
      }
      return {
        status: 'action-not-rendered',
        diagnostic: `no clickable control in the rendered DOM for actionSpec.${input.actionName} (label "${entry.label}")`,
      };
    }
    // One deadline for the whole action. Named controls get the caller's wait
    // (or what is left of the budget); fallback controls get a short slice each.
    const deadline = Date.now() + Math.max(input.waitMs, ACTION_BUDGET_FLOOR_MS);
    const remaining = (): number => Math.max(0, deadline - Date.now());
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
    // Re-collect LIVE candidates before EVERY click: an earlier click may have
    // re-rendered the tree (a filter, a tab, an opened editor), detaching what
    // was collected and adding what was not there. A control is tried once,
    // by its DOM path; a detached node is never the one clicked.
    const tried = new Set<string>();
    let exhausted = false;
    for (;;) {
      if (remaining() === 0) {
        exhausted = true;
        break;
      }
      const live = collectActionCandidates(container, input.actionName, entry.label);
      const untried = (list: readonly HTMLElement[]): HTMLElement | undefined =>
        list.find((el) => el.isConnected && !tried.has(signatureOf(container, el)));
      const nextNamed = untried(live.named);
      const next = nextNamed ?? untried(live.fallback);
      if (next === undefined) break;
      const via: 'named' | 'fallback' = nextNamed !== undefined ? 'named' : 'fallback';
      tried.add(signatureOf(container, next));
      const hit = await attempt(
        next,
        via === 'named' ? Math.min(input.waitMs, remaining()) : Math.min(FALLBACK_CLICK_WAIT_MS, remaining()),
        via,
      );
      if (hit !== null) return hit;
    }
    const missing: string[] = [];
    if (req.requireDispatch && !bestDispatch) missing.push('dispatch');
    if (req.requireDom && !bestDom) missing.push('DOM change');
    const others = otherActions.size > 0 ? `; other actions dispatched: ${[...otherActions].join(', ')}` : '';
    return {
      status: 'action-no-effect',
      diagnostic:
        `${req.description}; clicked ${clicked} control(s) (${tried.size} distinct; first collection ${first.named.length} named, ${first.fallback.length} fallback, ${first.disabled} disabled; primed ${primed} input(s)` +
        `${exhausted ? '; budget exhausted' : ''}); best observed dispatch=${bestDispatch}, domChanged=${bestDom}; ` +
        `missing=${missing.join('+')}${others}`,
    };
  } finally {
    window.removeEventListener('error', onWindowError);
    if (handles !== null) tearDown(handles);
  }
}

window.__validateContractBehavior_run__ = run;
