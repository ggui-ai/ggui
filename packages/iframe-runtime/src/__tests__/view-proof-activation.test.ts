/**
 * ggui#1415 runtime item 5 — a dispatch reads user activation at entry and
 * signs it as the proof's flag bit 0. jsdom exposes no
 * `navigator.userActivation`, so the reading is stubbed here, and only it:
 * the holder and the prover are the document's own.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { App } from '@modelcontextprotocol/ext-apps';
import { MCP_APP_AI_GGUI_VIEW_META_KEY, parseViewProof } from '@ggui-ai/protocol/integrations/mcp-apps';
import { __resetAppForTest, routeDispatch, setCurrentApp } from '../runtime.js';
import { documentViewRoots } from '../view-origin.js';
import { buildBootHarness, tick } from './boot-helpers.js';
import type { MockTransport } from './mock-transport.js';

const activation = vi.hoisted(() => ({ active: false }));
vi.mock('../view-origin.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../view-origin.js')>()),
  userActivationIsActive: () => activation.active,
}));

const KEY = 'K-7dUBMeCtprxv4DED-VUuAjEBHGqoaWA-hHgh5t12A';
let transport: MockTransport;
let app: App;

beforeEach(async () => {
  const harness = buildBootHarness();
  transport = harness.transport;
  app = harness.app;
  await app.connect(transport);
  setCurrentApp(app);
});

afterEach(() => {
  __resetAppForTest();
});

async function dispatchFlags(sessionId: string): Promise<string | undefined> {
  const root = Buffer.from(
    JSON.stringify({ sessionId, appId: 'app_1', kind: 'ws', iat: 100, exp: 280, jti: 'j', kid: 'k' }),
    'utf8',
  ).toString('base64url');
  documentViewRoots.offer(sessionId, { root, key: KEY });
  routeDispatch({ actionName: 'archive', data: {}, meta: { sessionId, appId: 'app_1' }, dispatchToolName: 'ggui_runtime_submit_action' });
  await tick();
  const frame = transport.sent
    .map((m) => m as { method?: unknown; params?: { name?: unknown; _meta?: Record<string, unknown> } })
    .find((m) => m.method === 'tools/call' && m.params?.name === 'ggui_runtime_submit_action');
  const parsed = parseViewProof(frame?.params?._meta?.[MCP_APP_AI_GGUI_VIEW_META_KEY] as string);
  return parsed.ok ? parsed.proof.flags : undefined;
}

describe('a dispatch signs the user activation it read at entry (ggui#1415)', () => {
  it('flag bit 0 set when the gesture carried activation', async () => {
    activation.active = true;
    expect(await dispatchFlags('act_on')).toBe('1');
  });

  it('flag bit 0 clear when it did not', async () => {
    activation.active = false;
    expect(await dispatchFlags('act_off')).toBe('0');
  });
});
