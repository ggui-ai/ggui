/**
 * ggui#1223 / #1305 — the ONE decision both ingress paths use before a
 * `oneShot` dispatch is recorded as spent on its card.
 */
import { describe, expect, it } from 'vitest';
import type { ComponentGguiSession, GguiSession } from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { recordCommittedOneShot } from './record-committed-one-shot.js';

function card(overrides: Partial<ComponentGguiSession> = {}): ComponentGguiSession {
  return {
    type: 'component',
    id: 'r-1',
    appId: 'app-1',
    componentCode: '/* card */',
    eventSequence: 0,
    createdAt: 0,
    lastActivityAt: 0,
    expiresAt: 0,
    actionSpec: {
      submit: {
        label: 'Submit the form',
        oneShot: true,
        schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      },
      refresh: { label: 'Refresh' },
    },
    ...overrides,
  };
}

async function storeWith(render: GguiSession): Promise<InMemoryGguiSessionStore> {
  const store = new InMemoryGguiSessionStore();
  await store.commit({ appId: 'app-1', render });
  return store;
}

/** The port's required methods only, delegating to `inner`: a store that never implemented the optional one. */
function requiredMethodsOf(inner: GguiSessionStore): GguiSessionStore {
  return {
    create: (i) => inner.create(i),
    get: (id) => inner.get(id),
    list: (f) => inner.list(f),
    update: (id, p) => inner.update(id, p),
    delete: (id) => inner.delete(id),
    commit: (i) => inner.commit(i),
    appendEvent: (i) => inner.appendEvent(i),
    listEventsSince: (id, s, l) => inner.listEventsSince(id, s, l),
    observe: (id, o) => inner.observe(id, o),
  };
}

async function spentOf(store: GguiSessionStore): Promise<ComponentGguiSession['spentOneShots']> {
  const got = await store.get('r-1');
  return got?.render.type === 'component' ? got.render.spentOneShots : undefined;
}

describe('recordCommittedOneShot', () => {
  it('records a contract-valid dispatch of a oneShot action under the head card', async () => {
    const render = card({ epoch: 2 });
    const store = await storeWith(render);
    const outcome = await recordCommittedOneShot({
      store,
      sessionId: 'r-1',
      render,
      action: 'submit',
      data: { name: 'Ada' },
    });
    expect(outcome).toBe('recorded');
    expect(await spentOf(store)).toEqual({ epoch: 2, actions: ['submit'] });
  });

  it('an action the card does not declare oneShot is never recorded', async () => {
    const render = card();
    const store = await storeWith(render);
    expect(
      await recordCommittedOneShot({ store, sessionId: 'r-1', render, action: 'refresh', data: null }),
    ).toBe('not-one-shot');
    expect(await spentOf(store)).toBeUndefined();
  });

  it('a dispatch that fails the card contract is not committed, so it never spends', async () => {
    const render = card();
    const store = await storeWith(render);
    expect(
      await recordCommittedOneShot({ store, sessionId: 'r-1', render, action: 'submit', data: { name: 42 } }),
    ).toBe('not-committed');
    expect(await spentOf(store)).toBeUndefined();
  });

  it("a dispatch from a card that is no longer the head never spends the head card's action", async () => {
    const render = card({ epoch: 3 });
    const store = await storeWith(render);
    expect(
      await recordCommittedOneShot({
        store,
        sessionId: 'r-1',
        render,
        action: 'submit',
        data: { name: 'Ada' },
        cardEpoch: 2,
      }),
    ).toBe('superseded-card');
    expect(await spentOf(store)).toBeUndefined();
  });

  it("a dispatch naming the head card's epoch records under it", async () => {
    const render = card({ epoch: 3 });
    const store = await storeWith(render);
    expect(
      await recordCommittedOneShot({
        store,
        sessionId: 'r-1',
        render,
        action: 'submit',
        data: { name: 'Ada' },
        cardEpoch: 3,
      }),
    ).toBe('recorded');
    expect(await spentOf(store)).toEqual({ epoch: 3, actions: ['submit'] });
  });

  it('a card with no epoch is epoch 0', async () => {
    const render = card();
    const store = await storeWith(render);
    await recordCommittedOneShot({ store, sessionId: 'r-1', render, action: 'submit', data: { name: 'Ada' } });
    expect(await spentOf(store)).toEqual({ epoch: 0, actions: ['submit'] });
  });

  it('a store without recordSpentOneShot is reported as not durable, not as recorded', async () => {
    const render = card();
    const withoutMethod = requiredMethodsOf(await storeWith(render));
    expect(
      await recordCommittedOneShot({
        store: withoutMethod,
        sessionId: 'r-1',
        render,
        action: 'submit',
        data: { name: 'Ada' },
      }),
    ).toBe('not-durable');
  });

  it('a render that is not a component card has no oneShot actions to spend', async () => {
    const render: GguiSession = {
      type: 'system',
      id: 'r-1',
      appId: 'app-1',
      kind: 'no-credentials',
      eventSequence: 0,
      createdAt: 0,
      lastActivityAt: 0,
      expiresAt: 0,
    };
    const store = await storeWith(render);
    expect(
      await recordCommittedOneShot({ store, sessionId: 'r-1', render, action: 'submit', data: null }),
    ).toBe('not-one-shot');
  });

  it("a store failure propagates to the caller, which owns the fail-open log line", async () => {
    const render = card();
    const store = await storeWith(render);
    const failing: GguiSessionStore = {
      ...requiredMethodsOf(store),
      recordSpentOneShot: async (): Promise<void> => {
        throw new Error('store down');
      },
    };
    await expect(
      recordCommittedOneShot({ store: failing, sessionId: 'r-1', render, action: 'submit', data: { name: 'Ada' } }),
    ).rejects.toThrow('store down');
  });
});
