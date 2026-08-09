/**
 * The `resources/read` typed-failure surface.
 *
 * Proves the contract that makes "any successful `contents` result IS a
 * live mount" host-checkable: every non-mount outcome leaves the server
 * as a JSON-RPC error carrying a closed `ResourceReadErrorCode`, never
 * as a successful result wrapping a dead shell.
 *
 * The load-bearing pin here is `deny ≡ miss`: a caller reading someone
 * else's locator and a caller reading a locator that never existed MUST
 * receive byte-identical errors, or the read surface becomes a
 * cross-tenant existence oracle.
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_ERROR_CODES,
  resourceReadErrorCodeSchema,
  resourceReadErrorToJsonRpc,
  type ResourceReadError,
  type ResourceReadErrorCode,
} from '../../index.js';

describe('resourceReadErrorToJsonRpc', () => {
  it('maps NOT_FOUND to the resource-not-found number (-32002)', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'NOT_FOUND',
      message: 'No such render.',
    });
    expect(rpc.code).toBe(-32002);
    // Same slot the protocol already assigns to a missing session — for a
    // `ui://ggui/render/{sessionId}/…` locator the two are one condition.
    expect(rpc.code).toBe(MCP_ERROR_CODES.SESSION_NOT_FOUND);
  });

  it('maps BLUEPRINT_UNRESOLVABLE to MOUNT_UNAVAILABLE (-32006), not internal-error', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'BLUEPRINT_UNRESOLVABLE',
      message: 'The component behind this render is gone.',
    });
    expect(rpc.code).toBe(-32006);
    expect(rpc.code).toBe(MCP_ERROR_CODES.MOUNT_UNAVAILABLE);
    expect(rpc.code).not.toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('maps NOT_SUPPORTED to MOUNT_UNAVAILABLE (-32006), not internal-error', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'NOT_SUPPORTED',
      message: 'This server does not restore evicted renders.',
    });
    expect(rpc.code).toBe(-32006);
    expect(rpc.code).not.toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('maps NOT_MOUNTABLE to MOUNT_UNAVAILABLE (-32006), not internal-error', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'NOT_MOUNTABLE',
      message: 'Nothing to mount.',
    });
    expect(rpc.code).toBe(-32006);
    expect(rpc.code).not.toBe(MCP_ERROR_CODES.INTERNAL_ERROR);
  });

  it('carries the ggui code on error.data.code for every member of the enum', () => {
    // Driven off the schema's own option list, so a fifth code added
    // without a mapping fails here rather than silently defaulting.
    const seen: ResourceReadErrorCode[] = [];
    for (const code of resourceReadErrorCodeSchema.options) {
      const rpc = resourceReadErrorToJsonRpc({ code, message: `failure: ${code}` });
      expect(rpc.data.code).toBe(code);
      expect([-32002, -32006]).toContain(rpc.code);
      seen.push(rpc.data.code);
    }
    expect(seen).toEqual(['NOT_FOUND', 'BLUEPRINT_UNRESOLVABLE', 'NOT_SUPPORTED', 'NOT_MOUNTABLE']);
  });

  it('passes the caller message through on the resolvable-but-unmountable codes', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'NOT_MOUNTABLE',
      message: 'Resolved, but no delivery channel is open.',
    });
    expect(rpc.message).toBe('Resolved, but no delivery channel is open.');
  });

  it('passes `detail` through on the resolvable-but-unmountable codes', () => {
    const rpc = resourceReadErrorToJsonRpc({
      code: 'BLUEPRINT_UNRESOLVABLE',
      message: 'Component unavailable.',
      detail: 'code body absent for codeHash sha256:abc',
    });
    expect(rpc.data.detail).toBe('code body absent for codeHash sha256:abc');
  });

  describe('deny ≡ miss', () => {
    it('collapses a gate deny and a genuine miss to byte-identical errors', () => {
      // What a deny would naturally want to say...
      const deny: ResourceReadError = {
        code: 'NOT_FOUND',
        message: 'Session sess_victim belongs to app app_other.',
        detail: 'gate denied: cross-tenant read',
      };
      // ...versus a locator that never existed at all.
      const miss: ResourceReadError = {
        code: 'NOT_FOUND',
        message: 'No row and no identity record for sess_ghost.',
      };
      expect(JSON.stringify(resourceReadErrorToJsonRpc(deny))).toBe(
        JSON.stringify(resourceReadErrorToJsonRpc(miss)),
      );
    });

    it('drops any caller-supplied detail on NOT_FOUND', () => {
      const rpc = resourceReadErrorToJsonRpc({
        code: 'NOT_FOUND',
        message: 'Session sess_victim belongs to app app_other.',
        detail: 'gate denied: cross-tenant read',
      });
      expect(rpc.data.detail).toBeUndefined();
      expect('detail' in rpc.data).toBe(false);
    });

    it('replaces the caller message on NOT_FOUND with a constant that names no subject', () => {
      const rpc = resourceReadErrorToJsonRpc({
        code: 'NOT_FOUND',
        message: 'Session sess_victim belongs to app app_other.',
      });
      expect(rpc.message).not.toContain('sess_victim');
      expect(rpc.message).not.toContain('app_other');
      expect(rpc.message).toBe('Resource not found.');
    });
  });
});
