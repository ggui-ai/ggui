/**
 * Phase 2 (boot-consolidation) — `buildGguiSessionSeedInput` projection.
 *
 * Projects the inline `__GGUI_META__` bootstrap into a `GguiSessionSeedInput`
 * the unified mount surface can paint BEFORE the authoritative wire
 * `GguiSession` arrives (or with no WS at all, for spec-compliant MCP-Apps
 * hosts). BLOCKER #2 from the Workflow-1 audit: building a full `GguiSession`
 * from meta alone would require fabricating the 4 server-assigned ledger
 * fields (banned). The seed carries only what the meta honestly provides;
 * the first ack reconciles to a full `GguiSession`.
 *
 * Pure projection — no mount, no React.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';

const posted = vi.hoisted((): unknown[] => []);
vi.mock('../observability.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../observability.js')>()),
  postObservabilityToParent: (event: unknown) => posted.push(event),
}));
import type { ActionSpec } from '@ggui-ai/protocol';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { WebSocketMessage } from '@ggui-ai/protocol/transport/websocket';
import {
  buildGguiSessionSeedInput,
  hasStaticContentMeta,
  readPendingToolResults,
} from '../runtime.js';
import { buildRootWireConfig, StreamBus } from '../wire-config.js';

const BASE: McpAppAiGguiRenderMeta = {
  sessionId: 'render_seed_1',
  appId: 'app_001',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildGguiSessionSeedInput', () => {
  it('projects a system-card seed from `kind` (no fetch)', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      kind: 'no-credentials',
      propsJson: JSON.stringify({ reason: 'missing key' }),
    });
    expect(seed).not.toBeNull();
    expect(seed).toMatchObject({
      id: 'render_seed_1',
      appId: 'app_001',
      type: 'system',
      kind: 'no-credentials',
      props: { reason: 'missing key' },
    });
  });

  it('projects a compiled-component seed from `codeUrl` (fetches bytes)', async () => {
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      text: async () => 'export default function C(){return null}',
    }));
    vi.stubGlobal('fetch', fetchMock);

    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeUrl: 'http://localhost:7000/code/abc.js',
      propsJson: JSON.stringify({ count: 3 }),
    });
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:7000/code/abc.js');
    expect(seed).not.toBeNull();
    expect(seed).toMatchObject({
      id: 'render_seed_1',
      appId: 'app_001',
      componentCode: 'export default function C(){return null}',
      props: { count: 3 },
    });
    // A component seed must NOT carry a `type:'system'` discriminator.
    expect((seed as { type?: string }).type).toBeUndefined();
  });

  it('projects a compiled-component seed from `codeB64` with NO fetch', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const source = 'export default function C(){return "café ☕"}';
    const codeB64 = Buffer.from(source, 'utf8').toString('base64');

    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64,
      propsJson: JSON.stringify({ n: 1 }),
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seed).toMatchObject({
      id: 'render_seed_1',
      appId: 'app_001',
      componentCode: source,
      props: { n: 1 },
    });
    expect((seed as { type?: string }).type).toBeUndefined();
  });

  it('prefers the inline codeB64 bytes over codeUrl when both are present', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const source = 'export default function Inline(){return null}';

    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: Buffer.from(source, 'utf8').toString('base64'),
      codeUrl: 'http://localhost:7000/code/abc.js',
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(seed).toMatchObject({ componentCode: source });
  });

  it('throws a field-labeled error on malformed codeB64', async () => {
    await expect(
      buildGguiSessionSeedInput({ ...BASE, codeB64: '!!not-base64!!' }),
    ).rejects.toThrow(/codeB64 is not valid base64/);
  });

  it('returns null for a live-only meta (no codeUrl, no kind)', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      wsUrl: 'ws://localhost:7000/ws',
      wsToken: 'tok_x',
    });
    expect(seed).toBeNull();
  });

  it('skips props on malformed propsJson (shape-preserving, no throw)', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      kind: 'mcp-apps-probe',
      propsJson: '{ not valid json',
    });
    expect(seed).not.toBeNull();
    expect((seed as { props?: unknown }).props).toBeUndefined();
  });

  it('hasStaticContentMeta counts codeB64 as static content (the bootSequence mount gate)', () => {
    // The claude.ai shape: codeB64 + a live trio the iframe can never
    // connect. The static seed-mount path MUST run — a discriminator
    // missing the inline arm skips the only paint path and dies on the
    // dead WS. Pin all three arms + the live-only negative.
    const live = { ...BASE, wsUrl: 'wss://x/ws', wsToken: 't' };
    expect(hasStaticContentMeta({ ...live, codeB64: 'ZXhwb3J0' })).toBe(true);
    expect(hasStaticContentMeta({ ...BASE, codeB64: 'ZXhwb3J0' })).toBe(true);
    expect(hasStaticContentMeta({ ...BASE, codeUrl: 'https://x/c.js' })).toBe(true);
    expect(hasStaticContentMeta({ ...BASE, kind: 'no-credentials' })).toBe(true);
    expect(hasStaticContentMeta(live)).toBe(false);
    expect(hasStaticContentMeta({ ...BASE, codeB64: '' })).toBe(false);
  });

  it('throws when the codeUrl fetch fails (caller surfaces a typed boot failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
    );
    await expect(
      buildGguiSessionSeedInput({ ...BASE, codeUrl: 'http://localhost:7000/code/missing.js' }),
    ).rejects.toThrow(/codeUrl fetch failed \(404\)/);
  });
});

// ggui#1178 — the seed half. A mount with no live session frame (past the WS
// token's TTL, a host with no live channel, or the pre-WS window) paints from
// this seed, and the one-shot guard reads the CURRENT render's actionSpec. A
// seed that dropped the slice's spec left that mount unable to enforce
// `oneShot`. Pinned here: a component seed carries the slice's spec whole, a
// system seed never does, a slice without one leaves the key absent, and a seed
// mounted as the current render stops a second one-shot gesture.
describe('buildGguiSessionSeedInput — the slice’s actionSpec (ggui#1178)', () => {
  const SPEC: ActionSpec = {
    submit: { label: 'Submit', oneShot: true, nextStep: 'record_answer' },
    cancel: { label: 'Cancel' },
  };
  const SOURCE = 'export default function C(){return null}';

  it('a codeB64 component seed carries the slice’s actionSpec whole', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: Buffer.from(SOURCE, 'utf8').toString('base64'),
      actionSpec: SPEC,
    });
    expect(seed).not.toBeNull();
    if (seed === null || seed.type === 'system') throw new Error('expected a component seed');
    expect(seed.actionSpec).toEqual(SPEC);
  });

  it('a codeUrl component seed carries the slice’s actionSpec whole', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, text: async () => SOURCE })),
    );
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeUrl: 'http://localhost:7000/code/abc.js',
      actionSpec: SPEC,
    });
    expect(seed).not.toBeNull();
    if (seed === null || seed.type === 'system') throw new Error('expected a component seed');
    expect(seed.actionSpec).toEqual(SPEC);
  });

  it('a slice with no actionSpec leaves the key absent (never an empty spec)', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: Buffer.from(SOURCE, 'utf8').toString('base64'),
    });
    expect(seed).not.toBeNull();
    expect(seed !== null && 'actionSpec' in seed).toBe(false);
  });

  it('a system seed never carries one, even when the slice does', async () => {
    const seed = await buildGguiSessionSeedInput({ ...BASE, kind: 'no-credentials', actionSpec: SPEC });
    expect(seed).not.toBeNull();
    expect(seed !== null && 'actionSpec' in seed).toBe(false);
  });

  it('mounted as the current render, the seed stops a second one-shot gesture — and names nothing unenforceable', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    posted.length = 0;
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: Buffer.from(SOURCE, 'utf8').toString('base64'),
      actionSpec: SPEC,
    });
    const sent: WebSocketMessage[] = [];
    const cfg = buildRootWireConfig({
      sessionId: BASE.sessionId,
      appId: BASE.appId,
      getCurrentGguiSession: () => seed,
      manager: { send: (msg: WebSocketMessage) => sent.push(msg) },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', {});
    cfg.dispatch('submit', {});

    expect(sent, 'the second one-shot gesture never reaches the transport').toHaveLength(1);
    const unenforceable = posted.filter(
      (e) => typeof e === 'object' && e !== null && 'kind' in e && e.kind === 'one-shot-unenforceable',
    );
    expect(unenforceable).toEqual([]);
    warn.mockRestore();
  });
});

// ggui#1223 — the slice carries the card's `epoch` and the `oneShot` names this
// card already spent (projected by `deriveRenderMeta` for this card only). A
// component seed carries them as the render's record, `{ epoch, actions }`, so
// the wire guard can stop the first gesture on a spent action after a reload.
describe('buildGguiSessionSeedInput — the slice’s spent oneShots (ggui#1223)', () => {
  const SPEC: ActionSpec = { submit: { label: 'Submit', oneShot: true } };
  const B64 = Buffer.from('export default function C(){return null}', 'utf8').toString('base64');

  it('a component seed carries the card’s epoch and its spent names as the record', async () => {
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: B64,
      actionSpec: SPEC,
      epoch: 2,
      spentOneShots: ['submit'],
    });
    if (seed === null || seed.type === 'system') throw new Error('expected a component seed');
    expect(seed.epoch).toBe(2);
    expect(seed.spentOneShots).toEqual({ epoch: 2, actions: ['submit'] });
  });

  it('an absent slice epoch is 0 on the record, matching the absent render epoch', async () => {
    const seed = await buildGguiSessionSeedInput({ ...BASE, codeB64: B64, spentOneShots: ['submit'] });
    if (seed === null || seed.type === 'system') throw new Error('expected a component seed');
    expect(seed.spentOneShots).toEqual({ epoch: 0, actions: ['submit'] });
    expect('epoch' in seed).toBe(false);
  });

  it('a slice with no spent names leaves the record absent; a system seed never has one', async () => {
    const component = await buildGguiSessionSeedInput({ ...BASE, codeB64: B64 });
    expect(component !== null && 'spentOneShots' in component).toBe(false);
    const system = await buildGguiSessionSeedInput({ ...BASE, kind: 'no-credentials', spentOneShots: ['submit'] });
    expect(system !== null && 'spentOneShots' in system).toBe(false);
  });

  it('mounted as the current render after a reload, the seed stops the FIRST gesture on a spent oneShot', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const seed = await buildGguiSessionSeedInput({
      ...BASE,
      codeB64: B64,
      actionSpec: SPEC,
      epoch: 1,
      spentOneShots: ['submit'],
    });
    const sent: WebSocketMessage[] = [];
    const cfg = buildRootWireConfig({
      sessionId: BASE.sessionId,
      appId: BASE.appId,
      getCurrentGguiSession: () => seed,
      manager: { send: (msg: WebSocketMessage) => sent.push(msg) },
      streamBus: new StreamBus(),
    });

    cfg.dispatch('submit', {});

    expect(sent, 'the consumed action does not reach the agent again').toEqual([]);
    warn.mockRestore();
  });
});

describe('readPendingToolResults — buffered-tool-result supersede order', () => {
  const toolResult = (propsJson: string) => ({
    content: [],
    _meta: {
      'ai.ggui/render': {
        sessionId: 'render_buf',
        appId: 'app_001',
        runtimeUrl: '/_ggui/iframe-runtime.js',
        codeB64: 'ZXhwb3J0',
        propsJson,
      },
    },
  });

  afterEach(() => {
    delete (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__?: unknown })
      .__GGUI_PENDING_TOOL_RESULTS__;
  });

  it('returns the NEWEST valid buffered meta — a render + follow-up update buffered during bundle parse boots on the update', () => {
    (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__: unknown[] })
      .__GGUI_PENDING_TOOL_RESULTS__ = [
      toolResult('{"n":1}'),
      toolResult('{"n":2}'),
    ];
    expect(readPendingToolResults()?.propsJson).toBe('{"n":2}');
  });

  it('skips invalid newest entries and falls back to the newest VALID one', () => {
    (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__: unknown[] })
      .__GGUI_PENDING_TOOL_RESULTS__ = [
      toolResult('{"n":1}'),
      { content: [], _meta: {} },
    ];
    expect(readPendingToolResults()?.propsJson).toBe('{"n":1}');
  });

  it('returns null for an absent or empty buffer', () => {
    expect(readPendingToolResults()).toBeNull();
    (window as unknown as { __GGUI_PENDING_TOOL_RESULTS__: unknown[] })
      .__GGUI_PENDING_TOOL_RESULTS__ = [];
    expect(readPendingToolResults()).toBeNull();
  });
});
