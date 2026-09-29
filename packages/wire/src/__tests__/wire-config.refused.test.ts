/**
 * ggui#1536 — a dispatch the outbound contract check refuses is named to the
 * renderer with its action: `onDispatchRefused` receives the action's name and
 * the violations, beside `onViolation`, so a renderer can tell its host and its
 * visitor which tap did nothing. Nothing is emitted either way.
 */
import { describe, expect, it } from 'vitest';
import type { ActionSpec, JsonValue } from '@ggui-ai/protocol/wire';
import type { ContractViolation } from '@ggui-ai/protocol';
import { buildWireConfig, StreamBus, type BuildWireConfigOptions, type DispatchRefusedInfo } from '../wire-config';

const SPEC: ActionSpec = { submit: { label: 'Submit' } };
const VIOLATION: ContractViolation = { field: 'payload.data.email', message: 'must be string', keyword: 'type' };

function harness(valid: boolean, withRefusedSink = true) {
  const emitted: JsonValue[] = [];
  const order: string[] = [];
  const refused: DispatchRefusedInfo[] = [];
  const opts: BuildWireConfigOptions = {
    app: { appId: 'a', appName: 'a' },
    render: { sessionId: 's1', isConnected: true },
    auth: { isAuthenticated: false },
    getActiveActionSpec: () => SPEC,
    validateEnvelope: () => (valid ? { valid: true, violations: [] } : { valid: false, violations: [VIOLATION] }),
    onViolation: () => order.push('violation'),
    emitEnvelope: (env) => emitted.push(env.payload ?? null),
    streamBus: new StreamBus(),
    ...(withRefusedSink
      ? {
          onDispatchRefused: (info: DispatchRefusedInfo) => {
            order.push('refused');
            refused.push(info);
          },
        }
      : {}),
  };
  return { config: buildWireConfig(opts), emitted, order, refused };
}

describe('onDispatchRefused (ggui#1536)', () => {
  it('a refused envelope names its action and violations, after onViolation, and nothing is emitted', () => {
    const { config, emitted, order, refused } = harness(false);
    config.dispatch('submit', { email: 7 });
    expect(emitted).toEqual([]);
    expect(order).toEqual(['violation', 'refused']);
    expect(refused).toEqual([{ actionName: 'submit', violations: [VIOLATION] }]);
  });

  it('an admitted envelope is emitted and never named refused', () => {
    const { config, emitted, refused } = harness(true);
    config.dispatch('submit', { email: 'a@b.c' });
    expect(emitted).toHaveLength(1);
    expect(refused).toEqual([]);
  });

  it('is optional: without the sink a refusal still reaches onViolation alone', () => {
    const { config, emitted, order } = harness(false, false);
    config.dispatch('submit', { email: 7 });
    expect(emitted).toEqual([]);
    expect(order).toEqual(['violation']);
  });
});
