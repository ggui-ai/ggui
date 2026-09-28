/**
 * ggui#1485 — the cross-app class contract for every handler whose input
 * carries a `sessionId`, enumerated from the registry `defaultHandlers`
 * builds (with every optional dependency bound, so no registration branch
 * is skipped), never from a hand list.
 *
 * For each such handler, a session committed under app B is called by app
 * A, declaring B's app where the input carries one (the forged case) and
 * then its own. The call must answer exactly as a session that does not
 * exist: the same bytes (a thrown error's name, code and message, or the
 * returned value) as the same id string on a store that never held it, with
 * a pending pipe open for that id so the missing answer comes from the gate
 * and not from an absent pipe. Nothing may change B's row, its events or
 * its pending pipe, which holds one queued gesture throughout, so a drain
 * shows as well as an append.
 *
 * The owner's own call is the control. It must return, without throwing and
 * without `ok: false`, which shows the arguments get past the schema and
 * the app gate and the handler takes its path on the row; the card declares
 * the stream channel, context slot and props those paths need. So the
 * identical foreign/missing pair cannot be two identical validation errors.
 *
 * A handler that gains a `sessionId` input fails the suite until it is
 * classified below, and a classified name the registry no longer has fails
 * it too. The consume half the store cannot show (a refused consume must
 * not enter the active-consumer registry, whose instance this factory keeps
 * private) is pinned in `consume.test.ts`, where the registry is the test's
 * own.
 *
 * Surfaces that act on a session id OUTSIDE this enumeration, each gated by
 * its own tests, include: the render-locator `resources/read`; the
 * `/api/sessions/:id/*` reads; the live-channel subscribe (ggui#1480); the
 * console session routes; the refresh tool, which takes an envelope
 * (ggui#1496); and `ggui_render`, whose session id arrives through the
 * handshake record, not its input (ggui#1484).
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryAppMetadataStore,
  InMemoryGguiSessionStore,
  InMemoryKeyValueStore,
  InMemoryPendingEventConsumer,
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { StoredGguiSession } from '@ggui-ai/mcp-server-core';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import type { HandlerContext } from '@ggui-ai/mcp-server-handlers';
import { InMemoryToolIdentityCatalogStore } from '@ggui-ai/mcp-server-handlers/renders';
import type { UiRegistry } from '@ggui-ai/ui-registry';
import { defaultHandlers } from './server.js';

const APP_A = 'app-cross-a';
const APP_B = 'app-cross-b';

type Input = (sessionId: string, declaredAppId: string) => Record<string, unknown>;

/**
 * Every registered handler with a `sessionId` input, and an input whose
 * owner call takes the handler's path on the row. `not-found`: the foreign
 * answer is the missing one, and names the id. `blind`: the handler never
 * reads the store, so every caller gets the same answer, the owner too.
 */
const CLASSIFIED: Record<string, { readonly kind: 'not-found' | 'blind'; readonly input: Input }> = {
  ggui_amend: { kind: 'not-found', input: (sessionId) => ({ sessionId, kind: 'replace', props: { title: 'b' } }) },
  ggui_update: { kind: 'not-found', input: (sessionId) => ({ sessionId, kind: 'replace', props: { title: 'b' } }) },
  ggui_consume: { kind: 'not-found', input: (sessionId) => ({ sessionId, timeout: 0 }) },
  ggui_emit: { kind: 'not-found', input: (sessionId) => ({ sessionId, channel: 'feed', payload: { n: 1 } }) },
  ggui_get_render_source: { kind: 'not-found', input: (sessionId) => ({ sessionId }) },
  ggui_get_session: { kind: 'not-found', input: (sessionId) => ({ sessionId }) },
  ggui_runtime_pull: { kind: 'not-found', input: (sessionId) => ({ sessionId }) },
  ggui_runtime_submit_action: {
    kind: 'not-found',
    input: (sessionId, declaredAppId) => ({
      sessionId,
      appId: declaredAppId,
      kind: 'dispatch',
      payload: { intent: 'submit', actionData: { title: 'x' }, uiContext: { draft: 'y' } },
      actionId: 'act-cross-1',
      firedAt: '2026-09-28T00:00:00.000Z',
    }),
  },
  ggui_runtime_sync_context: {
    kind: 'not-found',
    input: (sessionId, declaredAppId) => ({ sessionId, appId: declaredAppId, snapshot: { slot: 'x' } }),
  },
  // Fire-and-forget transport diagnostics: logs and answers {ok: true},
  // reads and stores nothing, so it has no row to protect and no existence
  // to leak (its handler pins the deps shape to a logger alone).
  ggui_runtime_telemetry: {
    kind: 'blind',
    input: (sessionId) => ({ sessionId, events: [{ at: 10, kind: 'boot.path' }] }),
  },
};

function card(id: string, appId: string): ComponentGguiSession {
  const now = Date.now();
  return {
    type: 'component',
    id,
    appId,
    componentCode: 'export default function Card(){return null}',
    props: { title: 'a' },
    contextSpec: { slot: { schema: { type: 'string' }, default: '' } },
    streamSpec: {
      feed: { mode: 'replace', schema: { type: 'object', properties: { n: { type: 'number' } } } },
    },
    eventSequence: 0,
    createdAt: now,
    lastActivityAt: now,
    expiresAt: now + 3_600_000,
  };
}

function build(renderStore: InMemoryGguiSessionStore, pendingEventConsumer: InMemoryPendingEventConsumer) {
  return defaultHandlers({
    embedding: new MockEmbeddingProvider(),
    vectors: new InMemoryVectorStore(),
    render: { renderStore },
    update: { renderStore },
    consume: { pendingEventConsumer },
  });
}

const emptyUiRegistry: UiRegistry = {
  list: async () => [],
  get: async () => undefined,
  getBundle: async () => undefined,
  capabilities: { observable: false },
};

/** Every optional dependency bound, so every registration branch runs. */
function buildEverything() {
  const renderStore = new InMemoryGguiSessionStore();
  return defaultHandlers({
    embedding: new MockEmbeddingProvider(),
    vectors: new InMemoryVectorStore(),
    toolIdentityCatalogStore: new InMemoryToolIdentityCatalogStore(),
    uiRegistry: emptyUiRegistry,
    handshake: { kvStore: new InMemoryKeyValueStore() },
    render: {
      renderStore,
      wsTokenVerify: () => ({ ok: false }),
      mintBootstrap: () => ({ wsUrl: 'ws://x/ws', token: 't', expiresAt: '2100-01-01T00:00:00.000Z' }),
    },
    update: { renderStore },
    consume: { pendingEventConsumer: new InMemoryPendingEventConsumer() },
    appMetadataStore: new InMemoryAppMetadataStore(),
    themes: () => [],
  });
}

const ctxOf = (appId: string): HandlerContext => ({ appId, requestId: `req-${appId}` });

/** One answer, as bytes: a thrown error's identity, or the returned value. */
async function answerOf(run: () => Promise<unknown>): Promise<string> {
  try {
    return JSON.stringify({ returned: await run() });
  } catch (err) {
    if (!(err instanceof Error)) return JSON.stringify({ threw: String(err) });
    const code = 'code' in err ? err.code : undefined;
    return JSON.stringify({ threw: { name: err.name, code, message: err.message } });
  }
}

async function seededWorld() {
  const renderStore = new InMemoryGguiSessionStore();
  const pendingEventConsumer = new InMemoryPendingEventConsumer();
  const created = await renderStore.create({ appId: APP_B });
  await renderStore.commit({
    appId: APP_B,
    render: card(created.id, APP_B),
    sourceCode: 'export default function Card() { return null; }',
  });
  pendingEventConsumer.markCreated(created.id);
  // One queued gesture: a drain empties it, an append grows it.
  await pendingEventConsumer.append(created.id, {
    id: 'evt-owner-1',
    envelope: {
      type: 'action',
      sessionId: created.id,
      intent: 'submit',
      actionData: null,
      uiContext: {},
      actionId: 'act-owner-1',
      firedAt: '2026-09-28T00:00:00.000Z',
    },
    createdAt: '2026-09-28T00:00:00.000Z',
  });
  return { renderStore, pendingEventConsumer, sessionId: created.id, handlers: build(renderStore, pendingEventConsumer) };
}

describe('every sessionId handler refuses another app\'s session exactly as a missing one (ggui#1485)', () => {
  it('the registry\'s sessionId handlers, with every optional dependency bound, are all classified', () => {
    const withSessionId = buildEverything()
      .filter((h) => 'sessionId' in h.inputSchema)
      .map((h) => h.name)
      .sort();
    expect(withSessionId.filter((n) => !(n in CLASSIFIED))).toEqual([]);
    // And the table names nothing the registry no longer has.
    expect(Object.keys(CLASSIFIED).filter((n) => !withSessionId.includes(n))).toEqual([]);
  });

  for (const [name, spec] of Object.entries(CLASSIFIED)) {
    for (const declared of [APP_B, APP_A]) {
      it(`${name} (declaring ${declared === APP_B ? 'the owner\'s app: forged' : 'its own app'}): foreign ≡ missing; nothing changes the owner's row, events or pipe; the owner's own call takes its path`, async () => {
        const world = await seededWorld();
        const handler = world.handlers.find((h) => h.name === name);
        expect(handler, `${name} is registered`).toBeDefined();
        if (!handler) return;
        const before = {
          row: JSON.stringify(await world.renderStore.get(world.sessionId)),
          events: JSON.stringify(await world.renderStore.listEventsSince(world.sessionId, 0, 500)),
        };

        // Another app names B's session.
        const foreign = await answerOf(() =>
          handler.handler(spec.input(world.sessionId, declared), ctxOf(APP_A)),
        );
        // The same id string on a store that never held it, with a pipe open for it.
        const emptyConsumer = new InMemoryPendingEventConsumer();
        emptyConsumer.markCreated(world.sessionId);
        const emptyHandler = build(new InMemoryGguiSessionStore(), emptyConsumer).find((h) => h.name === name);
        expect(emptyHandler, `${name} is registered on the empty store`).toBeDefined();
        if (!emptyHandler) return;
        const missing = await answerOf(() =>
          emptyHandler.handler(spec.input(world.sessionId, declared), ctxOf(APP_A)),
        );

        expect(foreign).toBe(missing);
        if (spec.kind === 'not-found') {
          // The missing answer is the not-found answer, naming the id.
          expect(missing).toContain(world.sessionId);
        }

        // Nothing reached B's row, its events or its pending pipe.
        expect(JSON.stringify(await world.renderStore.get(world.sessionId))).toBe(before.row);
        expect(JSON.stringify(await world.renderStore.listEventsSince(world.sessionId, 0, 500))).toBe(before.events);
        expect(world.pendingEventConsumer.pendingCount(world.sessionId)).toBe(1);

        // Control: the owner's own call takes its path on the row.
        const owner = await answerOf(() =>
          handler.handler(spec.input(world.sessionId, APP_B), ctxOf(APP_B)),
        );
        expect(owner).not.toContain('"threw"');
        expect(owner).not.toContain('"ok":false');
        if (spec.kind === 'not-found') {
          expect(owner).not.toBe(missing);
        } else {
          expect(owner).toBe(missing);
        }
      });
    }
  }
});

/**
 * ggui#1514 — a render store whose read THROWS. The two runtime write tools,
 * which a view-origin refusal hands a failed read (ggui#1415, Enforcement b),
 * answer it byte-identically to a store that never held the id, and write
 * nothing. Every other `not-found` handler is pinned as it answers today, so
 * a change in how any of them meets a failed read is a decision, not drift.
 */
const FAILED_READ: Record<string, 'as-missing' | 'throws'> = {
  ggui_runtime_submit_action: 'as-missing',
  ggui_runtime_sync_context: 'as-missing',
  ggui_amend: 'throws',
  ggui_update: 'throws',
  ggui_consume: 'throws',
  ggui_emit: 'throws',
  ggui_get_render_source: 'throws',
  ggui_get_session: 'throws',
  ggui_runtime_pull: 'throws',
};

class ReadFailingStore extends InMemoryGguiSessionStore {
  override async get(): Promise<StoredGguiSession | null> {
    throw new Error('render store read failed');
  }
}

describe('a render store whose read throws (ggui#1514)', () => {
  it('every not-found handler is classified for a failed read, and the table names nothing else', () => {
    const notFound = Object.entries(CLASSIFIED)
      .filter(([, spec]) => spec.kind === 'not-found')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(FAILED_READ).sort()).toEqual(notFound);
  });

  for (const [name, expected] of Object.entries(FAILED_READ)) {
    it(`${name}: a failed read ${expected === 'as-missing' ? 'answers exactly as a missing session and writes nothing' : 'throws (pinned as it is today)'}`, async () => {
      const spec = CLASSIFIED[name];
      expect(spec, `${name} is classified`).toBeDefined();
      if (!spec) return;
      const sessionId = 'render_failed_read_1514';

      const failingConsumer = new InMemoryPendingEventConsumer();
      failingConsumer.markCreated(sessionId);
      const failing = build(new ReadFailingStore(), failingConsumer).find((h) => h.name === name);
      expect(failing, `${name} is registered on the failing store`).toBeDefined();
      if (!failing) return;
      const failed = await answerOf(() => failing.handler(spec.input(sessionId, APP_A), ctxOf(APP_A)));

      const emptyConsumer = new InMemoryPendingEventConsumer();
      emptyConsumer.markCreated(sessionId);
      const empty = build(new InMemoryGguiSessionStore(), emptyConsumer).find((h) => h.name === name);
      expect(empty, `${name} is registered on the empty store`).toBeDefined();
      if (!empty) return;
      const missing = await answerOf(() => empty.handler(spec.input(sessionId, APP_A), ctxOf(APP_A)));

      if (expected === 'as-missing') {
        expect(failed).toBe(missing);
        expect(failingConsumer.pendingCount(sessionId)).toBe(0);
      } else {
        expect(failed).toContain('"threw"');
        expect(failed).not.toBe(missing);
      }
    });
  }
});
