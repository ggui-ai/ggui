/**
 * ggui#1223 — a `oneShot` action's spent state, as data.
 *
 * THE OBSERVABLE VIOLATION (guuey#1331's staging read): after a reload the
 * guard stops the second dispatch, but the card still PAINTS its control live
 * until the refused press, because nothing told the component the action was
 * spent. `buildWireConfig` now exposes the guard's own set as a source
 * (`actionSpent`). These pins hold the source and the guard to ONE answer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActionSpec } from '@ggui-ai/protocol/wire';
import { buildWireConfig, StreamBus, type BuildWireConfigOptions } from '../wire-config';

const SPEC: ActionSpec = {
  confirm: { label: 'Confirm', oneShot: true },
  log: { label: 'Log' },
};

function harness(opts: { record?: readonly string[]; valid?: boolean } = {}) {
  const emitted: unknown[] = [];
  const base: BuildWireConfigOptions = {
    app: { appId: 'a', appName: 'a' },
    render: { sessionId: 's1', isConnected: true },
    auth: { isAuthenticated: false },
    getActiveActionSpec: () => SPEC,
    ...(opts.record !== undefined ? { getSpentOneShots: () => opts.record } : {}),
    validateEnvelope: () =>
      opts.valid === false
        ? { valid: false, violations: [{ field: 'data', message: 'rejected on purpose' }] }
        : { valid: true, violations: [] },
    onViolation: () => undefined,
    emitEnvelope: (env) => {
      emitted.push(env.payload ?? null);
    },
    streamBus: new StreamBus(),
  };
  return { config: buildWireConfig(base), emitted };
}

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('actionSpent — the guard’s set, as data (ggui#1223)', () => {
  it('a persisted record spends a oneShot action BEFORE any gesture, and the guard agrees on the first press', () => {
    const { config, emitted } = harness({ record: ['confirm'] });
    expect(config.actionSpent.isSpent('confirm')).toBe(true);
    config.dispatch('confirm', {});
    expect(emitted).toHaveLength(0);
  });

  it('an action NOT declared oneShot is never spent, even when its name is in the record', () => {
    const { config, emitted } = harness({ record: ['log'] });
    expect(config.actionSpent.isSpent('log')).toBe(false);
    config.dispatch('log', {});
    expect(emitted).toHaveLength(1);
  });

  it('flips on this card’s own committed dispatch, and notifies each subscriber once', () => {
    const { config } = harness();
    const heard = vi.fn();
    config.actionSpent.subscribe(heard);
    expect(config.actionSpent.isSpent('confirm')).toBe(false);
    config.dispatch('confirm', { ok: true });
    expect(config.actionSpent.isSpent('confirm')).toBe(true);
    expect(heard).toHaveBeenCalledTimes(1);
    config.dispatch('confirm', { ok: true }); // suppressed repeat: no second notice
    expect(heard).toHaveBeenCalledTimes(1);
  });

  it('a rejected envelope never spends and never notifies, so a corrected retry still fires', () => {
    const { config, emitted } = harness({ valid: false });
    const heard = vi.fn();
    config.actionSpent.subscribe(heard);
    config.dispatch('confirm', { bad: true });
    expect(emitted).toHaveLength(0);
    expect(config.actionSpent.isSpent('confirm')).toBe(false);
    expect(heard).not.toHaveBeenCalled();
  });

  it('a repeating action never notifies; an unsubscribed listener hears nothing', () => {
    const { config } = harness();
    const heard = vi.fn();
    const off = config.actionSpent.subscribe(heard);
    config.dispatch('log', {});
    expect(heard).not.toHaveBeenCalled();
    off();
    config.dispatch('confirm', {});
    expect(heard).not.toHaveBeenCalled();
    expect(config.actionSpent.isSpent('confirm')).toBe(true);
  });
});
