/**
 * Key-set parity pin for `parseMcpAppAiGguiRenderMeta` (#483 follow-up).
 *
 * The parser REBUILDS the slice field-by-field, so any interface field
 * missing from its constructor is silently deleted for every consumer
 * downstream. Four separate pickers shipped exactly that bug against
 * the optional `epoch` field (probe 18, 2026-08-13) — each typechecked
 * because dropping an optional field is type-legal.
 *
 * The trap here is COMPILE-TIME: the fixture is typed
 * `Omit<Required<McpAppAiGguiRenderMeta>, 'kind'>`, so adding a field
 * to the interface breaks this file's build until the fixture gains
 * it — and then the round-trip fails until the parser carries it.
 * (`kind` is excluded because it is mutually exclusive with the
 * `codeUrl`/`codeB64` static-component carriers; it gets its own case.)
 */
import { describe, it, expect } from 'vitest';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  parseMcpAppAiGguiRenderMeta,
  type McpAppAiGguiRenderMeta,
} from './mcp-apps.js';

const FULL: Omit<Required<McpAppAiGguiRenderMeta>, 'kind'> = {
  sessionId: 'r-1',
  appId: 'app-1',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://example.test/ws',
  wsToken: 'tok-1',
  expiresAt: '2099-01-01T00:00:00.000Z',
  pollingUrl: 'https://example.test/api/sessions/r-1/events?wsToken=tok-1',
  sseUrl: 'https://example.test/api/sessions/r-1/stream?wsToken=tok-1',
  themeId: 'theme-1',
  themeMode: 'dark',
  theme: { mode: 'dark', cssVariables: { '--ggui-color-primary-600': '#7c3aed' } },
  gadgets: [{ package: '@acme/map', bundleUrl: 'https://cdn.test/map.js' }],
  // Keyed per PUBLIC_ENV_APP_KEY_RE so the same fixture round-trips
  // the iframe-runtime's stricter projection (its parity twin).
  publicEnv: { GGUI_PUBLIC_APP_MAP_STYLE: 'basic' },
  streamWebSocketLocalTools: ['acme_search'],
  permissionsPolicy: ['geolocation=(self)'],
  lastSequence: 7,
  epoch: 3,
  propsJson: '{"count":3}',
  contextSlots: [
    {
      name: 'draftText',
      contextName: 'DraftTextContext',
      schema: { type: 'string' },
      default: '',
    },
  ],
  contractHash: 'sha256:abc',
  validatorsUrl: 'https://example.test/validators/sha256:abc.js',
  codeUrl: 'https://example.test/code/sha256:def.js',
  codeHash: 'sha256:def',
  codeB64: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbA==',
};

describe('parseMcpAppAiGguiRenderMeta — full-slice key-set parity', () => {
  it('round-trips EVERY interface field (no silent constructor drops)', () => {
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: FULL,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.meta === undefined) {
      throw new Error('expected a parsed slice');
    }
    // Key-set equality is the load-bearing half: a field the parser's
    // constructor omits vanishes here, regardless of value.
    expect(Object.keys(result.meta).sort()).toEqual(Object.keys(FULL).sort());
    // Value equality catches lossy re-encodings on top.
    expect(result.meta).toEqual(FULL);
  });

  it('round-trips the system-card variant (kind, no code carriers)', () => {
    const { codeUrl: _cu, codeHash: _ch, codeB64: _cb, ...rest } = FULL;
    const systemSlice = { ...rest, kind: 'no-credentials' };
    const result = parseMcpAppAiGguiRenderMeta({
      [MCP_APP_AI_GGUI_RENDER_META_KEY]: systemSlice,
    });
    expect(result.ok).toBe(true);
    if (!result.ok || result.meta === undefined) {
      throw new Error('expected a parsed slice');
    }
    expect(Object.keys(result.meta).sort()).toEqual(
      Object.keys(systemSlice).sort(),
    );
    expect(result.meta.kind).toBe('no-credentials');
  });
});
