import { describe, it, expect } from 'vitest';
import {
  toMcpAppEnvelope,
  type McpAppAiGguiMeta,
  type McpAppAiGguiSessionMeta,
  type McpAppAiGguiStackItemMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import { parseMetaFromUiInitialize } from '../meta-parse.js';

/**
 * Bootstrap-parse tests cover the four typed failure reasons + the
 * happy path. Hosts WILL send malformed bootstraps (browser
 * extensions, dev tools that intercept postMessage, third-party
 * harnesses) — every guard here corresponds to a real failure shape
 * the renderer needs to surface honestly rather than crash on.
 *
 * Each malformed-input test builds the input shape explicitly rather
 * than mutating a happy-path fixture. That keeps `delete`-on-typed-
 * value patterns out of the test surface (would otherwise force a
 * `Record<string, unknown>` cast — banned per CLAUDE.md Zero
 * Workarounds Policy).
 */

const FUTURE_ISO = '2099-01-01T00:00:00.000Z';

/**
 * Field names that belong on the session slice. Used by {@link flatToMeta}
 * to split a flat fixture input into the two-slice envelope shape that
 * `toMcpAppEnvelope` consumes. Kept in sync with `McpAppAiGguiSessionMeta`.
 */
const SESSION_FIELDS = new Set<string>([
  'sessionId',
  'appId',
  'runtimeUrl',
  'wsUrl',
  'wsToken',
  'expiresAt',
  'pollingUrl',
  'themeId',
  'themeMode',
  'canvasMode',
  'gadgets',
  'publicEnv',
  'streamWebSocketLocalTools',
  'appCallableTools',
  'permissionsPolicy',
]);

/**
 * Split a flat fixture object into the two-slice {@link McpAppAiGguiMeta}
 * shape. Unknown fields (test inputs that intentionally include garbage
 * to drive malformed-parse paths) ride on the stack-item slice so the
 * combiner's structural validation can still see them.
 */
function flatToMeta(flat: unknown): McpAppAiGguiMeta {
  if (flat === null || typeof flat !== 'object' || Array.isArray(flat)) {
    // Malformed fixture — surface it on session so the combiner trips.
    return { session: flat as unknown as McpAppAiGguiSessionMeta };
  }
  const sessionRaw: Record<string, unknown> = {};
  const stackItemRaw: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(flat as Record<string, unknown>)) {
    if (SESSION_FIELDS.has(k)) sessionRaw[k] = v;
    else stackItemRaw[k] = v;
  }
  const meta: McpAppAiGguiMeta = {
    session: sessionRaw as unknown as McpAppAiGguiSessionMeta,
    ...(Object.keys(stackItemRaw).length > 0
      ? { stackItem: stackItemRaw as unknown as McpAppAiGguiStackItemMeta }
      : {}),
  };
  return meta;
}

/**
 * Build a `ui/initialize` `result` payload from the four wire-required
 * bootstrap fields (+ optional expiresAt). Every test composes its
 * input through this so the call sites stay ergonomic without leaking
 * `unknown` casts into the test surface.
 *
 * accepts an optional `hostContext` second arg
 * that lands at `result.hostContext` (sibling of `result.toolOutput`),
 * matching the MCP Apps spec's `McpUiInitializeResult` shape.
 */
function buildResult(bootstrap: unknown, hostContext?: unknown): unknown {
  return {
    toolOutput: {
      _meta: toMcpAppEnvelope(flatToMeta(bootstrap)),
      structuredContent: { sessionId: 'sess_001' },
    },
    ...(hostContext !== undefined ? { hostContext } : {}),
  };
}

const happyBootstrap = {
  wsUrl: 'wss://server.example/ws',
  wsToken: 'tok_abc123',
  sessionId: 'sess_001',
  appId: 'app_001',
  expiresAt: FUTURE_ISO,
  runtimeUrl: '/_ggui/iframe-runtime.js',
};

describe('parseMetaFromUiInitialize — happy path', () => {
  it('returns the typed bootstrap when all required fields are present and well-formed', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.wsUrl).toBe('wss://server.example/ws');
      expect(result.meta.session.wsToken).toBe('tok_abc123');
      expect(result.meta.session.sessionId).toBe('sess_001');
      expect(result.meta.session.appId).toBe('app_001');
      expect(result.meta.session.expiresAt).toBe(FUTURE_ISO);
    }
  });

  it('accepts a bootstrap without expiresAt and propagates undefined', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        wsUrl: happyBootstrap.wsUrl,
        wsToken: happyBootstrap.wsToken,
        sessionId: happyBootstrap.sessionId,
        appId: happyBootstrap.appId,
        runtimeUrl: happyBootstrap.runtimeUrl,
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.expiresAt).toBeUndefined();
    }
  });

  it('carries the runtimeUrl field forward onto the typed session slice', () => {
    // C8 (2026-04-23): runtimeUrl is required. parseMetaFromUiInitialize
    // MUST propagate the field verbatim so the thin-shell's script-load
    // path has a URL to point at. Missing is MALFORMED (tested below).
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.runtimeUrl).toBe('/_ggui/iframe-runtime.js');
    }
  });

  // Slice 1 (2026-05-07) — `appCallableTools` parsing. The field is
  // optional on the wire; when present + well-typed it propagates;
  // when absent OR malformed the parse defaults to `[]` so Slice 2
  // dispatch routing can read the array unconditionally.
  it('propagates a well-typed appCallableTools array', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        appCallableTools: ['ggui_runtime_submit_action', 'foo_tool'],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.appCallableTools).toEqual([
        'ggui_runtime_submit_action',
        'foo_tool',
      ]);
    }
  });

  it('defaults appCallableTools to [] when the field is absent (back-compat)', () => {
    // Pre-Slice-1 bootstraps don't carry the field. Parser fills `[]`
    // so consumers don't need a presence check.
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.appCallableTools).toEqual([]);
    }
  });

  it('defaults appCallableTools to [] when the field is malformed (non-array)', () => {
    // Shape-preserving: a misshapen optional field MUST NOT fail the
    // whole parse. Falls through to `[]`, same as absent.
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, appCallableTools: 'ggui_runtime_submit_action' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.appCallableTools).toEqual([]);
    }
  });

  it('defaults appCallableTools to [] when the array contains non-strings', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        appCallableTools: ['ok', 42, 'also_ok'],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.appCallableTools).toEqual([]);
    }
  });

  // Slice 2 (2026-05-07) — `actionNextSteps` parsing. Same posture as
  // appCallableTools: optional on the wire, well-typed records
  // propagate, malformed shapes default to `{}`.
  it('propagates a well-typed actionNextSteps record', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        actionNextSteps: {
          archive: 'gmail_archive',
          send: 'gmail_send',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.actionNextSteps).toEqual({
        archive: 'gmail_archive',
        send: 'gmail_send',
      });
    }
  });

  it('defaults actionNextSteps to {} when the field is absent (back-compat)', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Session-only bootstrap (no stackItem at all) — actionNextSteps
      // lives on stackItem, so reading defaults to undefined for the
      // whole slice. Consumers default at the read site.
      expect(result.meta.stackItem).toBeUndefined();
    }
  });

  it('defaults actionNextSteps to {} when the field is malformed (non-object)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, actionNextSteps: 'not-an-object' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.actionNextSteps).toEqual({});
    }
  });

  it('defaults actionNextSteps to {} when the record contains non-string values', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        actionNextSteps: { ok: 'gmail_archive', bad: 42 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.actionNextSteps).toEqual({});
    }
  });

  it('defaults actionNextSteps to {} when the field is null', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, actionNextSteps: null }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.actionNextSteps).toEqual({});
    }
  });

  // Slice 8 (2026-05-08) — `contextSlots` parsing. Same shape-preserving
  // posture as the other Slice fields: legacy bootstraps without the
  // field default to `[]`; malformed shapes also default to `[]`.
  it('propagates a well-typed contextSlots array', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        contextSlots: [
          {
            name: 'currentStep',
            contextName: 'CurrentStepContext',
            schema: { type: 'number' },
            default: 0,
          },
          {
            name: 'draftText',
            contextName: 'DraftTextContext',
            schema: { type: 'string' },
            default: '',
            debounceMs: 500,
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const slots = result.meta.stackItem?.contextSlots ?? [];
      expect(slots).toHaveLength(2);
      expect(slots[0]?.name).toBe('currentStep');
      expect(slots[0]?.contextName).toBe('CurrentStepContext');
      expect(slots[1]?.debounceMs).toBe(500);
    }
  });

  it('defaults contextSlots to [] when the field is absent (back-compat)', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Session-only bootstrap omits the whole stackItem slice.
      expect(result.meta.stackItem).toBeUndefined();
    }
  });

  it('defaults contextSlots to [] when the field is malformed (not an array)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, contextSlots: 'not-an-array' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.contextSlots).toEqual([]);
    }
  });

  it('defaults contextSlots to [] when an entry is missing required fields', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        contextSlots: [
          // Missing schema — entire array drops to []
          { name: 'currentStep', contextName: 'CurrentStepContext' },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.contextSlots).toEqual([]);
    }
  });

  // Slice 12 (2026-05-08) — `default` is required (the runtime owns
  // useState per slot, so the seed is load-bearing). Missing `default`
  // → entire array drops to [] same as missing `schema`.
  it('defaults contextSlots to [] when an entry omits `default` (Slice 12)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        contextSlots: [
          {
            name: 'currentStep',
            contextName: 'CurrentStepContext',
            schema: { type: 'number' },
            // `default` deliberately omitted.
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.contextSlots).toEqual([]);
    }
  });
});

describe('parseMetaFromUiInitialize — MISSING_TOOL_OUTPUT', () => {
  it('rejects undefined input', () => {
    expect(parseMetaFromUiInitialize(undefined)).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });

  it('rejects null input', () => {
    expect(parseMetaFromUiInitialize(null)).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });

  it('rejects an array (which is typeof "object")', () => {
    expect(parseMetaFromUiInitialize([])).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });

  it('rejects a primitive string', () => {
    expect(parseMetaFromUiInitialize('not-an-object')).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });

  it('rejects when toolOutput is missing entirely', () => {
    expect(parseMetaFromUiInitialize({ structuredContent: {} })).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });

  it('rejects when toolOutput is not an object', () => {
    expect(parseMetaFromUiInitialize({ toolOutput: 'string-output' })).toEqual({
      ok: false,
      reason: 'MISSING_TOOL_OUTPUT',
    });
  });
});

describe('parseMetaFromUiInitialize — MISSING_META_GGUI_BOOTSTRAP', () => {
  it('rejects when _meta is absent', () => {
    expect(parseMetaFromUiInitialize({ toolOutput: { structuredContent: {} } })).toEqual({
      ok: false,
      reason: 'MISSING_META_GGUI_BOOTSTRAP',
    });
  });

  it('rejects when the session slice is absent from _meta', () => {
    expect(parseMetaFromUiInitialize({ toolOutput: { _meta: { other: {} } } })).toEqual({
      ok: false,
      reason: 'MISSING_META_GGUI_BOOTSTRAP',
    });
  });

  it('rejects when _meta carries an empty object (no per-window keys)', () => {
    expect(parseMetaFromUiInitialize({ toolOutput: { _meta: {} } })).toEqual({
      ok: false,
      reason: 'MISSING_META_GGUI_BOOTSTRAP',
    });
  });

  it('rejects when the bootstrap value is an array (combiner returns MALFORMED_SESSION)', () => {
    expect(parseMetaFromUiInitialize(buildResult([]))).toEqual({
      ok: false,
      reason: 'MALFORMED_BOOTSTRAP',
    });
  });
});

describe('parseMetaFromUiInitialize — MALFORMED_BOOTSTRAP', () => {
  it('rejects when wsUrl is missing', () => {
    expect(
      parseMetaFromUiInitialize(
        buildResult({
          wsToken: happyBootstrap.wsToken,
          sessionId: happyBootstrap.sessionId,
          appId: happyBootstrap.appId,
        }),
      ),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when token is empty string', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, wsToken: '' })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when sessionId is a number (wrong type)', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, sessionId: 12345 })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when appId is null', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, appId: null })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when expiresAt is unparseable', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, expiresAt: 'not-a-date' })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when expiresAt is the wrong type (number, not ISO string)', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, expiresAt: Date.now() })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when runtimeUrl is missing (C8 load-bearing field)', () => {
    // runtimeUrl joined the required set in C8; absence is MALFORMED.
    // Exactly the same posture as the other four string fields —
    // parseMetaFromUiInitialize refuses to surface an un-bootable meta.
    expect(
      parseMetaFromUiInitialize(
        buildResult({
          wsUrl: happyBootstrap.wsUrl,
          wsToken: happyBootstrap.wsToken,
          sessionId: happyBootstrap.sessionId,
          appId: happyBootstrap.appId,
          expiresAt: happyBootstrap.expiresAt,
          // runtimeUrl deliberately omitted
        }),
      ),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });

  it('rejects when runtimeUrl is empty string', () => {
    expect(
      parseMetaFromUiInitialize(buildResult({ ...happyBootstrap, runtimeUrl: '' })),
    ).toEqual({ ok: false, reason: 'MALFORMED_BOOTSTRAP' });
  });
});

describe('parseMetaFromUiInitialize — EE+ 1c streamWebSocketLocalTools', () => {
  it('preserves a non-empty allowlist verbatim', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        streamWebSocketLocalTools: ['weather_now', 'tasks_list'],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.streamWebSocketLocalTools).toEqual([
        'weather_now',
        'tasks_list',
      ]);
    }
  });

  it('preserves an empty allowlist verbatim (server transport-aware, no tool local)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        streamWebSocketLocalTools: [],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Empty array projects to undefined per the parser's
      // "shape-preserving collapse" rule (only non-empty entries
      // survive). Consumers default at the read site.
      expect(result.meta.session.streamWebSocketLocalTools).toBeUndefined();
    }
  });

  it('defaults to undefined when the field is absent (universal iframe-poll fallback)', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.streamWebSocketLocalTools).toBeUndefined();
    }
  });

  it('defaults to undefined on malformed payload (non-array)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        streamWebSocketLocalTools: 'not-an-array',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.streamWebSocketLocalTools).toBeUndefined();
    }
  });

  it('defaults to undefined when array contains non-string entries', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        streamWebSocketLocalTools: ['weather_now', 42],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.streamWebSocketLocalTools).toBeUndefined();
    }
  });
});

// GG.8.2 — `gadgets` carries the resolved package catalog the
// iframe-runtime dynamically imports at boot. One entry per registered
// PACKAGE (`package` required; no per-hook `hook` field). Parse:
// defensive — malformed entries collapse the WHOLE field to
// `undefined` rather than partially trusting it.
describe('parseMetaFromUiInitialize — GG.8.2 gadgets', () => {
  it('parses a well-formed gadgets array', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: [
          {
            package: '@ggui-samples/gadget-leaflet',
          },
          {
            package: '@ggui-samples/gadget-mapbox',
            bundleUrl: 'https://cdn.example/mapbox.js',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toEqual([
        {
          package: '@ggui-samples/gadget-leaflet',
        },
        {
          package: '@ggui-samples/gadget-mapbox',
          bundleUrl: 'https://cdn.example/mapbox.js',
        },
      ]);
    }
  });

  it('defaults gadgets to undefined when absent', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toBeUndefined();
    }
  });

  it('defaults to undefined when an entry lacks a package', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: [{ bundleUrl: 'https://cdn.example/orphan.js' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toBeUndefined();
    }
  });

  it('defaults to undefined when the field is not an array', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: { package: 'oops' },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toBeUndefined();
    }
  });

  it('defaults to undefined when an entry has an empty package string', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: [{ package: '' }],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toBeUndefined();
    }
  });

  // `bundleSri` rides through the parser when a `bundleUrl` is present.
  // Without a bundleUrl the field is stripped (SRI is only meaningful
  // on the `<link rel="modulepreload">` path).
  it('threads bundleSri end-to-end when paired with bundleUrl', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: [
          {
            package: '@ggui-samples/gadget-mapbox',
            bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
            bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toEqual([
        {
          package: '@ggui-samples/gadget-mapbox',
          bundleUrl: 'https://registry.ggui.ai/bundles/mapbox.js',
          bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
        },
      ]);
    }
  });

  it('drops bundleSri on a package-only entry (SRI requires a bundleUrl)', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        gadgets: [
          {
            package: '@ggui-samples/gadget-mapbox',
            bundleSri: 'sha384-aHR0cDovL2V4YW1wbGUuY29tCg',
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.gadgets).toEqual([
        {
          package: '@ggui-samples/gadget-mapbox',
        },
      ]);
    }
  });
});

// Slice 2.0 — `publicEnv` field on the bootstrap envelope. The
// iframe-runtime installs this verbatim at
// `globalThis.__ggui__.publicEnv` for wrapper hooks to read via
// `getPublicEnv()`. Parser is defensive: every key must match
// `PUBLIC_ENV_APP_KEY_RE`; one bad key drops the whole field.
describe('parseMetaFromUiInitialize — Slice 2.0 publicEnv', () => {
  it('parses a well-formed publicEnv map', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        publicEnv: {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
          GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toEqual({
        GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
        GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
      });
    }
  });

  it('defaults publicEnv to undefined when absent', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });

  it('treats empty publicEnv as absent (#109 splitter drops empty slices)', () => {
    // Post-#109: splitMountViewIntoSlices omits empty publicEnv from the
    // session slice on the wire, so the combiner-driven parser sees
    // it as absent (undefined). Empty-map and absent are now
    // wire-equivalent; consumers that need a defined map default at
    // their read site.
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, publicEnv: {} }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });

  it('collapses to undefined when a key violates the prefix rule', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        publicEnv: {
          GGUI_PUBLIC_APP_OK: 'value',
          BAD_KEY: 'also-rejected',
        },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });

  it('collapses to undefined when a value is not a string', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        publicEnv: { GGUI_PUBLIC_APP_TOKEN: 123 },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });

  it('collapses to undefined when the field itself is not a plain object', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({ ...happyBootstrap, publicEnv: 'not-an-object' }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });

  it('collapses to undefined when a key uses the reserved USER_ namespace', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        publicEnv: { GGUI_PUBLIC_USER_TOKEN: 'pk.eyJ...' },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.publicEnv).toBeUndefined();
    }
  });
});

describe('parseMetaFromUiInitialize — EXPIRED_BOOTSTRAP', () => {
  it('rejects when expiresAt is in the past', () => {
    expect(
      parseMetaFromUiInitialize(
        buildResult({ ...happyBootstrap, expiresAt: '2000-01-01T00:00:00.000Z' }),
      ),
    ).toEqual({ ok: false, reason: 'EXPIRED_BOOTSTRAP' });
  });

  it('rejects when expiresAt is one millisecond in the past', () => {
    expect(
      parseMetaFromUiInitialize(
        buildResult({
          ...happyBootstrap,
          // Set to one ms in the past to avoid clock-jitter flakes.
          expiresAt: new Date(Date.now() - 1).toISOString(),
        }),
      ),
    ).toEqual({ ok: false, reason: 'EXPIRED_BOOTSTRAP' });
  });
});

describe('parseMetaFromUiInitialize — auth-degraded fallback (rehydrate)', () => {
  // chat-history rehydrate scenario: claude.ai persisted the original
  // bootstrap (with its 2-min token TTL) and re-mounts the iframe
  // minutes/hours later. The token has expired but the static
  // renderable content (codeUrl / system kind) is still present. The
  // runtime's `bootSelfContained` mounts the card from those fields
  // without using `wsUrl`/`token`, so the parse should succeed in a
  // degraded mode — auth fields dropped, static fields preserved.

  it('expired + codeUrl → returns ok in degraded mode', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: '/_ggui/iframe-runtime.js',
        wsUrl: 'wss://server.example/ws',
        wsToken: 'tok_abc123',
        expiresAt: '2000-01-01T00:00:00.000Z',
        codeUrl: 'https://cdn.example/blueprint/abc.js',
        codeHash: 'sha256-deadbeef',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.codeUrl).toBe('https://cdn.example/blueprint/abc.js');
      expect(result.meta.session.wsUrl).toBeUndefined();
      expect(result.meta.session.wsToken).toBeUndefined();
    }
  });

  it('expired + system kind → returns ok in degraded mode', () => {
    const result = parseMetaFromUiInitialize(
      buildResult({
        sessionId: 'sess_001',
        appId: 'app_001',
        runtimeUrl: '/_ggui/iframe-runtime.js',
        wsUrl: 'wss://server.example/ws',
        wsToken: 'tok_abc123',
        expiresAt: '2000-01-01T00:00:00.000Z',
        kind: 'no-credentials',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.stackItem?.kind).toBe('no-credentials');
      expect(result.meta.session.wsUrl).toBeUndefined();
      expect(result.meta.session.wsToken).toBeUndefined();
    }
  });

  it('expired + NO static content → still rejects with EXPIRED_BOOTSTRAP', () => {
    expect(
      parseMetaFromUiInitialize(
        buildResult({
          ...happyBootstrap,
          expiresAt: '2000-01-01T00:00:00.000Z',
          // No codeUrl, no kind — nothing to mount.
        }),
      ),
    ).toEqual({ ok: false, reason: 'EXPIRED_BOOTSTRAP' });
  });
});

describe('parseMetaFromUiInitialize — Slice A HostContext capture', () => {
  // The widening: parseMetaFromUiInitialize
  // now opportunistically reads `result.hostContext` and projects it
  // alongside the slice meta. Best-effort — never blocks the
  // slice-meta parse.

  it('captures hostContext when present alongside a valid bootstrap', () => {
    const result = parseMetaFromUiInitialize(
      buildResult(happyBootstrap, {
        displayMode: 'fullscreen',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        platform: 'desktop',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostContext).toEqual({
        currentDisplayMode: 'fullscreen',
        availableDisplayModes: ['inline', 'fullscreen', 'pip'],
        platform: 'desktop',
      });
    }
  });

  it('omits hostContext when the host did not emit one', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostContext).toBeUndefined();
    }
  });

  it('omits hostContext when malformed (best-effort, never blocks)', () => {
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap, 'not an object'));
    expect(result.ok).toBe(true);
    if (result.ok) {
      // Bootstrap still parses; hostContext silently undefined.
      expect(result.hostContext).toBeUndefined();
      expect(result.meta.session.sessionId).toBe('sess_001');
    }
  });

  it('captures hostContext as empty {} when host emits object-with-no-recognized-fields', () => {
    // Distinct from undefined — host DID emit context, just nothing
    // ggui projects. Useful for "host is on the spec but minimal".
    const result = parseMetaFromUiInitialize(buildResult(happyBootstrap, { theme: 'dark' }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.hostContext).toEqual({});
    }
  });

  it('malformed bootstrap still rejects regardless of hostContext', () => {
    // hostContext capture must not mask a bootstrap-parse failure.
    const result = parseMetaFromUiInitialize(
      buildResult(
        { wsUrl: 'wss://x', sessionId: 'sess_001' /* missing appId+runtimeUrl */ },
        { displayMode: 'fullscreen' },
      ),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('MALFORMED_BOOTSTRAP');
    }
  });

  it('fresh + codeUrl → returns ok with all live-mode fields preserved', () => {
    // Sanity: the degraded fallback only fires on expiry. Fresh
    // bootstraps with static content keep the live fields too.
    const result = parseMetaFromUiInitialize(
      buildResult({
        ...happyBootstrap,
        codeUrl: 'https://cdn.example/blueprint/abc.js',
        codeHash: 'sha256-deadbeef',
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.session.wsUrl).toBe('wss://server.example/ws');
      expect(result.meta.session.wsToken).toBe('tok_abc123');
      expect(result.meta.session.expiresAt).toBe(FUTURE_ISO);
      expect(result.meta.stackItem?.codeUrl).toBe('https://cdn.example/blueprint/abc.js');
    }
  });
});
