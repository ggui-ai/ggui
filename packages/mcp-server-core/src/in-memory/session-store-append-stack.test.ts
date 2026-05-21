/**
 * Slice B — targeted coverage for `SessionStore.appendStackItem`.
 *
 * The contract suite in `contract-tests/session-store.ts` is shared
 * across implementations; adding `appendStackItem` there means
 * touching every adapter. This file isolates the new method's behavior
 * against `InMemorySessionStore` only; contract-suite integration
 * lands when the next adapter (SQLite / hosted) implements it.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from './session-store.js';

describe('InMemorySessionStore.appendStackItem', () => {
  async function seed() {
    const store = new InMemorySessionStore();
    await store.create({ id: 'sess-1', appId: 'app-1' });
    return store;
  }

  it('appends to an empty stack and sets currentStackIndex to 0', async () => {
    const store = await seed();
    const result = await store.appendStackItem('sess-1', {
      id: 'p1',
      componentCode: '/* */',
      createdAt: new Date().toISOString(),
    });
    expect(result.stack.length).toBe(1);
    expect(result.stack[0].id).toBe('p1');
    expect(result.currentStackIndex).toBe(0);
  });

  it('appends successive items in FIFO order', async () => {
    const store = await seed();
    await store.appendStackItem('sess-1', {
      id: 'p1',
      componentCode: '/* */',
      createdAt: '2026-04-19T00:00:00Z',
    });
    const after = await store.appendStackItem('sess-1', {
      id: 'p2',
      componentCode: '/* */',
      createdAt: '2026-04-19T00:00:01Z',
    });
    expect(after.stack.map((e) => e.id)).toEqual(['p1', 'p2']);
    expect(after.currentStackIndex).toBe(1);
  });

  it('accepts an McpAppsStackItem variant', async () => {
    const store = await seed();
    const result = await store.appendStackItem('sess-1', {
      type: 'mcpApps',
      id: 'mcp-1',
      createdAt: new Date().toISOString(),
      source: {
        connectorId: 'stripe',
        toolName: 'checkout',
        resourceUri: 'ui://stripe/checkout',
      },
    });
    expect(result.stack.length).toBe(1);
    expect(result.stack[0].type).toBe('mcpApps');
  });

  it('throws for unknown session', async () => {
    const store = new InMemorySessionStore();
    await expect(
      store.appendStackItem('unknown', {
        id: 'p1',
        componentCode: '',
        createdAt: '',
      }),
    ).rejects.toThrow(/session not found/);
  });

  it('upserts by id — replacing an existing entry preserves position + does not duplicate', async () => {
    const store = await seed();
    await store.appendStackItem('sess-1', {
      id: 'p1',
      componentCode: '',
      prompt: 'first attempt',
      createdAt: '2026-04-26T00:00:00Z',
    });
    await store.appendStackItem('sess-1', {
      id: 'p2',
      componentCode: '/* p2 */',
      createdAt: '2026-04-26T00:00:01Z',
    });
    const replaced = await store.appendStackItem('sess-1', {
      id: 'p1',
      componentCode: '/* generated */',
      prompt: 'first attempt',
      createdAt: '2026-04-26T00:00:02Z',
    });
    // Stack stays length 2 — p1 was replaced in place, not appended.
    expect(replaced.stack.length).toBe(2);
    expect(replaced.stack.map((e) => e.id)).toEqual(['p1', 'p2']);
    // p1's componentCode is the new value.
    const p1 = replaced.stack[0];
    if (!p1 || p1.type === 'mcpApps' || p1.type === 'system') throw new Error('expected component item');
    expect(p1.componentCode).toBe('/* generated */');
    // currentStackIndex points at the slot that was mutated (idx 0).
    expect(replaced.currentStackIndex).toBe(0);
  });
});
