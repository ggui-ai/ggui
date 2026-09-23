/**
 * ggui#1108 — the render-lifetime one-shot guard.
 *
 * THE OBSERVABLE VIOLATION (this row's first RED): a SECOND gesture on an action
 * the contract declared `oneShot` that produced neither a suppression trace nor
 * a stopped dispatch — i.e. it reached the agent a second time. The founder's
 * report: a submitted form still reads as a live request and can be submitted
 * again, on prod, where a second submit is a second write.
 *
 * The guard lives in `buildWireConfig`'s `dispatch` because that is the ONE
 * chokepoint that already resolves the active render's `actionSpec` (so it can
 * read the `oneShot` marker) and is built once per render (so a closure-local
 * spent-set is the render's lifetime). NEVER SILENT: a suppressed dispatch
 * emits a `console.warn` naming the action + `oneShot` as the reason and, when a
 * host provided one, the structured `onDispatchSuppressed` sink — and it does
 * NOT reach the transport.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionSpec, JsonValue } from '@ggui-ai/protocol/wire';
import { buildWireConfig, StreamBus, type BuildWireConfigOptions } from '../wire-config';
import type { DispatchSuppressedInfo } from '../context';

const ONE_SHOT_SPEC: ActionSpec = {
  submit: { label: 'Submit', oneShot: true },
  log: { label: 'Log' },
};

function harness(spec: ActionSpec = ONE_SHOT_SPEC) {
  const emitted: JsonValue[] = [];
  const suppressed: DispatchSuppressedInfo[] = [];
  const opts: BuildWireConfigOptions = {
    app: { appId: 'a', appName: 'a' },
    render: { sessionId: 's1', isConnected: true },
    auth: { isAuthenticated: false },
    getActiveActionSpec: () => spec,
    // Accept every envelope — the guard is about repetition, not schema.
    validateEnvelope: () => ({ valid: true, violations: [] }),
    onViolation: () => {
      throw new Error('unexpected violation');
    },
    emitEnvelope: (env) => {
      emitted.push(env.payload ?? null);
    },
    streamBus: new StreamBus(),
    onDispatchSuppressed: (info) => suppressed.push(info),
  };
  return { config: buildWireConfig(opts), emitted, suppressed, opts };
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('one-shot guard (ggui#1108)', () => {
  it('THE RED without the guard would be: submit twice → two emits, no trace. With it: first fires, second is stopped AND traced', () => {
    const { config, emitted, suppressed } = harness();
    config.dispatch('submit', { ok: true });
    config.dispatch('submit', { ok: true });
    // exactly one reaches the agent
    expect(emitted).toEqual([{ action: 'submit', data: { ok: true } }]);
    // the second gesture left a named suppression trace, not silence
    expect(suppressed).toHaveLength(1);
    expect(suppressed[0]).toMatchObject({ reason: 'one-shot-spent', actionName: 'submit' });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('oneShot');
    expect(String(warn.mock.calls[0]![0])).toContain("dispatch('submit')");
  });

  it('suppresses regardless of payload — a one-shot is spent, not a (name,payload) dedup', () => {
    const { config, emitted, suppressed } = harness();
    config.dispatch('submit', { a: 1 });
    config.dispatch('submit', { a: 2 }); // different payload, still the same spent action
    expect(emitted).toEqual([{ action: 'submit', data: { a: 1 } }]);
    expect(suppressed.map((s) => s.reason)).toEqual(['one-shot-spent']);
  });

  it('an action NOT declared oneShot fires every time — the guard reads the marker, never a name', () => {
    const { config, emitted, suppressed } = harness();
    config.dispatch('log', { n: 1 });
    config.dispatch('log', { n: 2 });
    config.dispatch('log', { n: 3 });
    expect(emitted).toHaveLength(3);
    expect(suppressed).toHaveLength(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('a one-shot spends only on a COMMITTED fire: a rejected first dispatch does not spend it, so a corrected retry still fires', () => {
    const emitted: JsonValue[] = [];
    let valid = false;
    const config = buildWireConfig({
      app: { appId: 'a', appName: 'a' },
      render: { sessionId: 's1', isConnected: true },
      auth: { isAuthenticated: false },
      getActiveActionSpec: () => ONE_SHOT_SPEC,
      validateEnvelope: () => ({ valid, violations: valid ? [] : [{ field: 'data', message: 'bad' }] }),
      onViolation: () => {},
      emitEnvelope: (env) => emitted.push(env.payload ?? null),
      streamBus: new StreamBus(),
    });
    config.dispatch('submit', { bad: true }); // rejected — not spent
    valid = true;
    config.dispatch('submit', { good: true }); // fires
    config.dispatch('submit', { again: true }); // NOW spent → suppressed
    expect(emitted).toEqual([{ action: 'submit', data: { good: true } }]);
  });

  it("render lifetime: two configs (a new card is a new iframe) each arm their own one-shot — the second config's submit is NOT spent by the first", () => {
    const a = harness();
    const b = harness();
    a.config.dispatch('submit', {});
    a.config.dispatch('submit', {}); // suppressed on config A
    b.config.dispatch('submit', {}); // config B is a fresh render → fires
    expect(a.emitted).toHaveLength(1);
    expect(b.emitted).toHaveLength(1);
  });

  it('no host sink: suppression is still NEVER SILENT via console.warn, and the dispatch is still stopped', () => {
    const emitted: JsonValue[] = [];
    const config = buildWireConfig({
      app: { appId: 'a', appName: 'a' },
      render: { sessionId: 's1', isConnected: true },
      auth: { isAuthenticated: false },
      getActiveActionSpec: () => ONE_SHOT_SPEC,
      validateEnvelope: () => ({ valid: true, violations: [] }),
      onViolation: () => {},
      emitEnvelope: (env) => emitted.push(env.payload ?? null),
      streamBus: new StreamBus(),
      // no onDispatchSuppressed
    });
    config.dispatch('submit', {});
    config.dispatch('submit', {});
    expect(emitted).toHaveLength(1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('a config with no actionSpec (no render) never suppresses — one-shot cannot apply', () => {
    const emitted: JsonValue[] = [];
    const suppressed: DispatchSuppressedInfo[] = [];
    const config = buildWireConfig({
      app: { appId: 'a', appName: 'a' },
      render: { sessionId: 's1', isConnected: true },
      auth: { isAuthenticated: false },
      getActiveActionSpec: () => undefined, // no render mounted
      validateEnvelope: () => ({ valid: true, violations: [] }),
      onViolation: () => {},
      emitEnvelope: (env) => emitted.push(env.payload ?? null),
      streamBus: new StreamBus(),
      onDispatchSuppressed: (info) => suppressed.push(info),
    });
    config.dispatch('submit', {});
    config.dispatch('submit', {});
    expect(emitted).toHaveLength(2);
    expect(suppressed).toHaveLength(0);
  });
});

// ggui#1178 — a dispatch that resolved NO action spec cannot tell whether the
// action is `oneShot`, so the guard above cannot enforce one. The dispatch still
// proceeds (a missing spec is permissive, as it always was); wire reports each
// such dispatch through `onActionSpecAbsent` so the HOST can name the
// unenforceable state — whether a render should have carried a spec is the
// host's knowledge, not wire's.
describe('a dispatch that resolves no action spec (ggui#1178)', () => {
  function specless(onActionSpecAbsent?: (actionName: string) => void) {
    const emitted: JsonValue[] = [];
    const opts: BuildWireConfigOptions = {
      app: { appId: 'a', appName: 'a' },
      render: { sessionId: 's1', isConnected: true },
      auth: { isAuthenticated: false },
      getActiveActionSpec: () => undefined,
      validateEnvelope: () => ({ valid: true, violations: [] }),
      onViolation: () => {
        throw new Error('unexpected violation');
      },
      emitEnvelope: (env) => {
        emitted.push(env.payload ?? null);
      },
      streamBus: new StreamBus(),
      ...(onActionSpecAbsent !== undefined ? { onActionSpecAbsent } : {}),
    };
    return { config: buildWireConfig(opts), emitted };
  }

  it('reports every spec-less dispatch to onActionSpecAbsent with the action name, and every one still proceeds', () => {
    const absent: string[] = [];
    const { config, emitted } = specless((name) => absent.push(name));
    config.dispatch('submit', { ok: true });
    config.dispatch('submit', { ok: true });
    expect(emitted).toEqual([
      { action: 'submit', data: { ok: true } },
      { action: 'submit', data: { ok: true } },
    ]);
    expect(absent).toEqual(['submit', 'submit']);
  });

  it('a dispatch that resolved a spec never calls onActionSpecAbsent', () => {
    const absent: string[] = [];
    const { config } = harness();
    const withHook = buildWireConfig({ ...harness().opts, onActionSpecAbsent: (name) => absent.push(name) });
    config.dispatch('log', {});
    withHook.dispatch('log', {});
    expect(absent).toEqual([]);
  });
});
