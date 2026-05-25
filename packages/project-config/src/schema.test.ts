import { describe, expect, it } from 'vitest';
import {
  GGUI_JSON_FILENAME,
  GguiJsonV1,
  parseGguiJson,
  safeParseGguiJson,
} from './schema.js';

/**
 * Zero-config minimum — just the three required fields. OSS server
 * boots from this with all defaults applied.
 */
const MINIMAL_V1 = {
  schema: '1' as const,
  protocol: '1.1',
  app: { slug: 'weather-bot', name: 'Weather Bot' },
};

describe('ggui.json schema — filename constant', () => {
  it('is exactly "ggui.json"', () => {
    expect(GGUI_JSON_FILENAME).toBe('ggui.json');
  });
});

describe('ggui.json schema — zero-config OSS boot', () => {
  it('accepts the minimal three-field doc and fills capability defaults', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.schema).toBe('1');
    expect(parsed.protocol).toBe('1.1');
    expect(parsed.app.slug).toBe('weather-bot');

    // OSS-server-runs-from-ggui.json defaults kick in:
    expect(parsed.blueprints).toEqual({ include: [] });
    expect(parsed.primitives).toEqual({
      packages: ['@ggui-ai/design/primitives'],
      local: [],
    });
    // `theme` has no default — absence is meaningful ("use shipped
    // @ggui-ai/design tokens").
    expect(parsed.theme).toBeUndefined();
    // `mcpMounts` defaults to an empty list so absence is the
    // zero-config OSS default ("no local tool bundles mounted").
    expect(parsed.mcpMounts).toEqual([]);
  });

  it('round-trips cleanly through JSON.stringify + re-parse', () => {
    const once = parseGguiJson(MINIMAL_V1);
    const twice = parseGguiJson(JSON.parse(JSON.stringify(once)));
    expect(twice).toEqual(once);
  });
});

describe('ggui.json schema — capability declarations', () => {
  it('accepts a blueprints glob', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      blueprints: { include: ['ui/**/ggui.ui.json', 'shared/*/ggui.ui.json'] },
    });
    expect(parsed.blueprints.include).toHaveLength(2);
  });

  it('accepts custom primitive packages + local globs', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      primitives: {
        packages: ['@ggui-ai/design/primitives', '@mycompany/ui'],
        local: ['src/primitives/**/ggui.primitive.json'],
      },
    });
    expect(parsed.primitives.packages).toEqual([
      '@ggui-ai/design/primitives',
      '@mycompany/ui',
    ]);
    expect(parsed.primitives.local).toEqual([
      'src/primitives/**/ggui.primitive.json',
    ]);
  });

  it('applies partial primitives defaults when only one sub-field is provided', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      primitives: { packages: ['@mycompany/ui'] },
    });
    // packages replaces default; local falls back.
    expect(parsed.primitives.packages).toEqual(['@mycompany/ui']);
    expect(parsed.primitives.local).toEqual([]);
  });

  it('accepts a theme path', () => {
    const parsed = parseGguiJson({ ...MINIMAL_V1, theme: './theme.json' });
    expect(parsed.theme).toBe('./theme.json');
  });

  it('accepts a list of mcpMount module specifiers', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      mcpMounts: [
        './fixtures/mcps/tasks/mount.mjs',
        '@my-org/mcp-mount',
      ],
    });
    expect(parsed.mcpMounts).toEqual([
      './fixtures/mcps/tasks/mount.mjs',
      '@my-org/mcp-mount',
    ]);
  });

  it('rejects an empty string inside mcpMounts', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      mcpMounts: [''],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-string entries inside mcpMounts', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      mcpMounts: [{ module: './mount.mjs' }],
    });
    expect(result.success).toBe(false);
  });
});

// Slice 2 (Slice 2.5) — `app.publicEnv` lives on the manifest so
// operators can stamp values the wrapper-author side reads via
// `getPublicEnv()`. The schema delegates to `appPublicEnvSchema` from
// `@ggui-ai/protocol`, which enforces the `GGUI_PUBLIC_APP_*` prefix.
// These cases just lock the manifest-side wiring (the key-shape
// invariants are tested exhaustively in the protocol package).
describe('ggui.json schema — app.publicEnv (Slice 2 public env channel)', () => {
  it('accepts a well-formed publicEnv map', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      app: {
        ...MINIMAL_V1.app,
        publicEnv: {
          GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
          GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
        },
      },
    });
    expect(parsed.app.publicEnv).toEqual({
      GGUI_PUBLIC_APP_MAPBOX_TOKEN: 'pk.eyJ...',
      GGUI_PUBLIC_APP_API_BASE: 'https://api.example.com',
    });
  });

  it('accepts publicEnv being omitted entirely', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.app.publicEnv).toBeUndefined();
  });

  it('accepts an empty publicEnv map (operator declares no keys yet)', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      app: { ...MINIMAL_V1.app, publicEnv: {} },
    });
    expect(parsed.app.publicEnv).toEqual({});
  });

  it('rejects a key without the GGUI_PUBLIC_APP_ prefix', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      app: { ...MINIMAL_V1.app, publicEnv: { MAPBOX_TOKEN: 'pk.eyJ...' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects the reserved GGUI_PUBLIC_USER_ namespace', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      app: {
        ...MINIMAL_V1.app,
        publicEnv: { GGUI_PUBLIC_USER_TOKEN: 'pk.eyJ...' },
      },
    });
    expect(result.success).toBe(false);
  });
});

// `adapters[]` was retired in Bucket B (2026-05-18, LOCKED-22). The
// device-permission grant model now lives entirely on
// `clientCapabilities.gadgets[*].permission`. The old allow-list test
// suite is gone; equivalent coverage now lives on the gadget schema
// (`strictGadgetDescriptorSchema`) in `@ggui-ai/protocol`.

describe('ggui.json schema — adapters field is retired (LOCKED-22)', () => {
  it('rejects the retired `adapters` field (strict-object posture)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      adapters: ['camera'],
    } as unknown as Record<string, unknown>);
    expect(result.success).toBe(false);
  });
});

describe('ggui.json schema — strict root (locked 2026-04-18)', () => {
  // Strict root is the guard against silent regression toward the
  // earlier agent-centric shape. Each of these tests documents a
  // specific field that MUST NOT land at the root, and asserts that
  // attempting it fails parse. Regressions that add any of these
  // fields have to also update these tests to pass — an explicit
  // architectural decision, not a drive-by.

  it('rejects an LLM config at root (belongs in framework config)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      llm: { provider: 'anthropic', model: 'claude-sonnet-4-6' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an agent wrapper at root (was the pre-2026-04-18 shape)', () => {
    const result = safeParseGguiJson({
      schema: '1',
      protocol: '1.1',
      agent: { slug: 'foo', name: 'Foo', mode: 'personal' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a policy block at root (host-runtime concern)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      policy: { residency: 'local', sandboxing: 'process' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a deployments array at root (belongs in a hosting-vendor overlay)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      deployments: [{ target: 'acme-cloud', url: 'https://example.com' }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a uiGen pin at root (package.json / lockfile concern)', () => {
    const result = safeParseGguiJson({ ...MINIMAL_V1, uiGen: '1.7.3' });
    expect(result.success).toBe(false);
  });

  it('rejects a deploy config at root (belongs in a hosting-vendor overlay)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      deploy: { size: 'sm', runtime: 'node22' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a typo like `blueprint` (singular)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      blueprint: { include: ['ui/**/ggui.ui.json'] },
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.json schema — strict nested objects', () => {
  it('rejects unknown keys inside `app`', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      app: { slug: 'weather-bot', name: 'Weather Bot', mode: 'personal' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside `primitives`', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      primitives: {
        packages: ['@ggui-ai/design/primitives'],
        unknown: ['wat'],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside `blueprints`', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      blueprints: { include: [], exclude: ['ui/_drafts/**'] },
    });
    // `exclude` is a reasonable future additive field; today it's a
    // strict-mode rejection. Adding it later requires updating this
    // test + the schema together (a coordinated schema change).
    expect(result.success).toBe(false);
  });
});

describe('ggui.json schema — slug validation', () => {
  it.each([
    ['Weather-Bot', 'uppercase'],
    ['-leading-hyphen', 'leading hyphen'],
    ['trailing-hyphen-', 'trailing hyphen'],
    ['a', 'single character (min length 2)'],
    ['weather bot', 'whitespace'],
    ['weather_bot', 'underscore'],
  ])('rejects slug %p (%s)', (slug) => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      app: { slug, name: 'X' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts a valid slug', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      app: { slug: 'weather-bot-2', name: 'Weather Bot' },
    });
    expect(result.success).toBe(true);
  });
});

describe('ggui.json schema — protocol version format', () => {
  it.each([
    ['1.0'],
    ['1.1'],
    ['1.0.0'],
    ['2.0.0-alpha.1'],
    ['1.0-draft'],
    ['draft-2026-04-19'],
  ])('accepts %p', (protocol) => {
    const result = safeParseGguiJson({ ...MINIMAL_V1, protocol });
    expect(result.success).toBe(true);
  });

  it.each([[''], ['v1.1'], ['1'], ['latest'], ['~1.0']])(
    'rejects %p',
    (protocol) => {
      const result = safeParseGguiJson({ ...MINIMAL_V1, protocol });
      expect(result.success).toBe(false);
    },
  );
});

describe('ggui.json schema — schema literal version', () => {
  it('rejects documents missing `schema`', () => {
    const { schema: _schema, ...rest } = MINIMAL_V1;
    void _schema;
    const result = safeParseGguiJson(rest);
    expect(result.success).toBe(false);
  });

  it('rejects documents on a future schema version', () => {
    const result = safeParseGguiJson({ ...MINIMAL_V1, schema: '2' });
    expect(result.success).toBe(false);
  });
});

describe('ggui.json schema — typed export sanity', () => {
  it('`GguiJsonV1` (the value) is the Zod schema', () => {
    const again = GguiJsonV1.parse(MINIMAL_V1);
    expect(again.schema).toBe('1');
  });
});

describe('ggui.json schema — storage block (explicit opt-in) (locked 2026-04-19)', () => {
  // The storage block is the OSS opt-in wiring for persistent adapters.
  // Absent = every surface in-memory (zero-config default). Present =
  // operator has declared their intent per surface; no silent file
  // creation ever.

  it('is optional — absent means every surface stays in-memory (no silent file creation)', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.storage).toBeUndefined();
  });

  it('accepts the canonical sqlite-both shape', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'sqlite', path: './ggui-sessions.sqlite' },
        vectors: { driver: 'sqlite', path: './ggui-vectors.sqlite' },
      },
    });
    expect(parsed.storage).toEqual({
      sessions: { driver: 'sqlite', path: './ggui-sessions.sqlite' },
      vectors: { driver: 'sqlite', path: './ggui-vectors.sqlite' },
    });
  });

  it('accepts a partial block — only one surface declared', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'sqlite', path: './ggui-sessions.sqlite' },
      },
    });
    expect(parsed.storage?.sessions).toEqual({
      driver: 'sqlite',
      path: './ggui-sessions.sqlite',
    });
    expect(parsed.storage?.vectors).toBeUndefined();
  });

  it('accepts an explicit driver:"memory" for a surface (useful to make intent visible)', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'memory' },
        vectors: { driver: 'sqlite', path: './v.sqlite' },
      },
    });
    expect(parsed.storage?.sessions).toEqual({ driver: 'memory' });
    expect(parsed.storage?.vectors).toEqual({
      driver: 'sqlite',
      path: './v.sqlite',
    });
  });

  it('rejects driver:"sqlite" without a path', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: { sessions: { driver: 'sqlite' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects driver:"sqlite" with an empty path', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: { sessions: { driver: 'sqlite', path: '' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects driver:"memory" combined with a path (path is sqlite-only)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'memory', path: './x.sqlite' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown driver (forces a coordinated schema change when new adapters land)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'postgres', url: 'postgres://localhost/ggui' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown surface keys under storage (typo protection)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: {
        // Typo — would silently leave sessions on the in-memory default
        // without strict parsing.
        sesions: { driver: 'sqlite', path: './x.sqlite' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside a sqlite surface (catches e.g. `paht`)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: {
          driver: 'sqlite',
          path: './ggui-sessions.sqlite',
          paht: './another.sqlite',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('round-trips cleanly with the storage block intact', () => {
    const once = parseGguiJson({
      ...MINIMAL_V1,
      storage: {
        sessions: { driver: 'sqlite', path: './ggui-sessions.sqlite' },
        vectors: { driver: 'memory' },
      },
    });
    const twice = parseGguiJson(JSON.parse(JSON.stringify(once)));
    expect(twice.storage).toEqual(once.storage);
  });

  it('accepts storage.threads on the same discriminated-driver shape', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      storage: {
        threads: { driver: 'sqlite', path: './ggui-threads.sqlite' },
      },
    });
    expect(parsed.storage?.threads).toEqual({
      driver: 'sqlite',
      path: './ggui-threads.sqlite',
    });
  });

  it('rejects storage.threads with an unknown driver (same strictness as siblings)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      storage: {
        threads: { driver: 'redis', url: 'redis://localhost' },
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('ggui.json schema — agent block (ggui serve) (locked 2026-04-19)', () => {
  it('agent is optional — absent means MCP-only boot for `ggui serve`', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.agent).toBeUndefined();
  });

  it('accepts agent.entry as a relative path', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      agent: { entry: './agent.ts' },
    });
    expect(parsed.agent).toEqual({ entry: './agent.ts' });
  });

  it('accepts all supported extensions — extension validation is a ggui serve concern', () => {
    for (const entry of [
      './agent.js',
      './agent.mjs',
      './agent.cjs',
      './agent.ts',
      './agent.tsx',
      './agent.mts',
      // The schema does NOT gate extensions — it stays permissive so
      // `ggui serve` can surface a first-class error with actionable
      // remediation copy. Verify the schema is permissive here.
      './agent.deno.ts',
    ]) {
      expect(() =>
        parseGguiJson({ ...MINIMAL_V1, agent: { entry } }),
      ).not.toThrow();
    }
  });

  it('rejects agent.entry that is an empty string', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      agent: { entry: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys in the agent block (strict nested)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      agent: {
        entry: './agent.ts',
        // Speculative fields blocked until a real need surfaces.
        // Rejecting at parse time prevents silent drift.
        env: { DEBUG: '1' },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object agent value', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      agent: './agent.ts',
    });
    expect(result.success).toBe(false);
  });

  it('round-trips with the agent block intact', () => {
    const once = parseGguiJson({
      ...MINIMAL_V1,
      agent: { entry: './agent.ts' },
    });
    const twice = parseGguiJson(JSON.parse(JSON.stringify(once)));
    expect(twice.agent).toEqual({ entry: './agent.ts' });
  });
});

describe('ggui.json schema — generation block (slice #43 — explicit LlmRoute)', () => {
  it('parses canonical "provider:model" form into a typed LlmRoute', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      generation: { model: 'anthropic:claude-haiku-4-5-20251001' },
    });
    expect(parsed.generation?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('parses LiteLLM "provider/model" form into a typed LlmRoute', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      generation: { model: 'anthropic/claude-haiku-4-5' },
    });
    // LITELLM_TO_WIRE maps short-form to wire-canonical at parse time.
    expect(parsed.generation?.model).toEqual({
      provider: 'anthropic',
      model: 'claude-haiku-4-5-20251001',
    });
  });

  it('parses google + openai + openrouter + bedrock entries', () => {
    const cases: ReadonlyArray<{
      input: string;
      expected: { provider: string; model: string };
    }> = [
      {
        input: 'google:gemini-3.5-flash',
        expected: { provider: 'google', model: 'gemini-3.5-flash' },
      },
      {
        input: 'openai:gpt-5.5-2026-04-23',
        expected: { provider: 'openai', model: 'gpt-5.5-2026-04-23' },
      },
      {
        input: 'openrouter:anthropic/claude-haiku-4.5',
        expected: {
          provider: 'openrouter',
          model: 'anthropic/claude-haiku-4.5',
        },
      },
      {
        input: 'bedrock:us.anthropic.claude-haiku-4-5-20251001-v1:0',
        expected: {
          provider: 'bedrock',
          model: 'us.anthropic.claude-haiku-4-5-20251001-v1:0',
        },
      },
    ];
    for (const { input, expected } of cases) {
      const parsed = parseGguiJson({
        ...MINIMAL_V1,
        generation: { model: input },
      });
      expect(parsed.generation?.model).toEqual(expected);
    }
  });

  it('rejects an unrecognized provider with an actionable error', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      generation: { model: 'meta:llama-3.5' },
    });
    expect(result.success).toBe(false);
    if (result.success) return;
    const message = result.error.issues
      .map((i) => i.message)
      .join(' / ');
    expect(message).toMatch(/not a recognized LlmRoute/);
    expect(message).toMatch(/model-string-convention/);
  });

  it('rejects an unrecognized openai model (closed enum, no escape hatch)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      generation: { model: 'openai:gpt-3' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts arbitrary openrouter model strings (escape hatch)', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      generation: {
        model: 'openrouter:some-future/model-not-in-curated-list',
      },
    });
    expect(parsed.generation?.model).toEqual({
      provider: 'openrouter',
      model: 'some-future/model-not-in-curated-list',
    });
  });

  it('rejects an empty model string', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      generation: { model: '' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown keys inside generation (strict object)', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      generation: {
        model: 'anthropic:claude-haiku-4-5-20251001',
        temperature: 0.5,
      },
    });
    expect(result.success).toBe(false);
  });

  it('absent generation is fine (the CLI hard-fails downstream when a key resolves)', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.generation).toBeUndefined();
  });
});

describe('ggui.json schema — registry field (Slice 3.2 plugin marketplace)', () => {
  it('accepts a valid https registry URL', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      registry: 'https://registry.ggui.ai',
    });
    expect(parsed.registry).toBe('https://registry.ggui.ai');
  });

  it('accepts an http://localhost dev fixture registry', () => {
    const parsed = parseGguiJson({
      ...MINIMAL_V1,
      registry: 'http://localhost:4873',
    });
    expect(parsed.registry).toBe('http://localhost:4873');
  });

  it('treats omitted registry as undefined (three-layer resolution falls through to env / flag)', () => {
    const parsed = parseGguiJson(MINIMAL_V1);
    expect(parsed.registry).toBeUndefined();
  });

  it('rejects a non-URL string', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      registry: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-string value', () => {
    const result = safeParseGguiJson({
      ...MINIMAL_V1,
      registry: 42,
    });
    expect(result.success).toBe(false);
  });

  it('round-trips the registry field through JSON.stringify + re-parse', () => {
    const once = parseGguiJson({
      ...MINIMAL_V1,
      registry: 'https://registry.ggui.ai',
    });
    const twice = parseGguiJson(JSON.parse(JSON.stringify(once)));
    expect(twice.registry).toBe('https://registry.ggui.ai');
  });
});
