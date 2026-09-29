/**
 * SqliteGguiSessionStreamBuffer tests (ggui#1534).
 *
 * Two layers, as for the other SQLite adapters:
 *   1. The shared conformance suite, on a real temp file (the production
 *      configuration), so the SQLite buffer holds exactly the in-memory
 *      reference's behaviour.
 *   2. What only a persistent buffer can do: a session's counter, epoch and
 *      retained envelopes survive a restart (a new instance over the same
 *      file), so `seq` never restarts for a render that outlives the
 *      process (SPEC §12.2.1 invariant 4's SHOULD) and a reconnect replays
 *      what it missed.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterAll, describe, expect, it } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import { runGguiSessionStreamBufferConformance } from '../contract-tests/ggui-session-stream-buffer.conformance.js';
import { SqliteGguiSessionStreamBuffer } from './ggui-session-stream-buffer.js';
import { SqliteGguiSessionStore } from './ggui-session-store.js';

const dir = mkdtempSync(join(tmpdir(), 'ggui-stream-buffer-'));
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});
let fileCounter = 0;
const freshFile = (): string => join(dir, `streams-${++fileCounter}.sqlite`);

runGguiSessionStreamBufferConformance('SqliteGguiSessionStreamBuffer', {
  create: (opts) => new SqliteGguiSessionStreamBuffer({ filename: freshFile(), ...(opts ?? {}) }),
  cleanup: (buf) => {
    if (buf instanceof SqliteGguiSessionStreamBuffer) buf.close();
  },
});

const SESSION = 'sess-1';
const SPEC: StreamSpec = {
  silent: { schema: { type: 'object' }, replay: 'none' },
  snap: { schema: { type: 'object' }, replay: 'latest' },
  feed: { schema: { type: 'object' }, replay: 'all' },
};
const feed = (n: number) => ({ sessionId: SESSION, channel: 'feed', mode: 'append' as const, payload: { n } });

describe('SqliteGguiSessionStreamBuffer — a restart keeps the counter, the epoch and the retained envelopes', () => {
  it('a session recorded before a restart continues its seq in the same epoch after it, and a reconnect replays what it missed', async () => {
    const file = freshFile();
    const first = new SqliteGguiSessionStreamBuffer({ filename: file });
    await first.record(feed(1), SPEC);
    const before = (await first.record(feed(2), SPEC)).envelope;
    // The last frame before the restart retains nothing ('none'), so a
    // buffer that rebuilt its counter from the retained envelopes would
    // reuse seq 3 below.
    const unretained = (
      await first.record({ sessionId: SESSION, channel: 'silent', mode: 'append', payload: {} }, SPEC)
    ).envelope;
    expect(unretained.seq).toBe(3);
    first.close();

    const second = new SqliteGguiSessionStreamBuffer({ filename: file });
    expect(await second.currentCursor(SESSION)).toEqual({ seq: 3, epoch: before.streamEpoch });
    const after = (await second.record(feed(3), SPEC)).envelope;
    expect(after.seq).toBe(4);
    expect(after.streamEpoch).toBe(before.streamEpoch);
    const replay = await second.replay(SESSION, 1, SPEC);
    expect(replay.envelopes.map((e) => [e.seq, e.payload, e.streamEpoch])).toEqual([
      [2, { n: 2 }, before.streamEpoch],
      [4, { n: 3 }, before.streamEpoch],
    ]);
    expect(replay).toMatchObject({ truncated: false, streamSeq: 4, streamEpoch: before.streamEpoch });
    second.close();
  });

  it('a "latest" slot and the truncation mark survive a restart', async () => {
    const file = freshFile();
    const first = new SqliteGguiSessionStreamBuffer({ filename: file, maxPerSession: 2 });
    await first.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'a' } }, SPEC);
    await first.record({ sessionId: SESSION, channel: 'snap', mode: 'replace', payload: { v: 'b' } }, SPEC);
    for (let n = 1; n <= 3; n++) await first.record(feed(n), SPEC);
    first.close();

    const second = new SqliteGguiSessionStreamBuffer({ filename: file, maxPerSession: 2 });
    const replay = await second.replay(SESSION, 0, SPEC);
    expect(replay.envelopes.map((e) => [e.seq, e.channel])).toEqual([
      [2, 'snap'],
      [4, 'feed'],
      [5, 'feed'],
    ]);
    expect(replay.truncated).toBe(true);
    expect(await second.getSize()).toBe(3);
    second.close();
  });

  it('a clear before the restart stays cleared: the next record starts seq 1 in a new epoch', async () => {
    const file = freshFile();
    const first = new SqliteGguiSessionStreamBuffer({ filename: file });
    const old = (await first.record(feed(1), SPEC)).envelope;
    await first.clear(SESSION);
    first.close();

    const second = new SqliteGguiSessionStreamBuffer({ filename: file });
    expect(await second.currentCursor(SESSION)).toEqual({ seq: 0 });
    const fresh = (await second.record(feed(2), SPEC)).envelope;
    expect(fresh.seq).toBe(1);
    expect(fresh.streamEpoch).not.toBe(old.streamEpoch);
    expect((await second.replay(SESSION, 0, SPEC)).envelopes.map((e) => e.seq)).toEqual([1]);
    second.close();
  });

  it('another database is another counter: the same session id starts at 1 in a different epoch', async () => {
    const a = new SqliteGguiSessionStreamBuffer({ filename: freshFile() });
    const b = new SqliteGguiSessionStreamBuffer({ filename: freshFile() });
    const ea = (await a.record(feed(1), SPEC)).envelope;
    const eb = (await b.record(feed(1), SPEC)).envelope;
    expect(eb.seq).toBe(1);
    expect(eb.streamEpoch).not.toBe(ea.streamEpoch);
    a.close();
    b.close();
  });
});

describe('SqliteGguiSessionStreamBuffer — two connections on one file, interleaved in one process', () => {
  it('interleaved records from two connections share one gap-free counter and one epoch', async () => {
    const file = freshFile();
    const a = new SqliteGguiSessionStreamBuffer({ filename: file });
    const b = new SqliteGguiSessionStreamBuffer({ filename: file });
    const seqs: number[] = [];
    const epochs = new Set<string | undefined>();
    for (let n = 1; n <= 6; n++) {
      const { envelope } = await (n % 2 === 0 ? b : a).record(feed(n), SPEC);
      seqs.push(envelope.seq);
      epochs.add(envelope.streamEpoch);
    }
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6]);
    expect(epochs.size).toBe(1);
    expect((await a.replay(SESSION, 0, SPEC)).envelopes.map((e) => e.seq)).toEqual([1, 2, 3, 4, 5, 6]);
    a.close();
    b.close();
  });
});

describe('SqliteGguiSessionStreamBuffer — shares a database with the session store', () => {
  it('runs over the same handle as SqliteGguiSessionStore, and closing the buffer leaves a handle it does not own open', async () => {
    const db = new Database(freshFile());
    const store = new SqliteGguiSessionStore({ database: db });
    const buf = new SqliteGguiSessionStreamBuffer({ database: db });
    const created = await store.create({ appId: 'app-1' });
    expect((await buf.record({ ...feed(1), sessionId: created.id }, SPEC)).envelope.seq).toBe(1);
    buf.close();
    expect(db.open).toBe(true);
    expect(await store.get(created.id)).not.toBeNull();
    store.close();
    db.close();
  });
});

describe("SqliteGguiSessionStreamBuffer — the cap is this instance's, even over a ring filled under a larger one", () => {
  it('a reopen with a lower maxPerSession trims the ring to it on the next record, and marks the truncation', async () => {
    const file = freshFile();
    const wide = new SqliteGguiSessionStreamBuffer({ filename: file, maxPerSession: 5 });
    for (let n = 1; n <= 5; n++) await wide.record(feed(n), SPEC);
    wide.close();
    const narrow = new SqliteGguiSessionStreamBuffer({ filename: file, maxPerSession: 2 });
    await narrow.record(feed(6), SPEC);
    const replay = await narrow.replay(SESSION, 0, SPEC);
    expect(replay.envelopes.map((e) => e.seq)).toEqual([5, 6]);
    expect(replay.truncated).toBe(true);
    expect((await narrow.replay(SESSION, 4, SPEC)).truncated).toBe(false);
    expect(await narrow.getSize()).toBe(2);
    narrow.close();
  });
});

describe('SqliteGguiSessionStreamBuffer — the epoch it mints', () => {
  it('is 32 hex characters, as the in-memory buffer mints', async () => {
    const buf = new SqliteGguiSessionStreamBuffer({ filename: ':memory:' });
    expect((await buf.record(feed(1), SPEC)).envelope.streamEpoch).toMatch(/^[0-9a-f]{32}$/);
    buf.close();
  });
});

describe('SqliteGguiSessionStreamBuffer — constructor guards', () => {
  it('rejects maxPerSession < 1', () => {
    expect(() => new SqliteGguiSessionStreamBuffer({ filename: ':memory:', maxPerSession: 0 })).toThrow();
  });
});
