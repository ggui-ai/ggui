// packages/ui-gen/src/harness/check/runtime-render/probe.ts
//
// Probe — captures wire-surface activity for runtime render evaluation.
//
// Design:
//
//   We do NOT mirror @ggui-ai/wire's hooks. The hooks already route
//   entirely through WireContext (dispatch / subscribe). So we just
//   provide a probe-backed WireConfig to the real GguiWireProvider.
//   The real hooks run; only the underlying primitives are intercepted.
//
//   Wins:
//     - no parallel hook implementation to maintain
//     - no esbuild aliasing
//     - hook semantics stay faithful to production
//     - stream re-renders flow through the real useStream's React update path
//
// The Probe object is shared in two scopes:
//   - Inside the React tree, via the WireConfig captured from createProbeWireConfig()
//   - Outside the React tree, via the same Probe reference held by the test runner
//
// Tests use the outside reference to:
//   - emitStream(name, payload) → invokes captured subscribers, real useStream re-renders
//   - inspect getFireLog() / getRegistered() to verify wiring

import type { WireConfig } from "@ggui-ai/wire";

// ─────────────────────────────────────────────────────────────────────────────
// Event log shape
// ─────────────────────────────────────────────────────────────────────────────

export interface ActionFiredEvent {
  readonly kind: "action.fired";
  readonly name: string;
  readonly payload?: unknown;
  readonly ts: number;
}

/**
 * A `ui/open-link` envelope was emitted toward the parent — fired when
 * the iframe-runtime's anchor interceptor catches an external link
 * click and routes through the host. CHECK tier observes this when
 * the generated component renders a plain `<a href="https://...">`.
 */
export interface LinkOpenedEvent {
  readonly kind: "link.opened";
  readonly url: string;
  readonly ts: number;
}

/**
 * A `ui/request-display-mode` envelope was emitted toward the parent
 * — fired when the iframe-runtime's native-API interceptor catches
 * a `requestFullscreen()` / `exitFullscreen()` call and routes it
 * through the host.
 */
export interface DisplayModeRequestedEvent {
  readonly kind: "displayMode.requested";
  readonly mode: string;
  readonly ts: number;
}

export type ProbeEvent =
  | ActionFiredEvent
  | LinkOpenedEvent
  | DisplayModeRequestedEvent;

export interface RegisteredHooks {
  /** Stream event names that received at least one subscribe() call. */
  readonly streams: readonly string[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Probe interface
// ─────────────────────────────────────────────────────────────────────────────

export interface Probe {
  // ── Inputs (test → component) ──────────────────────────────────────────
  /** Push a stream event payload. Calls all current subscribers for `eventName`. */
  emitStream<T = unknown>(eventName: string, payload: T): void;

  // ── Observations (read after interaction) ──────────────────────────────
  getFireLog(): readonly ProbeEvent[];
  getRegistered(): RegisteredHooks;
  /** Convenience: did any action.fired event match this name? */
  fired(actionName: string): boolean;

  // ── Lifecycle ──────────────────────────────────────────────────────────
  /**
   * Install a spy on `window.parent.postMessage` so envelopes emitted
   * by the iframe-runtime interceptors (anchor click → `ui/open-link`,
   * `requestFullscreen()` → `ui/request-display-mode`) are recorded
   * into the probe's fire log. Returns an uninstall function.
   *
   * Safe to call multiple times — each call replaces the previous spy.
   * The render-check harness installs the spy at render boot and
   * uninstalls during teardown.
   */
  installPostMessageSpy(): () => void;
  reset(): void;
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal state — held as closures in the Probe instance for isolation
// ─────────────────────────────────────────────────────────────────────────────

interface ProbeInternals {
  fireLog: ProbeEvent[];
  streamHandlers: Map<string, Set<(d: unknown) => void>>;
  registeredStreams: Set<string>;
}

function makeInternals(): ProbeInternals {
  return {
    fireLog: [],
    streamHandlers: new Map(),
    registeredStreams: new Set(),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// createProbe()
// ─────────────────────────────────────────────────────────────────────────────

export function createProbe(): Probe & {
  /** @internal — used by createProbeWireConfig to share state. Do not call from tests. */
  __internals: ProbeInternals;
} {
  let internals = makeInternals();

  const probe: Probe & { __internals: ProbeInternals } = {
    emitStream: <T>(eventName: string, payload: T): void => {
      const handlers = internals.streamHandlers.get(eventName);
      if (!handlers) return;
      for (const handler of handlers) handler(payload);
    },

    getFireLog: (): readonly ProbeEvent[] => internals.fireLog.slice(),

    getRegistered: (): RegisteredHooks => ({
      streams: Array.from(internals.registeredStreams),
    }),

    fired: (actionName: string): boolean =>
      internals.fireLog.some(e => e.kind === "action.fired" && e.name === actionName),

    installPostMessageSpy: (): (() => void) => installPostMessageSpy(probe),

    reset: (): void => {
      internals = makeInternals();
      // Mutate __internals reference too so existing wire config still sees fresh state.
      probe.__internals = internals;
    },

    __internals: internals,
  };

  return probe;
}

// ─────────────────────────────────────────────────────────────────────────────
// postMessage spy — observes envelopes emitted by the iframe-runtime
// interceptors (anchor click, requestFullscreen). The renderer's
// WireConfig still funnels into the probe via the closure-shared
// internals; this spy is the parallel observation channel for
// envelope-layer effects that bypass WireConfig.
// ─────────────────────────────────────────────────────────────────────────────

interface JsonRpcEnvelope {
  readonly jsonrpc?: unknown;
  readonly method?: unknown;
  readonly params?: unknown;
}

function installPostMessageSpy(
  probe: Probe & { __internals: ProbeInternals },
): () => void {
  // happy-dom: window.parent === window in the default test setup, so the
  // helpers' calls to `window.parent.postMessage` land on this same surface.
  // Probe state is held in the closure over `probe.__internals` so calls
  // from inside the React tree write to the same fire log the tests read.
  const parent = (globalThis as { window?: { parent?: { postMessage?: unknown } } }).window?.parent;
  if (!parent || typeof parent.postMessage !== "function") {
    // No parent surface to spy on — return a noop uninstaller. The probe
    // still observes WireConfig-layer events (dispatch, etc.).
    return () => {};
  }
  const original = parent.postMessage;
  const spy = (...args: unknown[]): unknown => {
    const envelope = args[0];
    recordEnvelope(probe.__internals, envelope);
    // Forward to the original so happy-dom's own postMessage semantics
    // (queueing, dispatch) keep working — the spy is observation-only.
    return (original as (...a: unknown[]) => unknown).apply(parent, args);
  };
  try {
    Object.defineProperty(parent, "postMessage", {
      value: spy,
      configurable: true,
      writable: true,
    });
  } catch {
    // Locked-down host runtime — give up silently. The probe still sees
    // WireConfig-layer events.
    return () => {};
  }
  return () => {
    try {
      Object.defineProperty(parent, "postMessage", {
        value: original,
        configurable: true,
        writable: true,
      });
    } catch {
      /* ignore */
    }
  };
}

function recordEnvelope(internals: ProbeInternals, envelope: unknown): void {
  if (!envelope || typeof envelope !== "object") return;
  const e = envelope as JsonRpcEnvelope;
  if (typeof e.method !== "string") return;
  const params = (e.params ?? {}) as Record<string, unknown>;

  switch (e.method) {
    case "ui/open-link": {
      const url = typeof params.url === "string" ? params.url : "";
      internals.fireLog.push({
        kind: "link.opened",
        url,
        ts: Date.now(),
      });
      return;
    }
    case "ui/request-display-mode": {
      const mode = typeof params.mode === "string" ? params.mode : "";
      internals.fireLog.push({
        kind: "displayMode.requested",
        mode,
        ts: Date.now(),
      });
      return;
    }
    case "tools/call": {
      // The only tools/call with a legitimate emitter is the audit
      // envelope (`ggui_runtime_submit_action`), and WireConfig.dispatch
      // already records its paired `action.fired` — nothing to record
      // here. The runtime never fires any other tool from the iframe:
      // every action rides the consume buffer and the agent invokes
      // tools on its own turn.
      return;
    }
    default:
      // Unrecognized envelope — ignore. New methods get explicit handling
      // when added to the protocol; silent fall-through is fine for now.
      return;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// createProbeWireConfig() — produces a WireConfig that funnels into the Probe
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build a WireConfig backed by the given Probe. Use as the `config` prop of
 * GguiWireProvider in render-check tests.
 *
 * The WireConfig holds a closure over `probe.__internals` so that calls from
 * inside the React tree (via the real useAction/useStream/etc. hooks) flow
 * straight into the same probe state the test inspects from outside.
 */
export function createProbeWireConfig(
  probe: Probe & { __internals: ProbeInternals },
): WireConfig {
  return {
    app: {
      appId: "probe-app",
      appName: "Probe",
      appDescription: "Eval-time probe wire config",
    },
    render: {
      sessionId: "probe-render",
      isConnected: true,
    },
    auth: {
      isAuthenticated: false,
    },

    dispatch: <T = unknown>(actionName: string, data: T): void => {
      probe.__internals.fireLog.push({
        kind: "action.fired",
        name: actionName,
        payload: data,
        ts: Date.now(),
      });
    },

    subscribe: <T = unknown>(eventType: string, handler: (data: T) => void): (() => void) => {
      probe.__internals.registeredStreams.add(eventType);
      let set = probe.__internals.streamHandlers.get(eventType);
      if (!set) {
        set = new Set();
        probe.__internals.streamHandlers.set(eventType, set);
      }
      const wrapped = handler as (d: unknown) => void;
      set.add(wrapped);
      return () => {
        set!.delete(wrapped);
      };
    },

    // The WireConfig surface is dispatch + subscribe only. Capability
    // hooks live in `@ggui-ai/gadgets` and own their own lifecycle —
    // they never route through WireConfig.
  };
}
