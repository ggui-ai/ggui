import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createIssueConnectorKeyHandler } from './issue-connector-key.js';
import { InMemoryConnectorKeysSource } from './in-memory-fake.test-util.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createIssueConnectorKeyHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createIssueConnectorKeyHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    expect(handler.name).toBe('ggui_ops_issue_connector_key');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createIssueConnectorKeyHandler — happy path', () => {
  it('mints a key and reveals plaintext exactly once', async () => {
    const ck = new InMemoryConnectorKeysSource();
    const handler = createIssueConnectorKeyHandler({ connectorKeys: ck });
    const result = await handler.handler(
      { name: 'MacBook' },
      makeCtx(),
    );
    expect(result.plaintextKey).toMatch(/^ggui_user_/);
    expect(result.name).toBe('MacBook');
    expect(result.status).toBe('active');
    // The plaintext is one-time — listing the keys should NOT carry it.
    const after = await ck.list('user-1');
    expect(JSON.stringify(after)).not.toContain(result.plaintextKey);
  });

  it('honors optional appId binding', async () => {
    const ck = new InMemoryConnectorKeysSource();
    const handler = createIssueConnectorKeyHandler({ connectorKeys: ck });
    const result = await handler.handler(
      { appId: 'app_xyz12345' },
      makeCtx(),
    );
    expect(result.appId).toBe('app_xyz12345');
  });
});

describe('createIssueConnectorKeyHandler — identity', () => {
  it('throws on empty identity', async () => {
    const handler = createIssueConnectorKeyHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    await expect(
      handler.handler({}, { appId: '', requestId: 'r' }),
    ).rejects.toThrow();
  });
});
