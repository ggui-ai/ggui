import { describe, expect, it } from 'vitest';
import { authAdapterContract } from '../contract-tests/auth-adapter.js';
import { InMemoryAuthAdapter } from './auth-adapter.js';

authAdapterContract('InMemoryAuthAdapter', () => new InMemoryAuthAdapter(), {
  seed: (adapter, token, result) => {
    (adapter as InMemoryAuthAdapter).registerToken(token, result);
  },
});

describe('InMemoryAuthAdapter — impl-specific', () => {
  it('devAllowAll accepts any non-empty token', async () => {
    const adapter = new InMemoryAuthAdapter({ devAllowAll: true });
    const result = await adapter.authenticate('whatever');
    expect(result?.identity.kind).toBe('builder');
    expect(result?.source).toBe('dev');
    // Empty still rejected.
    await expect(adapter.authenticate('')).resolves.toBeNull();
  });

  it('seedTokens pre-registers tokens', async () => {
    const adapter = new InMemoryAuthAdapter({
      seedTokens: [
        {
          token: 'seed-1',
          result: { identity: { kind: 'builder' }, source: 'apikey' },
        },
      ],
    });
    const result = await adapter.authenticate('seed-1');
    expect(result?.source).toBe('apikey');
  });

  it('unregisterToken revokes access', async () => {
    const adapter = new InMemoryAuthAdapter();
    adapter.registerToken('tok-1', { identity: { kind: 'builder' }, source: 'pairing' });
    await expect(adapter.authenticate('tok-1')).resolves.not.toBeNull();
    adapter.unregisterToken('tok-1');
    await expect(adapter.authenticate('tok-1')).resolves.toBeNull();
  });

  it('registered result is cloned on read — caller mutation does not poison the store', async () => {
    const adapter = new InMemoryAuthAdapter();
    adapter.registerToken('tok-1', {
      identity: { kind: 'builder' },
      source: 'dev',
      metadata: { deviceName: 'iPhone' },
    });
    const first = await adapter.authenticate('tok-1');
    if (first?.metadata) first.metadata['deviceName'] = 'mutated';
    const second = await adapter.authenticate('tok-1');
    expect(second?.metadata?.['deviceName']).toBe('iPhone');
  });
});
