/**
 * Key-set parity pin for `validateMeta`'s defensive projection (#483
 * follow-up) — the runtime-side twin of the protocol package's
 * `mcp-apps.parity.test.ts`. The projection re-lists every slice
 * field; a field missing from that list is silently deleted from the
 * validated meta (the `epoch` freeze-latch self-epoch shipped exactly
 * that way). The fixture is typed `Omit<Required<...>, 'kind'>` so a
 * new interface field breaks this build until the fixture gains it —
 * then the round-trip fails until the projection carries it.
 */
import { describe, it, expect } from 'vitest';
import type { McpAppAiGguiRenderMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import { validateMeta } from '../meta-parse.js';

const FULL: Omit<Required<McpAppAiGguiRenderMeta>, 'kind'> = {
  sessionId: 'r-1',
  appId: 'app-1',
  runtimeUrl: '/_ggui/iframe-runtime.js',
  wsUrl: 'wss://example.test/ws',
  wsToken: 'tok-1',
  // Far-future so the expired-creds degrade path (which deliberately
  // DROPS the live trio) does not fire.
  expiresAt: '2099-01-01T00:00:00.000Z',
  pollingUrl: 'https://example.test/api/sessions/r-1/events?wsToken=tok-1',
  sseUrl: 'https://example.test/api/sessions/r-1/stream?wsToken=tok-1',
  themeId: 'theme-1',
  themeMode: 'dark',
  theme: { mode: 'dark', cssVariables: { '--ggui-color-primary-600': '#7c3aed' } },
  gadgets: [{ package: '@acme/map', bundleUrl: 'https://cdn.test/map.js' }],
  // Key MUST match PUBLIC_ENV_APP_KEY_RE (GGUI_PUBLIC_APP_*) — the
  // projection legitimately collapses non-conforming maps to absent.
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
  // Strict-CSP module variant (ggui#522 slice 2) — projected only
  // alongside a raw static carrier, as here.
  codeModuleUrl: 'https://example.test/code/sha256:def.m0123abcd4567.js',
  codeB64: 'ZXhwb3J0IGRlZmF1bHQgKCkgPT4gbnVsbA==',
};

describe('validateMeta — full-slice key-set parity', () => {
  it('projects EVERY interface field through (no silent projection drops)', () => {
    const result = validateMeta(FULL);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(`expected ok, got ${result.reason}`);
    expect(Object.keys(result.meta).sort()).toEqual(Object.keys(FULL).sort());
    expect(result.meta).toEqual(FULL);
  });
});
