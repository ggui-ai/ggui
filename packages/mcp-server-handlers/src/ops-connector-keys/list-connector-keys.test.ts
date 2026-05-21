import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createListConnectorKeysHandler } from './list-connector-keys.js';
import { InMemoryConnectorKeysSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createListConnectorKeysHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createListConnectorKeysHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    expect(handler.name).toBe('ggui_ops_list_connector_keys');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createListConnectorKeysHandler — happy path', () => {
  it('returns only the calling user’s keys (no plaintext leak)', async () => {
    const ck = new InMemoryConnectorKeysSource();
    await ck.issue({ ownerSub: 'user-1', name: 'Mine' });
    await ck.issue({ ownerSub: 'user-2', name: 'Theirs' });
    const handler = createListConnectorKeysHandler({ connectorKeys: ck });
    const result = await handler.handler({}, makeCtx());
    expect(result.keys).toHaveLength(1);
    expect(result.keys[0]?.name).toBe('Mine');
    // The summary must not carry the plaintext anywhere.
    expect(JSON.stringify(result.keys)).not.toContain('ggui_user_');
  });
});

describe('createListConnectorKeysHandler — identity', () => {
  it('throws on empty identity', async () => {
    const handler = createListConnectorKeysHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    await expect(
      handler.handler({}, { appId: '', requestId: 'r' }),
    ).rejects.toThrow();
  });
});
