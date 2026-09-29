/**
 * `ggui serve`'s persistent layer for sessions (ggui#1534): the session
 * store and the live channel's stream buffer, in one `sessions.sqlite`,
 * both or neither — so a session that survives a restart keeps its stream
 * `seq` and epoch.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import type { StreamSpec } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { SqliteGguiSessionStreamBuffer } from '@ggui-ai/mcp-server-core/sqlite';
import { layerPersistentSessionStores } from './persistent-stores.js';

const root = mkdtempSync(join(tmpdir(), 'ggui-persistent-stores-'));
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

/** The SQLite adapters close their handle; the ports don't declare it. */
function closeIfPossible(candidate: object | undefined): void {
  if (candidate && 'close' in candidate && typeof candidate.close === 'function') candidate.close();
}

const SPEC: StreamSpec = { feed: { schema: { type: 'object' }, replay: 'all' } };

describe('layerPersistentSessionStores (ggui#1534)', () => {
  it("adds the session store and its stream buffer in one sessions.sqlite, and a session's seq, epoch and retained frames survive a restart", async () => {
    const dir = join(root, 'restart');
    const first = await layerPersistentSessionStores({}, dir);
    if (!first.renderStore || !first.streamBuffer) throw new Error('both stores expected');
    const session = await first.renderStore.create({ appId: 'app-1' });
    const before = (
      await first.streamBuffer.record({ sessionId: session.id, channel: 'feed', mode: 'append', payload: { n: 1 } }, SPEC)
    ).envelope;
    closeIfPossible(first.streamBuffer);
    closeIfPossible(first.renderStore);

    // The buffer's counter is in the sessions' own file, not beside it.
    const onSessionsFile = new SqliteGguiSessionStreamBuffer({ filename: join(dir, 'sessions.sqlite') });
    expect(await onSessionsFile.currentCursor(session.id)).toEqual({ seq: 1, epoch: before.streamEpoch });
    onSessionsFile.close();

    // A restart: the same persistent directory layered again.
    const second = await layerPersistentSessionStores({}, dir);
    if (!second.renderStore || !second.streamBuffer) throw new Error('both stores expected');
    expect(await second.renderStore.get(session.id)).not.toBeNull();
    const after = (
      await second.streamBuffer.record({ sessionId: session.id, channel: 'feed', mode: 'append', payload: { n: 2 } }, SPEC)
    ).envelope;
    expect(after.seq).toBe(before.seq + 1);
    expect(after.streamEpoch).toBe(before.streamEpoch);
    expect((await second.streamBuffer.replay(session.id, 0, SPEC)).envelopes.map((e) => e.payload)).toEqual([
      { n: 1 },
      { n: 2 },
    ]);
    closeIfPossible(second.streamBuffer);
    closeIfPossible(second.renderStore);
  });

  it('leaves a bundle that already has a render store untouched: no persistent buffer beside a store it did not open', async () => {
    const declared = { renderStore: new InMemoryGguiSessionStore() };
    const layered = await layerPersistentSessionStores(declared, join(root, 'declared'));
    expect(layered).toBe(declared);
    expect(layered.streamBuffer).toBeUndefined();
  });
});
