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
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Logger } from './logger.js';
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
  // ggui#1609: without a VALID view proof (this harness presents none) a
  // report records nothing and reads no row, so every caller gets
  // {ok: true}. With one, a foreign session answers exactly as a missing
  // one and records nothing: that path needs a verdict on ctx, and is
  // pinned in report-render-failure.test.ts.
  ggui_runtime_report_render_failure: {
    kind: 'blind',
    input: (sessionId, declaredAppId) => ({ sessionId, appId: declaredAppId, phase: 'mount', errorName: 'TypeError', catches: 2 }),
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

function build(
  renderStore: InMemoryGguiSessionStore,
  pendingEventConsumer: InMemoryPendingEventConsumer,
  logger?: Logger,
) {
  return defaultHandlers({
    ...(logger ? { logger } : {}),
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

/** A session under app B, holding one queued gesture — bound to `subject` (its row's `userId`) when one is given. */
async function seededWorld(subject?: string) {
  const renderStore = new InMemoryGguiSessionStore();
  const pendingEventConsumer = new InMemoryPendingEventConsumer();
  const created = await renderStore.create({ appId: APP_B });
  await renderStore.commit({
    appId: APP_B,
    render: card(created.id, APP_B),
    sourceCode: 'export default function Card() { return null; }',
    ...(subject !== undefined ? { userId: subject } : {}),
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
 * ggui#1483 — the cross-SUBJECT twin of the suite above, over the same
 * registry enumeration and the same table. Within one app, a session bound
 * to an end-user (its row's `userId`, written at commit) is called by a
 * DIFFERENT end-user of that app (`ctx.userId`, set for a `kind: 'user'`
 * identity: on a federated deployment, every end-user of an app shares its
 * `appId`). The call must answer exactly as a missing session and change
 * nothing; the owner's own call is the control. A handler that gains a
 * `sessionId` input is covered by construction, as above.
 *
 * `NO_END_USER` pins the one case the two visibility predicates decide
 * differently — a caller with NO end-user identity (an app or builder
 * credential) against a subject-bound row. `isVisibleToCaller` refuses it
 * (`ggui_consume`, `ggui_get_session`, `ggui_get_render_source`);
 * `renderReadAllowed` admits it as app trust. The handlers ggui#1483 gated
 * take `renderReadAllowed`: for the runtime tools it is the predicate of the
 * read door that issued the view its session, so a view is admitted to its
 * calls by the rule that admitted it to its read; for `ggui_update`,
 * `ggui_amend` and `ggui_emit` it adds the cross-subject refusal and leaves
 * the no-identity case as it was. Which way the two should converge is
 * ggui#1553; until it is decided, a change to any row of this table is a
 * decision, not drift.
 */
const OWNER = 'provider-x:owner-subject';
const OTHER = 'provider-x:other-subject';

const NO_END_USER: Record<string, 'admitted' | 'as-missing'> = {
  ggui_amend: 'admitted',
  ggui_update: 'admitted',
  ggui_consume: 'as-missing',
  ggui_emit: 'admitted',
  ggui_get_render_source: 'as-missing',
  ggui_get_session: 'as-missing',
  ggui_runtime_pull: 'admitted',
  ggui_runtime_submit_action: 'admitted',
  ggui_runtime_sync_context: 'admitted',
};

/** The handlers whose subject gate is `renderReadAllowed` and leaves `runtime_cross_subject_refused`. */
const LOGS_SUBJECT_REFUSAL: ReadonlySet<string> = new Set(
  Object.entries(NO_END_USER)
    .filter(([, expected]) => expected === 'admitted')
    .map(([name]) => name),
);

const endUserCtx = (userId: string): HandlerContext => ({ appId: APP_B, requestId: `req-${userId}`, userId });

describe("every sessionId handler refuses another end-user's session of the same app exactly as a missing one (ggui#1483)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  for (const [name, spec] of Object.entries(CLASSIFIED)) {
    it(`${name}: another end-user ≡ missing; nothing changes the owner's row, events or pipe; the owner's own call takes its path`, async () => {
      const world = await seededWorld(OWNER);
      expect((await world.renderStore.get(world.sessionId))?.userId).toBe(OWNER);
      const handler = world.handlers.find((h) => h.name === name);
      expect(handler, `${name} is registered`).toBeDefined();
      if (!handler) return;
      const before = {
        row: JSON.stringify(await world.renderStore.get(world.sessionId)),
        events: JSON.stringify(await world.renderStore.listEventsSince(world.sessionId, 0, 500)),
      };

      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const foreign = await answerOf(() => handler.handler(spec.input(world.sessionId, APP_B), endUserCtx(OTHER)));
      const foreignLines = warn.mock.calls.map((c) => c.map(String).join(' '));
      warn.mockClear();
      const emptyConsumer = new InMemoryPendingEventConsumer();
      emptyConsumer.markCreated(world.sessionId);
      const emptyHandler = build(new InMemoryGguiSessionStore(), emptyConsumer).find((h) => h.name === name);
      expect(emptyHandler, `${name} is registered on the empty store`).toBeDefined();
      if (!emptyHandler) return;
      const missing = await answerOf(() =>
        emptyHandler.handler(spec.input(world.sessionId, APP_B), endUserCtx(OTHER)),
      );
      const missingLines = warn.mock.calls.map((c) => c.map(String).join(' '));
      warn.mockClear();

      expect(foreign).toBe(missing);
      // The operator's line: one per refusal, naming the tool and the session,
      // never either end-user; a session that never existed leaves none. The
      // handlers that refuse through `isVisibleToCaller` log nothing, as before.
      const refusals = foreignLines.filter((l) => l.includes('runtime_cross_subject_refused'));
      if (LOGS_SUBJECT_REFUSAL.has(name)) {
        expect(refusals).toHaveLength(1);
        expect(refusals[0]).toContain(`"tool":"${name}"`);
        expect(refusals[0]).toContain(world.sessionId);
        expect(refusals[0]).not.toContain(OWNER);
        expect(refusals[0]).not.toContain(OTHER);
      } else {
        expect(refusals).toEqual([]);
      }
      expect(missingLines.filter((l) => l.includes('runtime_cross_subject_refused'))).toEqual([]);
      expect(JSON.stringify(await world.renderStore.get(world.sessionId))).toBe(before.row);
      expect(JSON.stringify(await world.renderStore.listEventsSince(world.sessionId, 0, 500))).toBe(before.events);
      expect(world.pendingEventConsumer.pendingCount(world.sessionId)).toBe(1);

      const owner = await answerOf(() => handler.handler(spec.input(world.sessionId, APP_B), endUserCtx(OWNER)));
      const ownerLines = warn.mock.calls.map((c) => c.map(String).join(' '));
      warn.mockRestore();
      expect(ownerLines.filter((l) => l.includes('runtime_cross_subject_refused'))).toEqual([]);
      expect(owner).not.toContain('"threw"');
      expect(owner).not.toContain('"ok":false');
      if (spec.kind === 'not-found') {
        expect(owner).not.toBe(missing);
      } else {
        expect(owner).toBe(missing);
      }
    });
  }

  it('every not-found handler is classified for a caller with no end-user identity, and the table names nothing else', () => {
    const notFound = Object.entries(CLASSIFIED)
      .filter(([, spec]) => spec.kind === 'not-found')
      .map(([name]) => name)
      .sort();
    expect(Object.keys(NO_END_USER).sort()).toEqual(notFound);
  });

  for (const [name, expected] of Object.entries(NO_END_USER)) {
    it(`${name}: a caller with no end-user identity on a subject-bound session is ${expected === 'admitted' ? 'admitted (app trust, renderReadAllowed)' : 'answered as missing (isVisibleToCaller)'} — ggui#1553`, async () => {
      const spec = CLASSIFIED[name];
      expect(spec, `${name} is classified`).toBeDefined();
      if (!spec) return;
      const world = await seededWorld(OWNER);
      const handler = world.handlers.find((h) => h.name === name);
      if (!handler) throw new Error(`${name} is not registered`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      const appCaller = await answerOf(() => handler.handler(spec.input(world.sessionId, APP_B), ctxOf(APP_B)));
      const appCallerLines = warn.mock.calls.map((c) => c.map(String).join(' '));
      const appCallerInfo = info.mock.calls.map((c) => c.map(String).join(' '));
      warn.mockRestore();
      info.mockRestore();
      expect(appCallerLines.filter((l) => l.includes('runtime_cross_subject_refused'))).toEqual([]);
      // ggui#1553: an admitted door leaves the gate's two lines, named with
      // the door — the per-read line (its denominator) and the rung-4
      // admission line, exactly once each; a door that answers as-missing
      // ran the other predicate and leaves neither. These handlers are built
      // without a logger, so the lines are the gate's console fallback.
      const admitLines = appCallerInfo.filter((l) => l.startsWith('[ggui] render_read_app_trust_over_subject '));
      const readLines = appCallerInfo.filter((l) => l.startsWith('[ggui] render_resource_read '));
      if (expected === 'admitted') {
        expect(admitLines).toEqual([
          `[ggui] render_read_app_trust_over_subject {"door":"${name}","appId":"${APP_B}","source":null}`,
        ]);
        expect(readLines).toEqual([
          `[ggui] render_resource_read {"door":"${name}","appId":"${APP_B}","source":null,"appTrustOverSubject":true}`,
        ]);
      } else {
        expect(admitLines).toEqual([]);
        expect(readLines).toEqual([]);
      }
      const emptyConsumer = new InMemoryPendingEventConsumer();
      emptyConsumer.markCreated(world.sessionId);
      const emptyHandler = build(new InMemoryGguiSessionStore(), emptyConsumer).find((h) => h.name === name);
      if (!emptyHandler) throw new Error(`${name} is not registered on the empty store`);
      const missing = await answerOf(() => emptyHandler.handler(spec.input(world.sessionId, APP_B), ctxOf(APP_B)));
      if (expected === 'admitted') {
        expect(appCaller).not.toContain('"threw"');
        expect(appCaller).not.toContain('"ok":false');
      } else {
        expect(appCaller).toBe(missing);
      }
    });
  }

  // A session with no subject is outside the rule (SPEC §7.9.1): any end-user of its app may use it, as the read door admits.
  for (const [name, spec] of Object.entries(CLASSIFIED)) {
    if (spec.kind !== 'not-found') continue;
    it(`${name}: an end-user on a session with no subject takes its path — control`, async () => {
      const world = await seededWorld();
      expect((await world.renderStore.get(world.sessionId))?.userId).toBeUndefined();
      const handler = world.handlers.find((h) => h.name === name);
      if (!handler) throw new Error(`${name} is not registered`);
      const answer = await answerOf(() => handler.handler(spec.input(world.sessionId, APP_B), endUserCtx(OTHER)));
      expect(answer).not.toContain('"threw"');
      expect(answer).not.toContain('"ok":false');
    });
  }

  // The gate runs before per-card validation: an INVALID call from another
  // end-user answers exactly as the same call on a missing session, so a
  // validation error can never describe the owner's card (its declared
  // channels, its context slots).
  const INVALID_FOREIGN: Record<string, Input> = {
    ggui_emit: (sessionId) => ({ sessionId, channel: 'not-declared', payload: { n: 1 } }),
    ggui_runtime_sync_context: (sessionId, declaredAppId) => ({
      sessionId,
      appId: declaredAppId,
      snapshot: { 'not-declared': 'x' },
    }),
  };
  for (const [name, input] of Object.entries(INVALID_FOREIGN)) {
    it(`${name}: another end-user's INVALID call ≡ the same call on a missing session (the gate runs before validation)`, async () => {
      const world = await seededWorld(OWNER);
      const handler = world.handlers.find((h) => h.name === name);
      if (!handler) throw new Error(`${name} is not registered`);
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const foreign = await answerOf(() => handler.handler(input(world.sessionId, APP_B), endUserCtx(OTHER)));
      const emptyConsumer = new InMemoryPendingEventConsumer();
      emptyConsumer.markCreated(world.sessionId);
      const emptyHandler = build(new InMemoryGguiSessionStore(), emptyConsumer).find((h) => h.name === name);
      if (!emptyHandler) throw new Error(`${name} is not registered on the empty store`);
      const missing = await answerOf(() => emptyHandler.handler(input(world.sessionId, APP_B), endUserCtx(OTHER)));
      // Control: the owner's same invalid call is a validation answer, not the missing one.
      const owner = await answerOf(() => handler.handler(input(world.sessionId, APP_B), endUserCtx(OWNER)));
      warn.mockRestore();
      expect(foreign).toBe(missing);
      expect(owner).not.toBe(missing);
    });
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

/**
 * ggui#1553 — the gate's two lines reach the COMPOSITION'S logger, not the
 * console, at every admitted door. The `NO_END_USER` loop above builds
 * `defaultHandlers` without a logger, so its line assertions read the gate's
 * console fallback: they prove each door reaches the gate, not which sink it
 * reaches. This loop builds WITH a recording logger and asserts the lines
 * arrive there and `console.info` stays silent — the property "one query
 * counts every door" depends on, pinned per door so a composition that drops
 * one door's `logger` spread goes red here.
 */
describe("every admitted door hands the gate's lines to the composition's logger, never the console (ggui#1553)", () => {
  for (const [name, expected] of Object.entries(NO_END_USER)) {
    if (expected !== 'admitted') continue;
    it(`${name}: both lines on the logger with door "${name}"; console.info untouched by the gate`, async () => {
      const spec = CLASSIFIED[name];
      expect(spec, `${name} is classified`).toBeDefined();
      if (!spec) return;
      const world = await seededWorld(OWNER);
      const infos: Array<readonly [string, Record<string, unknown> | undefined]> = [];
      const recording: Logger = {
        info: (event, fields) => {
          infos.push([event, fields]);
        },
        warn: () => undefined,
        error: () => undefined,
        debug: () => undefined,
        child: () => recording,
      };
      const handler = build(world.renderStore, world.pendingEventConsumer, recording).find((h) => h.name === name);
      if (!handler) throw new Error(`${name} is not registered`);
      const info = vi.spyOn(console, 'info').mockImplementation(() => undefined);
      await answerOf(() => handler.handler(spec.input(world.sessionId, APP_B), ctxOf(APP_B)));
      const consoleGateLines = info.mock.calls
        .map((c) => String(c[0]))
        .filter((l) => l.startsWith('[ggui] render_resource_read') || l.startsWith('[ggui] render_read_app_trust_over_subject'));
      info.mockRestore();
      expect(consoleGateLines).toEqual([]);
      expect(infos.filter(([event]) => event === 'render_resource_read')).toEqual([
        ['render_resource_read', { door: name, appId: APP_B, source: null, appTrustOverSubject: true }],
      ]);
      expect(infos.filter(([event]) => event === 'render_read_app_trust_over_subject')).toEqual([
        ['render_read_app_trust_over_subject', { door: name, appId: APP_B, source: null }],
      ]);
    });
  }
});
