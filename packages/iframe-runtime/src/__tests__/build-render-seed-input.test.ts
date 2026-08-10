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
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { buildGguiSessionSeedInput, hasStaticContentMeta } from '../runtime.js';

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
