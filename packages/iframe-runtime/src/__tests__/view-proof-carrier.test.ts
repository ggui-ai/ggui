/**
 * ggui#1415 runtime items 4 and 8 — the carrier receipt. Every call site
 * that sends one of the three app-only runtime tools goes through the one
 * wrapper, so the outbound frame carries `params._meta["ai.ggui/view"]`,
 * and it is the ONLY key the runtime puts in `_meta`: a relay door refuses a
 * view call carrying an unknown `_meta` key. Checked on the real ext-apps
 * `App` over the mock transport for the App-mediated sends, and on the raw
 * `postMessage` for the two raw sends.
 *
 * Measured here, and not what the design first assumed: on an App-mediated
 * send the frame ALSO carries `_meta.progressToken`. ext-apps'
 * `callServerTool` always passes an `onprogress` handler, so the MCP SDK
 * stamps the standard MCP progress token on every such request, with or
 * without a proof; a card's own tool call carries it today. A raw send
 * carries the view key alone.
 *
 * The code-property half pins the wrapper at the source: any new
 * `callServerTool(...)` or raw `tools/call` that is not wrapped fails here
 * unless it is one of the two named exceptions, neither of which sends one
 * of the three tools.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import {
  MCP_APP_AI_GGUI_VIEW_META_KEY,
  VIEW_ORIGIN_UNPROVEN,
  parseViewProof,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  __resetAppForTest,
  __resetRelayNoticeForTest,
  bridgeCallToolVia,
  channelToolsCall,
  openLinkInParent,
  productionContextSnapshotPoster,
  requestDisplayModeInParent,
  routeDispatch,
  setCurrentApp,
} from '../runtime.js';
import { documentViewRoots } from '../view-origin.js';
import { defaultParams } from '../system-cards/ProtocolProbeCard.js';
import { __resetHostCapabilitiesForTest, setHostCapabilities } from '../host-capabilities.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
const APP_ID = 'carrier_app';
const rootFor = (sessionId: string): string =>
  Buffer.from(
    JSON.stringify({ sessionId, appId: APP_ID, kind: 'ws', iat: 100, exp: 280, jti: 'j', kid: 'k', src: 'result' }),
    'utf8',
  ).toString('base64url');

let postMessageSpy: ReturnType<typeof vi.fn>;
let originalPostMessage: typeof window.parent.postMessage;
let transport: MockTransport;
let app: App;

beforeEach(async () => {
  postMessageSpy = vi.fn();
  originalPostMessage = window.parent.postMessage;
  Object.defineProperty(window.parent, 'postMessage', { value: postMessageSpy, configurable: true, writable: true });
  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  Object.defineProperty(window.parent, 'postMessage', { value: originalPostMessage, configurable: true, writable: true });
  __resetAppForTest();
});

/** A session the document holds a root for. */
function provenSession(name: string): string {
  const sessionId = `carrier_${name}`;
  expect(documentViewRoots.offer(sessionId, { root: rootFor(sessionId), key: KEY })).toEqual({ adopted: true });
  return sessionId;
}

interface CallParams {
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly _meta?: Record<string, unknown>;
}

function paramsOfSent(tool: string): CallParams {
  const frames = transport.sent
    .map((m) => m as { method?: unknown; params?: CallParams })
    .filter((m) => m.method === 'tools/call' && m.params?.name === tool);
  expect(frames, `one tools/call ${tool} on the App transport`).toHaveLength(1);
  return frames[0]?.params ?? {};
}

function paramsOfPosted(tool: string): CallParams {
  const frames = postMessageSpy.mock.calls
    .map((c) => c[0] as { method?: unknown; params?: CallParams })
    .filter((m) => m.method === 'tools/call' && m.params?.name === tool);
  expect(frames, `one raw tools/call ${tool}`).toHaveLength(1);
  return frames[0]?.params ?? {};
}

/** `_meta` keys the MCP SDK stamps on an App-mediated request itself. */
const SDK_META_KEYS = ['progressToken'];

function expectOnlyTheViewProof(params: CallParams, sessionId: string, via: 'app' | 'raw'): void {
  const keys = Object.keys(params._meta ?? {}).sort();
  expect(keys).toEqual(via === 'app' ? [MCP_APP_AI_GGUI_VIEW_META_KEY, ...SDK_META_KEYS].sort() : [MCP_APP_AI_GGUI_VIEW_META_KEY]);
  const parsed = parseViewProof(params._meta?.[MCP_APP_AI_GGUI_VIEW_META_KEY] as string);
  if (!parsed.ok) throw new Error(`expected a proof, got ${parsed.reason}`);
  expect(parsed.proof.root).toBe(rootFor(sessionId));
  expect(parsed.proof.claims.sessionId).toBe(sessionId);
}

describe('the view proof rides every call site of the three tools (ggui#1415)', () => {
  it('a dispatch (App transport)', async () => {
    const sessionId = provenSession('dispatch');
    routeDispatch({
      actionName: 'archive',
      data: { id: 'msg_1' },
      meta: { sessionId, appId: APP_ID },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    const params = paramsOfSent('ggui_runtime_submit_action');
    expectOnlyTheViewProof(params, sessionId, 'app');
    expect(params.arguments).toMatchObject({ kind: 'dispatch', sessionId });
  });

  it('the openLink and requestDisplayMode audits (raw postMessage)', () => {
    const sessionId = provenSession('audit');
    openLinkInParent({ toolName: 'ggui_runtime_submit_action', url: 'https://example.com', sessionId, appId: APP_ID });
    expectOnlyTheViewProof(paramsOfPosted('ggui_runtime_submit_action'), sessionId, 'raw');
    postMessageSpy.mockClear();
    requestDisplayModeInParent({ toolName: 'ggui_runtime_submit_action', mode: 'fullscreen', sessionId, appId: APP_ID });
    expectOnlyTheViewProof(paramsOfPosted('ggui_runtime_submit_action'), sessionId, 'raw');
  });

  it('the context mirror (raw postMessage)', () => {
    const sessionId = provenSession('mirror');
    productionContextSnapshotPoster.postContextMirror({ sessionId, appId: APP_ID, snapshot: { draft: 'x' } });
    const params = paramsOfPosted('ggui_runtime_sync_context');
    expectOnlyTheViewProof(params, sessionId, 'raw');
    expect(params.arguments).toEqual({ sessionId, appId: APP_ID, snapshot: { draft: 'x' } });
  });

  it('the bridge pull (App transport)', async () => {
    const sessionId = provenSession('pull');
    void bridgeCallToolVia(app)('ggui_runtime_pull', { sessionId, sinceSequence: 0, wait: 25 });
    await tick();
    expectOnlyTheViewProof(paramsOfSent('ggui_runtime_pull'), sessionId, 'app');
  });

  it("the protocol probe card's submit-action call", () => {
    provenSession('probe');
    const params = defaultParams('tools/call') as CallParams;
    // The probe addresses its own fixed session, which no door keys: it
    // goes through the wrapper, and carries a proof only when a root exists.
    expect(params.name).toBe('ggui_runtime_submit_action');
    expect(params._meta).toBeUndefined();
    const probeSession = (params.arguments as { sessionId: string }).sessionId;
    documentViewRoots.offer(probeSession, { root: rootFor(probeSession), key: KEY });
    expectOnlyTheViewProof(defaultParams('tools/call') as CallParams, probeSession, 'raw');
  });

  it("a card's own tool through the channel carries no proof: only what the SDK stamps", async () => {
    const sessionId = provenSession('own-tool');
    void channelToolsCall({ toolName: 'acme_search', args: { sessionId, q: 'x' } }).catch(() => undefined);
    await tick();
    expect(Object.keys(paramsOfSent('acme_search')._meta ?? {})).toEqual(SDK_META_KEYS);
  });
});

describe('a dispatch answered VIEW_ORIGIN_UNPROVEN (ggui#1415, item 6)', () => {
  beforeEach(() => {
    __resetHostCapabilitiesForTest();
    __resetRelayNoticeForTest();
  });

  it('is a non-success: the error toast, no doorbell, and never the "cannot relay" latch', async () => {
    // No server answers with it at N; a later release will, for a required
    // dispatch without a valid proof. A result arrived, so the host DID
    // relay: this must never read as "this host cannot relay", even on a
    // host that advertised nothing.
    setHostCapabilities({});
    const sessionId = provenSession('unproven');
    transport.queueResponse('tools/call', {
      result: { structuredContent: { ok: false, code: VIEW_ORIGIN_UNPROVEN } },
    });
    routeDispatch({
      actionName: 'archive',
      data: {},
      meta: { sessionId, appId: APP_ID },
      dispatchToolName: 'ggui_runtime_submit_action',
    });
    await tick();
    await tick();

    const toast = document.getElementById('__ggui-action-toast__');
    expect(toast?.textContent).not.toMatch(/cannot relay|can't relay/i);
    expect(toast?.textContent).toMatch(/could not reach the agent/i);
    const methods = [
      ...transport.sent.map((m) => (m as { method?: unknown }).method),
      ...postMessageSpy.mock.calls.map((c) => (c[0] as { method?: unknown }).method),
    ];
    expect(methods).not.toContain('ui/message');

    // No latch: the channel router still attempts.
    transport.queueResponse('tools/call', { result: { structuredContent: { ok: true } } });
    await expect(channelToolsCall({ toolName: 'some_channel_tool', args: {} })).resolves.toEqual({ ok: true });
  });
});

describe('the wrapper is pinned at the source (ggui#1415)', () => {
  const SRC = join(__dirname, '..');
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((entry) => {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) return entry === '__tests__' ? [] : files(path);
      return /\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry) ? [path] : [];
    });

  /** The sends that never carry a proof, by their exact source text. */
  const UNWRAPPED = new Map<string, string>([
    ['credentialApp.callServerTool({ name, arguments: args })', 'the ws-token refresh: never one of the three tools'],
    ['telemetryApp.callServerTool(args)', 'runtime telemetry: never one of the three tools'],
    ["{ name: 'open_url', arguments: { url } }", 'a host intent: never one of the three tools'],
  ]);

  it('every callServerTool(...) and every raw tools/call goes through withViewProof, except the named three', () => {
    const offenders: string[] = [];
    const seenExceptions = new Set<string>();
    for (const file of files(SRC)) {
      const text = readFileSync(file, 'utf8');
      const where = relative(SRC, file);
      for (const match of text.matchAll(/(\w+)\.callServerTool\(([\s\S]{0,60})/g)) {
        const site = `${match[1]}.callServerTool(${match[2]}`;
        const exception = [...UNWRAPPED.keys()].find((k) => site.startsWith(k));
        if (exception !== undefined) seenExceptions.add(exception);
        else if (!match[2]?.startsWith('withViewProof(')) offenders.push(`${where}: ${site.split('\n')[0]}`);
      }
      for (const match of text.matchAll(/method: 'tools\/call',\s*params:\s*([\s\S]{0,60})/g)) {
        const site = match[1] ?? '';
        const exception = [...UNWRAPPED.keys()].find((k) => site.startsWith(k));
        if (exception !== undefined) seenExceptions.add(exception);
        else if (!site.startsWith('withViewProof(')) offenders.push(`${where}: raw tools/call ${site.split('\n')[0]}`);
      }
    }
    expect(offenders).toEqual([]);
    // A named exception that no longer exists is stale: delete it here.
    expect([...seenExceptions].sort()).toEqual([...UNWRAPPED.keys()].sort());
  });
});
