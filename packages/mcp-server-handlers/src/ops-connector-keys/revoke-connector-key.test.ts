import { describe, expect, it } from 'vitest';
import type { HandlerContext } from '../types.js';
import { createRevokeConnectorKeyHandler } from './revoke-connector-key.js';
import { InMemoryConnectorKeysSource } from './in-memory-fake.test-util.js';
import {
  ConnectorKeyAccessDeniedError,
  ConnectorKeyNotFoundError,
} from './types.js';

function makeCtx(opts: Partial<HandlerContext> = {}): HandlerContext {
  return { appId: 'user-1', requestId: 'req-1', userId: 'user-1', ...opts };
}

describe('createRevokeConnectorKeyHandler — declaration', () => {
  it('exposes the canonical tool name and audience', () => {
    const handler = createRevokeConnectorKeyHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    expect(handler.name).toBe('ggui_ops_revoke_connector_key');
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createRevokeConnectorKeyHandler — happy path', () => {
  it('flips status from active → revoked', async () => {
    const ck = new InMemoryConnectorKeysSource();
    const issued = await ck.issue({ ownerSub: 'user-1' });
    const handler = createRevokeConnectorKeyHandler({ connectorKeys: ck });
    const result = await handler.handler(
      { keyId: issued.summary.id },
      makeCtx(),
    );
    expect(result.status).toBe('revoked');
    expect(result.alreadyRevoked).toBe(false);
  });

  it('is idempotent for already-revoked keys', async () => {
    const ck = new InMemoryConnectorKeysSource();
    const issued = await ck.issue({ ownerSub: 'user-1' });
    const handler = createRevokeConnectorKeyHandler({ connectorKeys: ck });
    await handler.handler({ keyId: issued.summary.id }, makeCtx());
    const second = await handler.handler(
      { keyId: issued.summary.id },
      makeCtx(),
    );
    expect(second.alreadyRevoked).toBe(true);
    expect(second.status).toBe('revoked');
  });
});

describe('createRevokeConnectorKeyHandler — denial + not found', () => {
  it('rejects unknown keyId with ConnectorKeyNotFoundError', async () => {
    const handler = createRevokeConnectorKeyHandler({
      connectorKeys: new InMemoryConnectorKeysSource(),
    });
    await expect(
      handler.handler({ keyId: 'key_nope' }, makeCtx()),
    ).rejects.toBeInstanceOf(ConnectorKeyNotFoundError);
  });

  it('rejects cross-user revoke with ConnectorKeyAccessDeniedError', async () => {
    const ck = new InMemoryConnectorKeysSource();
    const theirs = await ck.issue({ ownerSub: 'user-2' });
    const handler = createRevokeConnectorKeyHandler({ connectorKeys: ck });
    await expect(
      handler.handler(
        { keyId: theirs.summary.id },
        makeCtx({ userId: 'user-1' }),
      ),
    ).rejects.toBeInstanceOf(ConnectorKeyAccessDeniedError);
  });
});
