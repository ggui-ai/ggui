/**
 * Phase 2 (boot-consolidation) — `buildRenderSeedInput` projection.
 *
 * Projects the inline `__GGUI_META__` bootstrap into a `RenderSeedInput`
 * the unified mount surface can paint BEFORE the authoritative wire
 * `Render` arrives (or with no WS at all, for spec-compliant MCP-Apps
 * hosts). BLOCKER #2 from the Workflow-1 audit: building a full `Render`
 * from meta alone would require fabricating the 4 server-assigned ledger
 * fields (banned). The seed carries only what the meta honestly provides;
 * the first ack reconciles to a full `Render`.
 *
 * Pure projection — no mount, no React.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { SelfContainedMcpAppAiGguiMeta } from '../runtime.js';
import { buildRenderSeedInput } from '../runtime.js';

const BASE: SelfContainedMcpAppAiGguiMeta = {
  renderId: 'render_seed_1',
  appId: 'app_001',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('buildRenderSeedInput', () => {
  it('projects a system-card seed from `kind` (no fetch)', async () => {
    const seed = await buildRenderSeedInput({
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

    const seed = await buildRenderSeedInput({
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

  it('returns null for a live-only meta (no codeUrl, no kind)', async () => {
    const seed = await buildRenderSeedInput({
      ...BASE,
      wsUrl: 'ws://localhost:7000/ws',
      wsToken: 'tok_x',
    });
    expect(seed).toBeNull();
  });

  it('skips props on malformed propsJson (shape-preserving, no throw)', async () => {
    const seed = await buildRenderSeedInput({
      ...BASE,
      kind: 'mcp-apps-probe',
      propsJson: '{ not valid json',
    });
    expect(seed).not.toBeNull();
    expect((seed as { props?: unknown }).props).toBeUndefined();
  });

  it('throws when the codeUrl fetch fails (caller surfaces a typed boot failure)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 404, text: async () => '' })),
    );
    await expect(
      buildRenderSeedInput({ ...BASE, codeUrl: 'http://localhost:7000/code/missing.js' }),
    ).rejects.toThrow(/codeUrl fetch failed \(404\)/);
  });
});
