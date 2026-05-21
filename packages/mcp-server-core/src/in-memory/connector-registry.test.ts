/**
 * InMemoryConnectorRegistry reference-adapter tests.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryConnectorRegistry } from './connector-registry';

describe('InMemoryConnectorRegistry', () => {
  it('returns null for unknown ids', async () => {
    const r = new InMemoryConnectorRegistry();
    expect(await r.get('missing')).toBeNull();
  });

  it('returns the registered connector for a known id', async () => {
    const r = new InMemoryConnectorRegistry([
      { id: 'stripe', serverUrl: 'https://mcp.stripe.example' },
    ]);
    const c = await r.get('stripe');
    expect(c?.serverUrl).toBe('https://mcp.stripe.example');
  });

  it('list returns all seeded connectors', async () => {
    const r = new InMemoryConnectorRegistry([
      { id: 'stripe', serverUrl: 'https://a' },
      { id: 'calendly', serverUrl: 'https://b' },
    ]);
    const all = await r.list();
    expect(all.map((c) => c.id).sort()).toEqual(['calendly', 'stripe']);
  });

  it('rejects duplicate ids at construction', () => {
    expect(
      () =>
        new InMemoryConnectorRegistry([
          { id: 'stripe', serverUrl: 'https://a' },
          { id: 'stripe', serverUrl: 'https://b' },
        ]),
    ).toThrow(/duplicate connector id/);
  });
});
