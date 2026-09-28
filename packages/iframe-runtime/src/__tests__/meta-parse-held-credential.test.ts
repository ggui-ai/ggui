/**
 * ggui#1496 part B (runtime) — the parse keeps an expired live credential
 * instead of discarding it, so the view can refresh it through its host.
 *
 * Before, an expired `expiresAt` either dropped the live trio (static
 * content present) or refused the slice as `EXPIRED_BOOTSTRAP` (live-only),
 * and in both cases the credential was gone: nothing was left to refresh.
 * Now the dropped trio comes back as `held`, runtime-local, never a
 * protocol member, and the projected meta still carries no live trio, so
 * nothing subscribes with a dead token by accident.
 */
import { describe, expect, it } from 'vitest';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { validateMeta } from '../meta-parse.js';

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2999-01-01T00:00:00.000Z';

const live = {
  wsUrl: 'wss://ggui.example/ws',
  wsToken: 'tok-root',
  sseUrl: 'https://ggui.example/api/sessions/s1/stream?wsToken=tok-root',
  pollingUrl: 'https://ggui.example/api/sessions/s1/events?wsToken=tok-root',
} as const;

const base: McpAppAiGguiRenderMeta = {
  sessionId: 's1',
  appId: 'app-1',
  runtimeUrl: 'https://runtime.example/bundle.js',
};

const HELD = {
  wsToken: 'tok-root',
  wsUrl: 'wss://ggui.example/ws',
  expiresAt: PAST,
  sseUrl: live.sseUrl,
  pollingUrl: live.pollingUrl,
  origin: 'root',
} as const;

describe('validateMeta keeps an expired live credential as `held` (ggui#1496)', () => {
  it('expired, with static content: mounts without a live trio, and holds the dropped credential', () => {
    const result = validateMeta({ ...base, ...live, codeUrl: 'https://code.example/c.js', expiresAt: PAST });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.wsToken).toBeUndefined();
    expect(result.meta.wsUrl).toBeUndefined();
    expect(result.meta.expiresAt).toBeUndefined();
    expect(result.held).toEqual(HELD);
  });

  it('expired, live-only: still EXPIRED_BOOTSTRAP, now carrying the projected meta and the held credential', () => {
    const result = validateMeta({ ...base, ...live, expiresAt: PAST });
    expect(result.ok).toBe(false);
    if (result.ok || result.reason !== 'EXPIRED_BOOTSTRAP') throw new Error('expected EXPIRED_BOOTSTRAP');
    expect(result.held).toEqual(HELD);
    expect(result.meta.sessionId).toBe('s1');
    expect(result.meta.wsToken).toBeUndefined();
  });

  it('not expired: the live trio stays in the meta, and nothing is held', () => {
    const result = validateMeta({ ...base, ...live, codeUrl: 'https://code.example/c.js', expiresAt: FUTURE });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.meta.wsToken).toBe('tok-root');
    expect(result.held).toBeUndefined();
  });

  it('expired, static content and no live trio: nothing to hold', () => {
    const result = validateMeta({ ...base, codeUrl: 'https://code.example/c.js', expiresAt: PAST });
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(result.held).toBeUndefined();
  });
});
