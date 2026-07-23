/**
 * Per-user-within-app render isolation (Federation B1, Task 6).
 *
 * Tenancy is `appId`; WITHIN an app, a render stamped with a `userId`
 * is visible only to that same userId. Rows without a `userId` (legacy /
 * non-federated single-user) stay visible to a ctx without a `userId`
 * (back-compat). The gate is shared via `isVisibleToCaller` and wired
 * into both `consume` and `get-session` (+ the `render` reuse gate).
 *
 * The store is seeded via `commit({ render, appId, userId })` — exactly
 * the shape the `ggui_render` handler writes after the Task-6 change to
 * stamp `ctx.userId` on every commit — and the real
 * `createGguiGetSessionHandler` is exercised through its tenancy gate.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { ComponentGguiSession, DataContract } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { UiGenerateResult } from '@ggui-ai/mcp-server-core';
import { createGguiGetSessionHandler } from './get-session.js';
import { createGguiRenderHandler } from './render.js';
import { handshakeRecordKey, type HandshakeRecord } from './handshake.js';
import { GguiSessionNotFoundError } from './errors.js';
import { isHandlerFailure, type HandlerContext } from '../types.js';

const NOW_MS = Date.parse('2026-06-14T00:00:00.000Z');

function ctx(appId: string, userId?: string): HandlerContext {
  return {
    appId,
    requestId: 'r1',
    ...(userId !== undefined ? { userId } : {}),
  };
}

/**
 * Seed a render via `commit` — mirrors the `ggui_render` write path,
 * which now stamps `ctx.userId` on every commit. A `userId` of
 * `undefined` reproduces a legacy / single-user row.
 */
async function seedRender(
  store: InMemoryGguiSessionStore,
  opts: { sessionId?: string; appId?: string; userId?: string } = {},
): Promise<{ sessionId: string }> {
  const sessionId = opts.sessionId ?? 'render-1';
  const appId = opts.appId ?? 'app1';
  const render: ComponentGguiSession = {
    id: sessionId,
    appId,
    type: 'component',
    componentCode: 'export default () => null;',
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({
    render,
    appId,
    ...(opts.userId !== undefined ? { userId: opts.userId } : {}),
  });
  return { sessionId };
}

describe('per-user-within-app isolation', () => {
  let store: InMemoryGguiSessionStore;

  beforeEach(() => {
    store = new InMemoryGguiSessionStore();
  });

  it('user B cannot get user A’s render in the same app', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    await expect(
      get.handler({ sessionId }, ctx('app1', 'guuey:userB')),
    ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
  });

  it('the owner can read their own render', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    const out = await get.handler({ sessionId }, ctx('app1', 'guuey:userA'));
    expect(out).toBeDefined();
    expect(out.id).toBe(sessionId);
  });

  it('userId-less ctx still reads userId-less rows (back-compat)', async () => {
    const { sessionId } = await seedRender(store, { appId: 'app1' });
    const get = createGguiGetSessionHandler({ renderStore: store });
    const out = await get.handler({ sessionId }, ctx('app1'));
    expect(out).toBeDefined();
    expect(out.id).toBe(sessionId);
  });

  it('cross-app access stays denied regardless of userId', async () => {
    const { sessionId } = await seedRender(store, {
      appId: 'app1',
      userId: 'guuey:userA',
    });
    const get = createGguiGetSessionHandler({ renderStore: store });
    await expect(
      get.handler({ sessionId }, ctx('app-OTHER', 'guuey:userA')),
    ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
  });
});

/**
 * Per-user isolation must hold on the GENERATION-FAILED commit path too,
 * not only the happy commit path. The error-render the handler writes
 * when generation returns `{ ok: false }` must stamp `ctx.userId` (Step
 * 3a: EVERY commit site stamps it) — otherwise a user-B caller in the
 * same app could read user-A's failed render through the back-compat arm
 * of `isVisibleToCaller` (a `userId`-less row stays visible to anyone).
 *
 * These exercise the REAL `createGguiRenderHandler` through its real
 * `runGenerationIntoGguiSession` → `commitErrorGguiSession` path (driven
 * by a `generator` seam that returns `{ ok: false }`) against the real
 * `InMemoryGguiSessionStore`, then read back through the real
 * `createGguiGetSessionHandler` tenancy gate — so a missing `userId`
 * stamp on the error commit is observable as a leak.
 */
const FAIL_CONTRACT: DataContract = { propsSpec: { properties: {} } };

/**
 * `generator` seam returning a generation failure. Hits the
 * `generation-failed` `commitErrorGguiSession` site in
 * `runGenerationIntoGguiSession` — the commit whose `userId` stamp this
 * suite guards.
 */
const failingGenerator = async (): Promise<UiGenerateResult> => ({
  ok: false,
  error: { code: 'PRODUCTION_FAILED', message: 'forced generation failure' },
});

/** Seed an `origin: 'agent'` create handshake the render call consumes. */
async function seedAgentHandshake(
  store: InMemoryKeyValueStore,
  appId: string,
  handshakeId: string,
): Promise<void> {
  const record: HandshakeRecord = {
    handshakeId,
    action: 'create',
    reason: 'test',
    input: {
      intent: 'a failing card',
      blueprintDraft: { contract: FAIL_CONTRACT },
    },
    target: {},
    suggestion: {
      origin: 'agent',
      rationale: 'test',
      blueprintMeta: { contractHash: blueprintKey(FAIL_CONTRACT), variance: {} },
    },
    effectiveContract: FAIL_CONTRACT,
    appId,
    createdAt: new Date().toISOString(),
  };
  await store.set(handshakeRecordKey(appId, handshakeId), JSON.stringify(record));
}

/**
 * Drive the real render handler through the generation-failed commit for
 * `(appId, userId)` and return the minted error render's sessionId.
 */
async function renderFailingFor(
  renderStore: InMemoryGguiSessionStore,
  appId: string,
  userId: string,
): Promise<{ sessionId: string }> {
  const handshakeStore = new InMemoryKeyValueStore();
  const handshakeId = `hs-${userId}`;
  await seedAgentHandshake(handshakeStore, appId, handshakeId);
  const handler = createGguiRenderHandler({
    handshakeStore,
    renderStore,
    generation: {
      uiGenerator: {
        slug: 'ui-gen-default-fake',
        tier: 'default',
        model: 'fake',
        generate: failingGenerator,
      },
      resolveLlm: () => null,
      blueprints: { get: async () => null, list: async () => [] },
    },
    generator: failingGenerator,
  });
  const out = await handler.handler(
    { handshakeId, props: {} },
    ctx(appId, userId),
  );
  // A failing generator settles as the in-result failure envelope —
  // the committed error render's id rides on the envelope's `data`
  // (the session channel keeps its archaeology).
  if (!isHandlerFailure(out)) {
    throw new Error('expected the failing generator to produce a failure envelope');
  }
  return { sessionId: out.data.sessionId };
}

describe('per-user isolation on the generation-failed error-render commit', () => {
  let store: InMemoryGguiSessionStore;

  beforeEach(() => {
    store = new InMemoryGguiSessionStore();
  });

  it('error render committed for user A is NOT readable by user B in the same app', async () => {
    const { sessionId } = await renderFailingFor(store, 'app1', 'guuey:userA');
    // Sanity: the error render really was committed.
    const stored = await store.get(sessionId);
    expect((stored?.render as ComponentGguiSession | undefined)?.error).toBe(
      'forced generation failure',
    );
    const get = createGguiGetSessionHandler({ renderStore: store });
    await expect(
      get.handler({ sessionId }, ctx('app1', 'guuey:userB')),
    ).rejects.toBeInstanceOf(GguiSessionNotFoundError);
  });

  it('the owner can still read their own failed render', async () => {
    const { sessionId } = await renderFailingFor(store, 'app1', 'guuey:userA');
    const get = createGguiGetSessionHandler({ renderStore: store });
    const out = await get.handler({ sessionId }, ctx('app1', 'guuey:userA'));
    expect(out.id).toBe(sessionId);
  });
});
