/**
 * ggui#1415 runtime item 1 — the parse captures the view's key root from
 * the slice: `P`, the payload segment of its `wsToken`, and `K`, its
 * `viewKey`. It is captured before an expired credential leaves the meta,
 * because a view proves with the root the server delivered whether or not
 * the credential beside it is still live. The projected meta never carries
 * the key: the root rides beside it as `viewRoot`.
 */
import { describe, expect, it } from 'vitest';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  type McpAppAiGguiRenderMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { parseMetaFromToolResult, validateMeta } from '../meta-parse.js';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';
const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
const P = Buffer.from(
  JSON.stringify({ sessionId: 's1', appId: 'app-1', kind: 'ws', iat: 100, exp: 280, jti: 'j', kid: 'k', src: 'result' }),
  'utf8',
).toString('base64url');

const base: McpAppAiGguiRenderMeta = {
  sessionId: 's1',
  appId: 'app-1',
  runtimeUrl: 'https://runtime.example/bundle.js',
  wsUrl: 'wss://ggui.example/ws',
  wsToken: `${P}.c2lnbmF0dXJl`,
  viewKey: KEY,
};

describe('validateMeta captures the view key root (ggui#1415)', () => {
  it('a live slice: the root rides beside the meta, and the meta carries no key', () => {
    const result = validateMeta({ ...base, expiresAt: FUTURE });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.viewRoot).toEqual({ root: P, key: KEY });
    expect(result.meta).not.toHaveProperty('viewKey');
    expect(result.meta.wsToken).toBe(base.wsToken);
  });

  it('expired, with static content: the root is captured before the credential is dropped', () => {
    const result = validateMeta({ ...base, codeUrl: 'https://code.example/c.js', expiresAt: PAST });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.wsToken).toBeUndefined();
    expect(result.held?.wsToken).toBe(base.wsToken);
    expect(result.viewRoot).toEqual({ root: P, key: KEY });
  });

  it('expired, live-only: EXPIRED_BOOTSTRAP carries the root beside the held credential', () => {
    const result = validateMeta({ ...base, expiresAt: PAST });
    if (result.ok || result.reason !== 'EXPIRED_BOOTSTRAP') throw new Error('expected EXPIRED_BOOTSTRAP');
    expect(result.viewRoot).toEqual({ root: P, key: KEY });
    expect(result.meta).not.toHaveProperty('viewKey');
  });

  it('a slice without a viewKey captures no root', () => {
    const { viewKey: _omitted, ...keyless } = base;
    const result = validateMeta({ ...keyless, expiresAt: FUTURE });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result).not.toHaveProperty('viewRoot');
  });

  it('through the wire parser: a tool result slice with a viewKey yields the root', () => {
    const result = parseMetaFromToolResult({
      content: [],
      _meta: { [MCP_APP_AI_GGUI_RENDER_META_KEY]: { ...base, expiresAt: FUTURE } },
    });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.viewRoot).toEqual({ root: P, key: KEY });
  });
});
