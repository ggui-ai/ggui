/**
 * ggui#1496 part B (runtime) — the credential controller: the view's
 * held credential, its one-refresh budget, and the refresh over the
 * host's `tools/call` relay. Pure: the relay and the clock are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createCredentialController,
  type HeldCredential,
} from '../credential-controller.js';

const ROOT: HeldCredential = {
  wsToken: 'tok-root',
  wsUrl: 'wss://ggui.example/ws',
  expiresAt: '2026-09-28T00:00:00.000Z',
  sseUrl: 'https://ggui.example/api/sessions/s1/stream?wsToken=tok-root',
  pollingUrl: 'https://ggui.example/api/sessions/s1/events?wsToken=tok-root',
  origin: 'root',
};

/** A relay that answers the refresh with a new envelope. */
function okRelay(envelope = 'tok-new', expiresAt = '2026-09-28T01:00:00.000Z') {
  return vi.fn(async (_name: string, _args: { readonly envelope: string }): Promise<unknown> => ({
    structuredContent: { ok: true, envelope, expiresAt },
    content: [{ type: 'text', text: JSON.stringify({ ok: true, envelope, expiresAt }) }],
  }));
}

const noWait = { sleep: async (): Promise<void> => undefined, random: (): number => 0 };

describe('credential controller: the budget (R2)', () => {
  it('refreshes an expired root credential exactly once, marking it spent when the refresh is requested', async () => {
    const callTool = okRelay();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    const [first, second] = await Promise.all([c.onExpired(ROOT, 'ws'), c.onExpired(ROOT, 'bridge')]);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(callTool).toHaveBeenCalledWith('ggui_runtime_refresh_ws_token', { envelope: 'tok-root' });
    expect(first.kind).toBe('adopted');
    expect(second).toEqual({ kind: 'skipped', reason: 'budget' });
  });

  it('never refreshes a refreshed credential that has not been accepted on a token rung (the loop guard)', async () => {
    const callTool = okRelay();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    await c.onExpired(ROOT, 'ws');
    const refreshed = c.current();
    expect(refreshed.origin).toBe('refreshed');
    expect(await c.onExpired(refreshed, 'ws')).toEqual({ kind: 'skipped', reason: 'budget' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it('gives a refreshed credential that WAS accepted exactly one refresh of its own', async () => {
    const callTool = okRelay();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    await c.onExpired(ROOT, 'ws');
    const refreshed = c.current();
    c.markAccepted(refreshed);
    callTool.mockImplementation(okRelay('tok-third'));
    expect((await c.onExpired(refreshed, 'polling')).kind).toBe('adopted');
    expect(c.current().wsToken).toBe('tok-third');
    expect(await c.onExpired(refreshed, 'ws')).toEqual({ kind: 'skipped', reason: 'stale-ladder' });
  });

  it('ignores an expiry reported by a ladder whose credential is no longer current (F1)', async () => {
    const callTool = okRelay();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    await c.onExpired(ROOT, 'ws');
    expect(await c.onExpired(ROOT, 'polling')).toEqual({ kind: 'skipped', reason: 'stale-ladder' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe('credential controller: adoption and the refresh result', () => {
  it('adopts the envelope with its expiresAt, and re-derives the token-bearing URLs with withWsToken', async () => {
    const onAdopt = vi.fn();
    const c = createCredentialController({ initial: ROOT, callTool: okRelay(), onAdopt, ...noWait });
    const outcome = await c.onExpired(ROOT, 'ws');
    const adopted: HeldCredential = {
      wsToken: 'tok-new',
      wsUrl: 'wss://ggui.example/ws',
      expiresAt: '2026-09-28T01:00:00.000Z',
      sseUrl: 'https://ggui.example/api/sessions/s1/stream?wsToken=tok-new',
      pollingUrl: 'https://ggui.example/api/sessions/s1/events?wsToken=tok-new',
      origin: 'refreshed',
    };
    expect(outcome).toEqual({ kind: 'adopted', credential: adopted });
    expect(c.current()).toEqual(adopted);
    expect(onAdopt).toHaveBeenCalledWith(adopted);
  });

  it('drops a URL whose token cannot be swapped (withWsToken gives undefined): that rung is disarmed', async () => {
    const odd: HeldCredential = { ...ROOT, sseUrl: 'https://ggui.example/api/sessions/s1/stream' };
    const c = createCredentialController({ initial: odd, callTool: okRelay(), ...noWait });
    await c.onExpired(odd, 'ws');
    expect(c.current().sseUrl).toBeUndefined();
    expect(c.current().pollingUrl).toBe('https://ggui.example/api/sessions/s1/events?wsToken=tok-new');
  });

  it('reads a plain refusal as refused, with its code, and adopts nothing', async () => {
    const callTool = vi.fn(async (): Promise<unknown> => ({
      structuredContent: { ok: false, code: 'BOOTSTRAP_INVALID', message: 'bad signature' },
      content: [{ type: 'text', text: '{"ok":false,"code":"BOOTSTRAP_INVALID"}' }],
    }));
    const onAdopt = vi.fn();
    const c = createCredentialController({ initial: ROOT, callTool, onAdopt, ...noWait });
    expect(await c.onExpired(ROOT, 'ws')).toEqual({ kind: 'refused', code: 'BOOTSTRAP_INVALID' });
    expect(onAdopt).not.toHaveBeenCalled();
    expect(c.current()).toBe(ROOT);
  });

  it("reads the pull's not-found domain error as not-found", async () => {
    const callTool = vi.fn(async (): Promise<unknown> => ({
      isError: true,
      content: [{ type: 'text', text: 'session_not_found: no live session s1 for this caller' }],
    }));
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    expect(await c.onExpired(ROOT, 'ws')).toEqual({ kind: 'not-found' });
  });

  it('reads any other failure (a rejected relay, an unparsed error result) as a relay error', async () => {
    const rejecting = createCredentialController({
      initial: ROOT,
      callTool: vi.fn(async (): Promise<unknown> => {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      }),
      ...noWait,
    });
    expect(await rejecting.onExpired(ROOT, 'ws')).toEqual({ kind: 'relay-error', message: 'Method not found' });
    const opaque = createCredentialController({
      initial: ROOT,
      callTool: vi.fn(async (): Promise<unknown> => ({
        isError: true,
        content: [{ type: 'text', text: 'store read failed' }],
      })),
      ...noWait,
    });
    expect(await opaque.onExpired(ROOT, 'ws')).toEqual({ kind: 'relay-error', message: 'store read failed' });
  });
});

describe('credential controller: jitter', () => {
  it('waits a uniform random 0–5 s before a refresh on a post-drop trigger, and none on boot', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const onWs = createCredentialController({ initial: ROOT, callTool: okRelay(), sleep, random: () => 0.5 });
    await onWs.onExpired(ROOT, 'ws');
    const onBoot = createCredentialController({ initial: ROOT, callTool: okRelay(), sleep, random: () => 0.5 });
    await onBoot.onExpired(ROOT, 'boot');
    expect(waits).toEqual([2500]);
  });
});
