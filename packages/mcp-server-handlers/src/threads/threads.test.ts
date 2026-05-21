/**
 * Thread-handler integration tests.
 *
 * Consumes the shipped `InMemoryThreadStore` from
 * `@ggui-ai/mcp-server-core/in-memory` — the same impl that passes
 * `threadStoreContract`. What this suite locks is the handler layer
 * specifically:
 *
 *   - Each handler parses its request and rejects malformed input
 *     with {@link InvalidThreadRequestError}.
 *   - Handlers forward to the store and surface typed store errors
 *     verbatim (no re-wrapping, no new semantic rules).
 *   - Handlers don't re-implement ownership, idempotency, seq, or
 *     action-state rules (the store tests already cover those).
 *
 * If a test here looks like it's also testing store behavior, that's
 * a signal to trim it — the handler layer should be too thin to have
 * its own semantics.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryThreadStore } from '@ggui-ai/mcp-server-core/in-memory';
import {
  appendMessage,
  applyThreadAction,
  createThread,
  getThread,
  InvalidThreadRequestError,
  listMessages,
  listThreads,
  observeMessages,
  ThreadActionInvalidStateError,
  ThreadNotFoundError,
  type ThreadHandlerContext,
} from './index.js';

const OWNER_A: ThreadHandlerContext = {
  ownerId: 'cognito_owner-a',
  requestId: 'req-a-1',
};
const OWNER_B: ThreadHandlerContext = {
  ownerId: 'cognito_owner-b',
  requestId: 'req-b-1',
};

function makeDeps(): { threads: InMemoryThreadStore } {
  return { threads: new InMemoryThreadStore() };
}

describe('createThread handler', () => {
  it('parses input + forwards to ThreadStore.createThread', async () => {
    const deps = makeDeps();
    const thread = await createThread(
      deps,
      { appId: 'app-1', firstMessageHint: 'hi there' },
      OWNER_A,
    );
    expect(thread.ownerId).toBe(OWNER_A.ownerId);
    expect(thread.appId).toBe('app-1');
    expect(thread.title).toBe('hi there');
    expect(thread.status).toBe('active');
    expect(thread.lastSeq).toBe(0);
  });

  it('rejects missing appId with InvalidThreadRequestError', async () => {
    const deps = makeDeps();
    await expect(
      createThread(deps, { firstMessageHint: 'x' }, OWNER_A),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });

  it('rejects extra unknown fields (strict schema)', async () => {
    const deps = makeDeps();
    await expect(
      createThread(
        deps,
        { appId: 'app-1', notARealField: true },
        OWNER_A,
      ),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });
});

describe('getThread handler', () => {
  it('returns the thread when owner matches', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const fetched = await getThread(deps, { threadId: t.id }, OWNER_A);
    expect(fetched.id).toBe(t.id);
  });

  it('throws ThreadNotFoundError for wrong owner', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      getThread(deps, { threadId: t.id }, OWNER_B),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });

  it('throws ThreadNotFoundError for missing thread', async () => {
    const deps = makeDeps();
    await expect(
      getThread(deps, { threadId: 'nope' }, OWNER_A),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
});

describe('listThreads handler', () => {
  it('returns the caller owner threads only', async () => {
    const deps = makeDeps();
    await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await createThread(deps, { appId: 'app-2' }, OWNER_A);
    await createThread(deps, { appId: 'app-1' }, OWNER_B);
    const res = await listThreads(deps, {}, OWNER_A);
    expect(res.threads).toHaveLength(2);
    expect(res.threads.every((t) => t.ownerId === OWNER_A.ownerId)).toBe(
      true,
    );
  });

  it('accepts an empty filter by treating undefined as {}', async () => {
    const deps = makeDeps();
    await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const res = await listThreads(deps, undefined, OWNER_A);
    expect(res.threads).toHaveLength(1);
  });

  it('rejects malformed filter with InvalidThreadRequestError', async () => {
    const deps = makeDeps();
    await expect(
      listThreads(deps, { status: 'unknown-status' }, OWNER_A),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });

  it('forwards appId + status filters to the store', async () => {
    const deps = makeDeps();
    const t1 = await createThread(deps, { appId: 'app-x' }, OWNER_A);
    const t2 = await createThread(deps, { appId: 'app-y' }, OWNER_A);
    await applyThreadAction(
      deps,
      { threadId: t2.id, body: { action: 'archive' } },
      OWNER_A,
    );
    const byApp = await listThreads(deps, { appId: 'app-x' }, OWNER_A);
    expect(byApp.threads.map((t) => t.id)).toEqual([t1.id]);
    const archived = await listThreads(
      deps,
      { status: 'archived' },
      OWNER_A,
    );
    expect(archived.threads.map((t) => t.id)).toEqual([t2.id]);
  });
});

describe('appendMessage handler', () => {
  it('forwards the parsed input to the store', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const m = await appendMessage(
      deps,
      {
        threadId: t.id,
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [{ type: 'text', text: 'hi' }],
        textPreview: 'hi',
      },
      OWNER_A,
    );
    expect(m.seq).toBe(1);
    expect(m.textPreview).toBe('hi');
  });

  it('preserves the store first-write-wins contract on retry', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const first = await appendMessage(
      deps,
      {
        threadId: t.id,
        key: 'kx',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'first',
      },
      OWNER_A,
    );
    const retry = await appendMessage(
      deps,
      {
        threadId: t.id,
        key: 'kx',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'different',
      },
      OWNER_A,
    );
    expect(retry.seq).toBe(first.seq);
    expect(retry.textPreview).toBe('first');
  });

  it('rejects malformed body with InvalidThreadRequestError', async () => {
    const deps = makeDeps();
    await expect(
      appendMessage(deps, { threadId: 't', key: 'k' }, OWNER_A),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });

  it('forwards wrong-owner rejection as ThreadNotFoundError', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      appendMessage(
        deps,
        {
          threadId: t.id,
          key: 'k1',
          authorRole: 'user',
          kind: 'text',
          blocks: [],
          textPreview: '',
        },
        OWNER_B,
      ),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
});

describe('listMessages handler', () => {
  it('returns messages ASC by seq', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    for (let i = 1; i <= 3; i++) {
      await appendMessage(
        deps,
        {
          threadId: t.id,
          key: `k${i}`,
          authorRole: 'user',
          kind: 'text',
          blocks: [],
          textPreview: `m${i}`,
        },
        OWNER_A,
      );
    }
    const res = await listMessages(deps, { threadId: t.id }, OWNER_A);
    expect(res.messages.map((m) => m.seq)).toEqual([1, 2, 3]);
  });

  it('honors fromSeq option', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    for (let i = 1; i <= 3; i++) {
      await appendMessage(
        deps,
        {
          threadId: t.id,
          key: `k${i}`,
          authorRole: 'user',
          kind: 'text',
          blocks: [],
          textPreview: `m${i}`,
        },
        OWNER_A,
      );
    }
    const res = await listMessages(
      deps,
      { threadId: t.id, options: { fromSeq: 2 } },
      OWNER_A,
    );
    expect(res.messages.map((m) => m.seq)).toEqual([2, 3]);
  });

  it('rejects malformed options', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      listMessages(
        deps,
        { threadId: t.id, options: { fromSeq: -1 } },
        OWNER_A,
      ),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });

  it('forwards wrong-owner rejection as ThreadNotFoundError', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      listMessages(deps, { threadId: t.id }, OWNER_B),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });
});

describe('applyThreadAction handler', () => {
  it('delegates each canonical action to the store', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const pinned = await applyThreadAction(
      deps,
      { threadId: t.id, body: { action: 'pin' } },
      OWNER_A,
    );
    expect(pinned.pinned).toBe(true);
    const archived = await applyThreadAction(
      deps,
      { threadId: t.id, body: { action: 'archive' } },
      OWNER_A,
    );
    expect(archived.status).toBe('archived');
  });

  it('rejects unknown action strings with InvalidThreadRequestError', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      applyThreadAction(
        deps,
        { threadId: t.id, body: { action: 'snooze' } },
        OWNER_A,
      ),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });

  it('surfaces ThreadActionInvalidStateError on restore-from-active', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      applyThreadAction(
        deps,
        { threadId: t.id, body: { action: 'restore' } },
        OWNER_A,
      ),
    ).rejects.toBeInstanceOf(ThreadActionInvalidStateError);
  });

  it('surfaces ThreadNotFoundError for wrong owner', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      applyThreadAction(
        deps,
        { threadId: t.id, body: { action: 'pin' } },
        OWNER_B,
      ),
    ).rejects.toBeInstanceOf(ThreadNotFoundError);
  });

  it('rejects a malformed body envelope (missing action)', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await expect(
      applyThreadAction(
        deps,
        { threadId: t.id, body: {} },
        OWNER_A,
      ),
    ).rejects.toBeInstanceOf(InvalidThreadRequestError);
  });
});

describe('observeMessages handler', () => {
  it('returns an iterable that yields historical + tailing messages', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    await appendMessage(
      deps,
      {
        threadId: t.id,
        key: 'k1',
        authorRole: 'user',
        kind: 'text',
        blocks: [],
        textPreview: 'one',
      },
      OWNER_A,
    );
    const iter = observeMessages(
      deps,
      { threadId: t.id },
      OWNER_A,
    )[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.value?.seq).toBe(1);

    const pending = iter.next();
    await appendMessage(
      deps,
      {
        threadId: t.id,
        key: 'k2',
        authorRole: 'agent',
        kind: 'text',
        blocks: [],
        textPreview: 'two',
      },
      OWNER_A,
    );
    const second = await pending;
    expect(second.value?.seq).toBe(2);
    if (iter.return) await iter.return(undefined);
  });

  it('iterator throws ThreadNotFoundError on wrong owner', async () => {
    const deps = makeDeps();
    const t = await createThread(deps, { appId: 'app-1' }, OWNER_A);
    const iter = observeMessages(
      deps,
      { threadId: t.id },
      OWNER_B,
    )[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toBeInstanceOf(ThreadNotFoundError);
  });

  it('rejects malformed options synchronously', () => {
    const deps = makeDeps();
    // Malformed options is a request-shape error — surfaces before the
    // iterator is even constructed, so callers don't need to handle
    // it on `.next()`.
    expect(() =>
      observeMessages(
        deps,
        { threadId: 't', options: { tail: 'yes' } },
        OWNER_A,
      ),
    ).toThrow(InvalidThreadRequestError);
  });
});
