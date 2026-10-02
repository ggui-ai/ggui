/**
 * ggui#1679 — the row's Done line: a card whose component throws past the
 * boundary's retries produces ONE `ggui_runtime_report_render_failure` on the
 * App transport, carrying the view proof the server records against.
 *
 * The chain under test is the production one minus the boot: `mountRender`
 * (the single-render mount surface) → the boundary's give-up →
 * `onRenderFailure` → the reporter → `bridgeCallToolVia(app)` (the proof
 * carrier every runtime tool call rides, ggui#1415) → the transport. The
 * control mounts a card that recovers within the retries and asserts the
 * tool path stays silent.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { App } from '@modelcontextprotocol/ext-apps';
import type { GguiSession } from '@ggui-ai/protocol';
import { MCP_APP_AI_GGUI_VIEW_META_KEY, parseViewProof } from '@ggui-ai/protocol/integrations/mcp-apps';
import { __resetAppForTest, bridgeCallToolVia, setCurrentApp } from '../runtime.js';
import { mountRender } from '../render-item.js';
import { createRenderFailureReporter } from '../render-failure-report.js';
import { StreamBus } from '../wire-config.js';
import { documentViewRoots } from '../view-origin.js';
import { buildBootHarness } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
const APP_ID = 'app_1679_proof';
const RETRY_WAIT_MS = 650;
const TOOL = 'ggui_runtime_report_render_failure';

const rootFor = (sessionId: string): string =>
  Buffer.from(
    JSON.stringify({ sessionId, appId: APP_ID, kind: 'ws', iat: 100, exp: 280, jti: 'j', kid: 'k', src: 'result' }),
    'utf8',
  ).toString('base64url');

let transport: MockTransport;
let app: App;

// React reports a card that threw and then painted on its own synchronous
// re-render through `reportError` — here a cancelable `ErrorEvent` on
// `window`. Captured so the run stays clean, and so the control can show the
// card did throw.
const recovered: unknown[] = [];
const captureRecoverable = (event: ErrorEvent): void => {
  if (String(event.message).includes('able to recover')) {
    recovered.push(event.error);
    event.preventDefault();
  }
};

beforeEach(async () => {
  recovered.length = 0;
  window.addEventListener('error', captureRecoverable);
  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  window.removeEventListener('error', captureRecoverable);
  __resetAppForTest();
});

function makeContainer(): HTMLElement {
  const el = document.createElement('div');
  document.body.appendChild(el);
  return el;
}

async function flush(fn: () => Promise<unknown>): Promise<void> {
  await act(async () => {
    await fn();
  });
}

function componentRender(id: string, componentCode: string): GguiSession {
  return {
    id,
    appId: APP_ID,
    componentCode,
    props: {},
    eventSequence: 0,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    expiresAt: Date.now() + 60_000,
  };
}

interface CallParams {
  readonly name?: unknown;
  readonly arguments?: unknown;
  readonly _meta?: Record<string, unknown>;
}

function reportFrames(): CallParams[] {
  return transport.sent
    .map((m) => m as { method?: unknown; params?: CallParams })
    .filter((m) => m.method === 'tools/call' && m.params?.name === TOOL)
    .map((m) => m.params ?? {});
}

async function mountAndWait(sessionId: string, code: string): Promise<void> {
  expect(documentViewRoots.offer(sessionId, { root: rootFor(sessionId), key: KEY })).toEqual({ adopted: true });
  const reporter = createRenderFailureReporter({ sessionId, appId: APP_ID, callTool: bridgeCallToolVia(app) });
  const container = makeContainer();
  let handle: Awaited<ReturnType<typeof mountRender>> | null = null;
  await flush(async () => {
    handle = await mountRender(container, {
      render: componentRender(sessionId, code),
      scopedWireConfig: null,
      streamBus: new StreamBus(),
      sessionId,
      onError: vi.fn(),
      onRenderFailure: reporter.report,
    });
  });
  await flush(() => new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS)));
  handle!.unmount();
}

describe('a card that throws past the retries is reported once, with its proof (ggui#1679)', () => {
  it('one tools/call ggui_runtime_report_render_failure rides the App transport with the view proof and ids + counts only', async () => {
    const sessionId = 'render_1679_throws';
    await mountAndWait(sessionId, 'export default () => { throw new RangeError("boom: a message that must not travel"); }');

    const frames = reportFrames();
    expect(frames).toHaveLength(1);
    expect(frames[0]?.arguments).toEqual({ sessionId, appId: APP_ID, phase: 'mount', errorName: 'RangeError', catches: 2 });
    const proof = parseViewProof(frames[0]?._meta?.[MCP_APP_AI_GGUI_VIEW_META_KEY] as string);
    if (!proof.ok) throw new Error(`expected a proof, got ${proof.reason}`);
    expect(proof.proof.claims.sessionId).toBe(sessionId);
    expect(JSON.stringify(frames)).not.toContain('must not travel');
  });

  it('control: a card the boundary catches once and that paints on the retry sends nothing on the tool path', async () => {
    const sessionId = 'render_1679_recovers';
    // Two throws: React's own synchronous re-render absorbs one before the boundary sees it.
    await mountAndWait(sessionId, 'let n = 0; export default () => { if (n++ < 2) throw new Error("twice"); return null; }');

    expect(reportFrames()).toHaveLength(0);
    expect(recovered.length).toBeGreaterThan(0);
  });

  // `bootProduction` dynamic-imports the full React graph and is too heavy to
  // boot here (the house precedent: ggui#1536's toast wiring), so the one hop
  // the chain above does not run — the boot handing the reporter to every
  // mount — is pinned at the source.
  it("bootProduction builds one reporter per boot from the envelope's ids over the proof-carrying bridge, and hands it to every mount", () => {
    const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime.ts'), 'utf8').replace(/\s+/g, ' ');
    expect(source).toContain(
      'const renderFailureReporter = createRenderFailureReporter({ sessionId: meta.sessionId, appId: meta.appId, callTool: (name, args) => { const bridge = getCurrentApp();',
    );
    expect(source).toContain('return bridgeCallToolVia(bridge)(name, args);');
    const buildOpts = source.indexOf('const buildOpts = (render: GguiSession | GguiSessionSeedInput): RenderItemOptions => {');
    expect(buildOpts).toBeGreaterThan(-1);
    const end = source.indexOf('}; };', buildOpts);
    expect(source.slice(buildOpts, end)).toContain('onRenderFailure: renderFailureReporter.report,');
  });
});
