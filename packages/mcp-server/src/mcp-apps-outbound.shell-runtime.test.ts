/**
 * ggui#1302: the self-hosted thin MCP-Apps shell never waits silently.
 *
 * These tests EXECUTE the served shell script: the exact bytes inside
 * `GGUI_RENDER_SHELL_HTML`'s `<script>`, extracted the way the CSP-hash drift
 * test does. They run in a `vm` context whose `window.parent.postMessage` is a
 * recorder, so the shell is driven the way a host drives it, and every wait is
 * read off fake timers.
 *
 * The bounds mirror the hosted runtime (`iframe-runtime` runtime.ts,
 * `POSTMESSAGE_BOOT_TIMEOUT_MS = 30_000`, failing `MISSING_META_GGUI_BOOTSTRAP`),
 * so the two shells cannot disagree on what a host that never answers sees.
 */
import vm from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCP_APP_BOOTSTRAP_FAILED_TYPE } from '@ggui-ai/protocol/integrations/mcp-apps';
import { GGUI_RENDER_SHELL_HTML } from './mcp-apps-outbound.js';

interface Posted {
  readonly jsonrpc?: string;
  readonly id?: number;
  readonly method?: string;
  readonly params?: { readonly uri?: string };
  readonly type?: string;
  readonly reason?: string;
  readonly message?: string;
}

interface FakeElement {
  innerHTML: string;
  style: { cssText: string };
  onclick: (() => void) | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  src: string;
  type: string;
  crossOrigin: string;
}

function fakeElement(): FakeElement {
  return { innerHTML: '', style: { cssText: '' }, onclick: null, onload: null, onerror: null, src: '', type: '', crossOrigin: '' };
}

function shellScript(): string {
  const m = GGUI_RENDER_SHELL_HTML.match(/<script>([\s\S]*?)<\/script>/);
  if (m === null || m[1] === undefined) throw new Error('the served shell has no inline <script>');
  return m[1];
}

function bootShell() {
  // A failure filter keyed on an undefined constant matches every message
  // without a `type`, which reads as a flood of failures (bought on this
  // file's first run). Refuse to run on it.
  expect(MCP_APP_BOOTSTRAP_FAILED_TYPE, 'the failure message type is defined').toBe('ggui:bootstrap-failed');
  const posted: Posted[] = [];
  const listeners: Array<(ev: { data: object }) => void> = [];
  const root = fakeElement();
  const appended: FakeElement[] = [];
  const doc = {
    getElementById: (id: string) => (id === 'ggui-root' ? root : null),
    createElement: () => fakeElement(),
    head: { appendChild: (el: FakeElement) => appended.push(el) },
    body: { appendChild: (el: FakeElement) => appended.push(el) },
  };
  const win = {
    parent: { postMessage: (msg: Posted) => posted.push(msg) },
    addEventListener: (type: string, fn: (ev: { data: object }) => void) => {
      if (type === 'message') listeners.push(fn);
    },
  };
  const context = vm.createContext({
    window: win,
    document: doc,
    // Late-bound so vitest's fake timers (installed on the global) are the ones used.
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: ReturnType<typeof setTimeout>) => clearTimeout(h),
    JSON,
    Promise,
    Error,
    String,
    console,
  });
  vm.runInContext(shellScript(), context);
  const deliver = (data: object): void => listeners.forEach((fn) => fn({ data }));
  const rpc = (method: string): Posted | undefined => posted.find((p) => p.method === method && p.id !== undefined);
  const failures = (): Posted[] => posted.filter((p) => p.type === MCP_APP_BOOTSTRAP_FAILED_TYPE);
  return { posted, root, appended, deliver, rpc, failures };
}

/** Answer the shell's `ui/initialize` so it moves on to waiting for the tool result. */
async function completeInit(shell: ReturnType<typeof bootShell>): Promise<void> {
  const init = shell.rpc('ui/initialize');
  expect(init, 'the shell opens with ui/initialize').toBeDefined();
  shell.deliver({ jsonrpc: '2.0', id: init?.id, result: {} });
  await vi.advanceTimersByTimeAsync(0);
}

const LOCATOR = 'ui://ggui/render/abc';

describe('the thin shell never waits silently (ggui#1302)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a host that never sends the tool result: after 30 s, a failure card and MISSING_META_GGUI_BOOTSTRAP', async () => {
    const shell = bootShell();
    await completeInit(shell);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(shell.failures(), 'nothing fails before the bound').toEqual([]);
    await vi.advanceTimersByTimeAsync(1_001);
    const [failure] = shell.failures();
    expect(failure?.reason).toBe('MISSING_META_GGUI_BOOTSTRAP');
    expect(shell.root.innerHTML).toContain('This view did not receive its content');
  });

  it('a tool result that arrives in time cancels the bound', async () => {
    const shell = bootShell();
    await completeInit(shell);
    shell.deliver({
      jsonrpc: '2.0',
      method: 'ui/notifications/tool-result',
      params: { _meta: { 'ai.ggui/render': { runtimeUrl: 'https://example.test/rt.js' } } },
    });
    await vi.advanceTimersByTimeAsync(31_000);
    expect(shell.failures()).toEqual([]);
  });

  it('a door read the host never answers falls through to the wait, then fails naming READ_DOOR_FAILED', async () => {
    const shell = bootShell();
    await completeInit(shell);
    shell.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { resourceUri: LOCATOR } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.rpc('resources/read')?.params?.uri).toBe(LOCATOR);
    await vi.advanceTimersByTimeAsync(30_001);
    expect(shell.failures(), 'the door miss itself fails nothing: it falls through').toEqual([]);
    await vi.advanceTimersByTimeAsync(30_001);
    const [failure] = shell.failures();
    expect(failure?.reason).toBe('MISSING_META_GGUI_BOOTSTRAP');
    expect(failure?.message).toContain('READ_DOOR_FAILED');
  });

  it('a rejected door read no longer reports MALFORMED_BOOTSTRAP', async () => {
    const shell = bootShell();
    await completeInit(shell);
    shell.deliver({ jsonrpc: '2.0', method: 'ui/notifications/tool-result', params: { structuredContent: { resourceUri: LOCATOR } } });
    await vi.advanceTimersByTimeAsync(0);
    shell.deliver({ jsonrpc: '2.0', id: shell.rpc('resources/read')?.id, error: { code: -32603, message: 'read refused' } });
    await vi.advanceTimersByTimeAsync(30_001);
    const reasons = shell.failures().map((f) => f.reason);
    expect(reasons).not.toContain('MALFORMED_BOOTSTRAP');
    expect(reasons).toEqual(['MISSING_META_GGUI_BOOTSTRAP']);
    expect(shell.failures()[0]?.message).toContain('read refused');
  });

  it('a host that never answers ui/initialize: the 3 s timeout posts UI_INITIALIZE_FAILED', async () => {
    const shell = bootShell();
    await vi.advanceTimersByTimeAsync(3_001);
    expect(shell.failures().map((f) => f.reason)).toEqual(['UI_INITIALIZE_FAILED']);
  });

  it('a host that rejects ui/initialize: the failure posts UI_INITIALIZE_FAILED', async () => {
    const shell = bootShell();
    shell.deliver({ jsonrpc: '2.0', id: shell.rpc('ui/initialize')?.id, error: { code: -32601, message: 'no' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(shell.failures().map((f) => f.reason)).toEqual(['UI_INITIALIZE_FAILED']);
  });
});
