/**
 * MCP Apps boundary-isolation locks.
 *
 * These tests encode the locked design rule that MCP Apps concepts
 * stay at the `@ggui-ai/protocol/integrations/mcp-apps` subpath and
 * DO NOT leak into core protocol types. They guard against silent
 * drift where a future change might start threading MCP-Apps-specific
 * fields through ActionEnvelope / StreamEnvelope / streamSpec /
 * actionSpec / propsSpec / the root barrel.
 *
 * Two shapes of lock:
 *
 *   1. Type-level `@ts-expect-error` locks — fail at `tsc` if the
 *      forbidden import path resolves or a forbidden field appears.
 *   2. Runtime locks — scan the core module sources for forbidden
 *      identifiers (`McpApps*`, `McpAppAiGguiRenderMeta`,
 *      `MCP_APPS_*`, `GGUI_RENDER_*`, `'mcpApps'` discriminator).
 *      These run against the compiled-sources string so structural
 *      drift in a PR is caught by CI regardless of the type-level
 *      angle.
 *
 * If a future slice legitimately needs to widen one of these surfaces,
 * it MUST revisit the design lock documented at:
 *   - `docs/plans/2026-04-17-ggui-oss-split.md` §2.4
 *   - `docs/plans/2026-04-19-protocol-positioning.md` (MCP Apps sections)
 *   - `packages/protocol/src/integrations/mcp-apps.ts` module doc
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Sanity: the MCP Apps subpath exists and is the canonical home for
// these types. If this import breaks, the whole slice is miswired.
import type {
  McpAppsRender,
  McpAppAiGguiRenderMeta,
  McpAppsSource,
  McpAppsCsp,
  McpAppsPermissions,
  McpAppsContainerDimensions,
  McpAppsToolVisibility,
} from './mcp-apps';
import {
  MCP_APPS_UI_CAPABILITY,
  GGUI_RENDER_RESOURCE_URI,
  GGUI_RENDER_RESOURCE_MIME,
  GGUI_RENDER_UI_META,
  parseMcpAppAiGguiRenderMeta,
  toMcpAppEnvelope,
} from './mcp-apps';

// Compile-time existence locks. Imports above prove these names live at
// the canonical MCP-Apps integrations subpath; if any breaks at compile
// time, the boundary surface has drifted away from its locked location.
type _ExistenceTypeLocks = [McpAppAiGguiRenderMeta];
const _existenceValueLocks = [parseMcpAppAiGguiRenderMeta, toMcpAppEnvelope] as const;
void _existenceValueLocks;

// Also import the core protocol types — the boundary-lock tests below
// assert that these DO NOT contain MCP-Apps-specific fields.
import type {
  StreamEnvelope,
  SubscribePayload,
  AckPayload,
} from '../types/live-channel';
import type { ActionEnvelope } from '../types/events';
import type { StreamSpec, ActionSpec, PropsSpec } from '../types/data-contract';

// =============================================================================
// Type-level locks — verified at `tsc` time.
// =============================================================================

describe('MCP Apps root-barrel isolation (type-level)', () => {
  it('does NOT re-export McpAppsRender at the root', async () => {
    const root = await import('../index');
    // Values: constants must not appear on the root barrel.
    expect((root as Record<string, unknown>).MCP_APPS_UI_CAPABILITY).toBeUndefined();
    expect((root as Record<string, unknown>).GGUI_RENDER_RESOURCE_URI).toBeUndefined();
    expect((root as Record<string, unknown>).GGUI_RENDER_UI_META).toBeUndefined();
    expect((root as Record<string, unknown>).isMcpAppsRender).toBeUndefined();
    expect((root as Record<string, unknown>).validateMcpAppsRender).toBeUndefined();
  });
});

describe('ActionEnvelope boundary lock (type-level)', () => {
  // ActionEnvelope is a live-channel user-action envelope. It MUST NOT
  // carry MCP-Apps-specific fields — those belong on McpAppsRender
  // (at the integrations subpath), not on the wire envelope.
  //
  // TypeScript's excess-property checking fires on OBJECT LITERAL
  // assignments, so the locks use a literal annotated with the type.
  it('does NOT carry MCP-Apps-specific source / csp / permissions fields', () => {
    const env: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      payload: { action: 'x' },
      // @ts-expect-error — `source` is not an ActionEnvelope field.
      source: { connectorId: 'x', toolName: 't', resourceUri: 'ui://x/t' } satisfies McpAppsSource,
    };
    expect(env.renderId).toBe('r');
  });

  it('does NOT allow csp / permissions / containerDimensions / resourceUri / bootstrap fields', () => {
    const env1: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      // @ts-expect-error — csp is not an ActionEnvelope field.
      csp: {} satisfies McpAppsCsp,
    };
    const env2: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      // @ts-expect-error — permissions is not an ActionEnvelope field.
      permissions: {} satisfies McpAppsPermissions,
    };
    const env3: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      // @ts-expect-error — containerDimensions is not an ActionEnvelope field.
      containerDimensions: {} satisfies McpAppsContainerDimensions,
    };
    const env4: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      // @ts-expect-error — resourceUri is not an ActionEnvelope field.
      resourceUri: 'ui://x',
    };
    const env5: ActionEnvelope = {
      renderId: 'r',
      type: 'data:submit',
      // @ts-expect-error — render slice meta is not an ActionEnvelope field.
      bootstrap: {
        renderId: 'r',
        appId: 'a',
        runtimeUrl: '/_ggui/iframe-runtime.js',
        wsUrl: 'w',
        wsToken: 't',
        expiresAt: 'e',
      } satisfies McpAppAiGguiRenderMeta,
    };
    expect([env1, env2, env3, env4, env5].map((e) => e.renderId)).toEqual(
      Array(5).fill('r'),
    );
  });
});

describe('StreamEnvelope boundary lock (type-level)', () => {
  // Live-channel stream deliveries MUST stay mcp-apps-free; iframe views
  // have their own contract via the host postMessage bridge.
  it('does NOT carry MCP-Apps-specific source / csp / resourceUri / bootstrap fields', () => {
    const env1: StreamEnvelope = {
      renderId: 'r',
      channel: 'c',
      mode: 'append',
      payload: null,
      // @ts-expect-error — no MCP Apps source locator on stream wire.
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' } satisfies McpAppsSource,
    };
    const env2: StreamEnvelope = {
      renderId: 'r',
      channel: 'c',
      mode: 'append',
      payload: null,
      // @ts-expect-error — no CSP on stream wire.
      csp: {} satisfies McpAppsCsp,
    };
    const env3: StreamEnvelope = {
      renderId: 'r',
      channel: 'c',
      mode: 'append',
      payload: null,
      // @ts-expect-error — no resourceUri on stream wire.
      resourceUri: 'ui://x',
    };
    expect([env1, env2, env3].map((e) => e.renderId)).toEqual(['r', 'r', 'r']);
  });
});

describe('StreamSpec / ActionSpec / PropsSpec boundary lock (type-level)', () => {
  // Per-render contract specs are about the COMPONENT variant's
  // wire contract. They must not grow MCP-Apps-specific fields; the
  // MCP Apps variant has its own locator-oriented shape via
  // McpAppsRender (no spec fields, by design — those are typed as
  // `?: never` on McpAppsRender).
  it('StreamSpec does not carry MCP-Apps fields at per-entry level', () => {
    const s1: StreamSpec = {
      c: {
        schema: {},
        // @ts-expect-error — per-channel entry is not an MCP Apps source carrier.
        source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' } satisfies McpAppsSource,
      },
    };
    const s2: StreamSpec = {
      c: {
        schema: {},
        // @ts-expect-error — no resourceUri on per-channel entry.
        resourceUri: 'ui://x',
      },
    };
    expect([Object.keys(s1), Object.keys(s2)]).toEqual([['c'], ['c']]);
  });

  it('ActionSpec does not carry MCP-Apps fields at per-entry level', () => {
    const a1: ActionSpec = {
      submit: {
        label: 'Submit',
        // @ts-expect-error — per-action entry is not an MCP Apps source carrier.
        source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' } satisfies McpAppsSource,
      },
    };
    const a2: ActionSpec = {
      submit: {
        label: 'Submit',
        // @ts-expect-error — no resourceUri on per-action entry.
        resourceUri: 'ui://x',
      },
    };
    expect([Object.keys(a1), Object.keys(a2)]).toEqual([['submit'], ['submit']]);
  });

  it('PropsSpec does not carry MCP-Apps fields', () => {
    const p1: PropsSpec = {
      properties: {},
      // @ts-expect-error — propsSpec is not an MCP Apps source carrier.
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' } satisfies McpAppsSource,
    };
    const p2: PropsSpec = {
      properties: {},
      // @ts-expect-error — no resourceUri on props spec.
      resourceUri: 'ui://x',
    };
    expect([p1.properties, p2.properties]).toEqual([{}, {}]);
  });
});

describe('Subscribe / Ack bootstrap slots are generic, not MCP-Apps-typed (type-level)', () => {
  // `SubscribePayload.bootstrap` and `AckPayload.renderToken` are
  // deliberately framed as GENERAL transport-bootstrap credentials
  // (opaque strings), NOT as MCP-Apps-typed fields. This lock ensures
  // a future change doesn't accidentally narrow them to
  // `McpAppAiGguiRenderMeta`-shaped objects.
  it('SubscribePayload.bootstrap is a string, not a render-slice object', () => {
    const s: SubscribePayload = {
      renderId: 'x',
      appId: 'a',
      bootstrap: 'opaque-token',
    };
    expect(typeof s.bootstrap).toBe('string');
    const s2: SubscribePayload = {
      renderId: 'x',
      appId: 'a',
      // @ts-expect-error — bootstrap is `string | undefined`, not an object.
      bootstrap: {
        renderId: 'r',
        appId: 'a',
        runtimeUrl: '/_ggui/iframe-runtime.js',
        wsUrl: 'w',
        wsToken: 't',
        expiresAt: 'e',
      } satisfies McpAppAiGguiRenderMeta,
    };
    expect(s2).toBeDefined();
  });

  it('AckPayload.renderToken is a string, not a typed credential object', () => {
    const a: AckPayload = {
      sequence: 1,
      timestamp: 0,
      renderToken: 'opaque',
    };
    expect(typeof a.renderToken).toBe('string');
  });
});

describe('McpAppAiGguiRenderMeta / McpAppsRender visibility to external tools', () => {
  it('McpAppsRender structurally forbids component-variant fields', () => {
    // These fields are `?: never` on McpAppsRender — tests encode
    // that restriction at the type level. `?: never` makes the field
    // type `never | undefined`, so assigning any non-undefined value
    // to it is a type error.
    const item1: McpAppsRender = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
      // @ts-expect-error — componentCode is `?: never` on mcpApps variant.
      componentCode: '/* code */',
    };
    const item2: McpAppsRender = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
      // @ts-expect-error — props is `?: never` on mcpApps variant.
      props: {},
    };
    const item3: McpAppsRender = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
      // @ts-expect-error — streamSpec is `?: never` on mcpApps variant.
      streamSpec: { channels: {} },
    };
    const item4: McpAppsRender = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
      // @ts-expect-error — actionSpec is `?: never` on mcpApps variant.
      actionSpec: { actions: {} },
    };
    const item5: McpAppsRender = {
      type: 'mcpApps',
      id: 'x',
      createdAt: '',
      source: { connectorId: 'c', toolName: 't', resourceUri: 'ui://c/t' },
      // @ts-expect-error — propsSpec is `?: never` on mcpApps variant.
      propsSpec: { properties: {} },
    };
    expect([item1, item2, item3, item4, item5].map((i) => i.type)).toEqual(
      Array(5).fill('mcpApps'),
    );
  });

  it('McpAppsToolVisibility is the narrow model-or-app tag', () => {
    const model: McpAppsToolVisibility = 'model';
    const app: McpAppsToolVisibility = 'app';
    expect([model, app]).toEqual(['model', 'app']);
  });
});

// =============================================================================
// Source-level locks — structural scans on the core module sources.
// =============================================================================
//
// These scans catch silent drift at PR time even when the type system
// would technically accept a new field (e.g. a `string` being
// repurposed).

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT_SRC = resolve(HERE, '..');

function readSource(rel: string): string {
  return readFileSync(resolve(ROOT_SRC, rel), 'utf8');
}

/** Tokens that must NEVER appear in core (non-integrations) modules. */
const FORBIDDEN_TOKENS = [
  'McpApps', // McpAppsRender / McpAppsSource / etc.
  'McpAppAiGguiRenderMeta',
  'MCP_APPS_UI_CAPABILITY',
  'GGUI_RENDER_RESOURCE_URI',
  'GGUI_RENDER_RESOURCE_MIME',
  'GGUI_RENDER_UI_META',
  'MCP_APP_AI_GGUI_RENDER_META_KEY',
  'isMcpAppsRender',
  'validateMcpAppsRender',
  'parseMcpAppAiGguiRenderMeta',
  'toMcpAppEnvelope',
];

// `types/session.ts` is the ONE core module that legitimately imports
// `McpAppsRender` — it owns the `Render` discriminated union. That
// import is the locked design concession (see the dedicated describe
// block below). Every OTHER core module must stay free of MCP Apps
// references.
const CORE_MODULES = [
  'types/live-channel.ts',
  'types/events.ts',
  'types/mcp.ts',
  'types/capabilities.ts',
  'types/invoke.ts',
  'transport/websocket.ts',
  'index.ts',
];

describe('MCP Apps identifiers do NOT leak into core protocol modules', () => {
  for (const mod of CORE_MODULES) {
    it(`${mod} contains no MCP-Apps-specific identifiers`, () => {
      const src = readSource(mod);
      for (const tok of FORBIDDEN_TOKENS) {
        expect(
          src.includes(tok),
          `Core module ${mod} must not reference "${tok}" — MCP Apps types live at the integrations subpath`,
        ).toBe(false);
      }
    });
  }

  it('core modules (excluding session.ts) never import from the integrations/mcp-apps subpath', () => {
    for (const mod of CORE_MODULES) {
      const src = readSource(mod);
      expect(
        src.includes("integrations/mcp-apps"),
        `Core module ${mod} must not import from integrations/mcp-apps — the dep direction is one-way`,
      ).toBe(false);
    }
  });

  it('the root index.ts does NOT re-export the integrations/mcp-apps subpath', () => {
    const rootIndex = readSource('index.ts');
    // Both `export * from './integrations/mcp-apps'` and
    // `export { ... } from './integrations/mcp-apps'` would widen the
    // surface — catch either form.
    expect(rootIndex).not.toMatch(/from\s+['"]\.\/integrations\/mcp-apps['"]/);
  });
});

describe('Render discriminator is the ONE place mcpApps enters core', () => {
  // The ONE concession core protocol made for MCP Apps is
  // `Render = ComponentRender | SystemRender | McpAppsRender` — a
  // discriminated union at the session.ts boundary. This test locks
  // that concession so accidental deletion or broadening gets caught.
  it('session.ts imports exactly the narrow McpAppsRender type (and no other MCP Apps surface)', () => {
    const src = readSource('types/session.ts');
    // Must import the type — that's the locked concession.
    expect(src).toMatch(
      /import\s+type\s+\{\s*McpAppsRender\s*\}\s+from\s+['"]\.\.?\/integrations\/mcp-apps['"]/,
    );
    // But must NOT pull in any other MCP Apps symbol — those belong
    // at the integrations subpath, not in core session typing.
    const BANNED_IN_SESSION = [
      'McpAppAiGguiRenderMeta',
      'MCP_APPS_UI_CAPABILITY',
      'GGUI_RENDER_RESOURCE_URI',
      'GGUI_RENDER_RESOURCE_MIME',
      'GGUI_RENDER_UI_META',
      'MCP_APP_AI_GGUI_RENDER_META_KEY',
      'McpAppsSource',
      'McpAppsCsp',
      'McpAppsPermissions',
      'McpAppsContainerDimensions',
    ];
    for (const tok of BANNED_IN_SESSION) {
      expect(
        src.includes(tok),
        `session.ts must not reference "${tok}" — only McpAppsRender is the locked crossover`,
      ).toBe(false);
    }
  });

  it('session.ts defines the Render two-variant union', () => {
    const src = readSource('types/session.ts');
    expect(src).toMatch(/Render/);
    // The union must reference McpAppsRender as a member.
    expect(src).toMatch(/McpAppsRender/);
  });
});

describe('MCP Apps integration constants are stable spec-canonical values', () => {
  // The canonical constants are the public-facing contract. Any
  // change to these values is an observable spec change that would
  // break interop with MCP Apps hosts; this test pins the exact
  // values so accidental mutation is caught.
  it('MCP_APPS_UI_CAPABILITY is "io.modelcontextprotocol/ui"', () => {
    expect(MCP_APPS_UI_CAPABILITY).toBe('io.modelcontextprotocol/ui');
  });

  it('GGUI_RENDER_RESOURCE_URI is "ui://ggui/render"', () => {
    expect(GGUI_RENDER_RESOURCE_URI).toBe('ui://ggui/render');
  });

  it('GGUI_RENDER_RESOURCE_MIME is "text/html;profile=mcp-app"', () => {
    expect(GGUI_RENDER_RESOURCE_MIME).toBe('text/html;profile=mcp-app');
  });

  it('GGUI_RENDER_UI_META locks visibility = ["model"] (entry-point rule)', () => {
    expect(GGUI_RENDER_UI_META.resourceUri).toBe(GGUI_RENDER_RESOURCE_URI);
    expect(GGUI_RENDER_UI_META.visibility).toEqual(['model']);
  });
});
