/**
 * ggui#1496 part B (runtime) — the credential controller: the view's
 * held credential, its one-refresh budget, and the refresh over the
 * host's `tools/call` relay. Pure: the relay and the clock are injected.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  BRIDGE_REFRESH_INTERVAL_MS,
  REFRESH_RELAY_ERROR_RETRIES,
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

describe('credential controller: the boot refresh retries a relay error (F6)', () => {
  /** A relay that fails `failures` times, then answers with a new envelope. */
  function flakyRelay(failures: number) {
    let calls = 0;
    const fn = vi.fn(async (): Promise<unknown> => {
      calls += 1;
      if (calls <= failures) throw new Error(`relay down (${calls})`);
      return { structuredContent: { ok: true, envelope: 'tok-new', expiresAt: '2026-09-28T01:00:00.000Z' } };
    });
    return fn;
  }

  it('retries a relay error twice, each after a uniform 1–3 s wait, inside the one budgeted request', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const callTool = flakyRelay(2);
    const c = createCredentialController({ initial: ROOT, callTool, sleep, random: () => 0.5 });
    const outcome = await c.onExpired(ROOT, 'boot', { retries: REFRESH_RELAY_ERROR_RETRIES });
    expect(REFRESH_RELAY_ERROR_RETRIES).toBe(2);
    expect(outcome.kind).toBe('adopted');
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(waits).toEqual([2000, 2000]);
  });

  it('bounds the wait between 1 s and 3 s', async () => {
    const waits: number[] = [];
    const sleep = async (ms: number): Promise<void> => {
      waits.push(ms);
    };
    const low = createCredentialController({ initial: ROOT, callTool: flakyRelay(1), sleep, random: () => 0 });
    await low.onExpired(ROOT, 'boot', { retries: 1 });
    const high = createCredentialController({ initial: ROOT, callTool: flakyRelay(1), sleep, random: () => 0.999 });
    await high.onExpired(ROOT, 'boot', { retries: 1 });
    expect(waits[0]).toBe(1000);
    expect(waits[1]).toBeGreaterThanOrEqual(2990);
    expect(waits[1]).toBeLessThan(3000);
  });

  it('gives up after the retries with the last relay error, and the credential stays spent', async () => {
    const callTool = flakyRelay(5);
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    expect(await c.onExpired(ROOT, 'boot', { retries: 2 })).toEqual({ kind: 'relay-error', message: 'relay down (3)' });
    expect(callTool).toHaveBeenCalledTimes(3);
    expect(await c.onExpired(ROOT, 'ws')).toEqual({ kind: 'skipped', reason: 'budget' });
  });

  it('never retries a definitive answer: a refusal or a not-found ends the request at once', async () => {
    const refusing = vi.fn(async (): Promise<unknown> => ({
      structuredContent: { ok: false, code: 'BOOTSTRAP_NOT_SUPPORTED', message: 'no refresh here' },
    }));
    const c = createCredentialController({ initial: ROOT, callTool: refusing, ...noWait });
    expect(await c.onExpired(ROOT, 'boot', { retries: 2 })).toEqual({ kind: 'refused', code: 'BOOTSTRAP_NOT_SUPPORTED' });
    expect(refusing).toHaveBeenCalledTimes(1);
  });

  it('without a retry option, a relay error ends the request at once (the post-drop triggers)', async () => {
    const callTool = flakyRelay(1);
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait });
    expect((await c.onExpired(ROOT, 'ws')).kind).toBe('relay-error');
    expect(callTool).toHaveBeenCalledTimes(1);
  });
});

describe("credential controller: the bridge rung's attempt clock (ggui#1734)", () => {
  /** ROOT's own `expiresAt`, as the view's clock reads it. */
  const AT_EXPIRY = Date.parse(ROOT.expiresAt ?? '');
  /** A clock the test moves. */
  function clock(start: number): { readonly now: () => number; readonly set: (t: number) => void } {
    let t = start;
    return {
      now: () => t,
      set: (next) => {
        t = next;
      },
    };
  }
  /** A relay that rejects every call: the outage that opened a host's pull circuit. */
  const down = () =>
    vi.fn(async (): Promise<unknown> => {
      throw new Error('relay down');
    });

  it("is the server's default credential lifetime", () => {
    expect(BRIDGE_REFRESH_INTERVAL_MS).toBe(180_000);
  });

  it('asks again from the bridge rung one interval after a failed attempt, whatever it answered', async () => {
    const k = clock(AT_EXPIRY);
    const callTool = down();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait, now: k.now });
    expect(c.dueOnBridge(ROOT)).toBe(true);
    expect((await c.onExpired(ROOT, 'bridge')).kind).toBe('relay-error');
    k.set(AT_EXPIRY + BRIDGE_REFRESH_INTERVAL_MS - 1);
    expect(c.dueOnBridge(ROOT)).toBe(false);
    expect(await c.onExpired(ROOT, 'bridge')).toEqual({ kind: 'skipped', reason: 'budget' });
    k.set(AT_EXPIRY + BRIDGE_REFRESH_INTERVAL_MS);
    expect(c.dueOnBridge(ROOT)).toBe(true);
    expect((await c.onExpired(ROOT, 'bridge')).kind).toBe('relay-error');
    expect(callTool).toHaveBeenCalledTimes(2);
  });

  it('refreshes an unaccepted refreshed credential again from the bridge once its own expiresAt has passed, and not before', async () => {
    const k = clock(AT_EXPIRY);
    const callTool = okRelay(); // adopts tok-new, which expires one hour after ROOT
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait, now: k.now });
    await c.onExpired(ROOT, 'ws');
    const refreshed = c.current();
    expect(refreshed.origin).toBe('refreshed');
    k.set(AT_EXPIRY + 30 * 60_000); // the interval has passed; the credential has not expired
    expect(c.dueOnBridge(refreshed)).toBe(false);
    expect(await c.onExpired(refreshed, 'bridge')).toEqual({ kind: 'skipped', reason: 'budget' });
    k.set(AT_EXPIRY + 60 * 60_000); // tok-new's own expiresAt
    expect(c.dueOnBridge(refreshed)).toBe(true);
    callTool.mockImplementation(okRelay('tok-third'));
    expect((await c.onExpired(refreshed, 'bridge')).kind).toBe('adopted');
    expect(c.current().wsToken).toBe('tok-third');
    expect(c.dueOnBridge(refreshed)).toBe(false); // no longer current
  });

  it('keeps the loop guard on the token rungs: the same expired credential is still never re-asked from a WS or polling refusal', async () => {
    const k = clock(AT_EXPIRY);
    const callTool = okRelay();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait, now: k.now });
    await c.onExpired(ROOT, 'ws');
    const refreshed = c.current();
    k.set(AT_EXPIRY + 60 * 60_000);
    expect(await c.onExpired(refreshed, 'ws')).toEqual({ kind: 'skipped', reason: 'budget' });
    expect(await c.onExpired(refreshed, 'polling')).toEqual({ kind: 'skipped', reason: 'budget' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("counts the interval from the last attempt on ANY rung, so a WS refusal's refresh and the demoted ladder's first bridge tick are one request", async () => {
    const k = clock(AT_EXPIRY);
    const callTool = down();
    const c = createCredentialController({ initial: ROOT, callTool, ...noWait, now: k.now });
    expect((await c.onExpired(ROOT, 'ws')).kind).toBe('relay-error');
    k.set(AT_EXPIRY + 1_000);
    expect(c.dueOnBridge(ROOT)).toBe(false);
    expect(await c.onExpired(ROOT, 'bridge')).toEqual({ kind: 'skipped', reason: 'budget' });
    expect(callTool).toHaveBeenCalledTimes(1);
  });

  it("is never due for a credential that has not expired by the view's clock, or that carries no expiresAt", async () => {
    const k = clock(AT_EXPIRY - 1);
    const c = createCredentialController({ initial: ROOT, callTool: okRelay(), ...noWait, now: k.now });
    expect(c.dueOnBridge(ROOT)).toBe(false);
    expect(await c.onExpired(ROOT, 'bridge')).toEqual({ kind: 'skipped', reason: 'budget' });
    const { expiresAt: _omitted, ...bare } = ROOT;
    const c2 = createCredentialController({ initial: bare, callTool: okRelay(), ...noWait, now: k.now });
    expect(c2.dueOnBridge(bare)).toBe(false);
  });
});
