/**
 * Wire tests for `POST /ggui/console/blueprint/:id/try` — Slice 11.5 C4
 * try-live endpoint.
 *
 * What the endpoint ships:
 *   - Creates a render via the configured `GguiSessionStore`.
 *   - Resolves the blueprint via `UiRegistry.get` + `getBundle`.
 *   - Materializes the bundle code (string OR ReadableStream).
 *   - Commits a `GguiSession` with `componentCode` + manifest-backed
 *     `propsSpec` / `actionSpec` / `streamSpec`.
 *   - Mints a fresh shortCode, binds it via `ShortCodeIndex`, returns
 *     `{sessionId, shortCode, url}`.
 *
 * Gate combinations covered:
 *   - Full wiring (uiRegistry + renderChannel + shortCodeIndex) →
 *     200 with full payload + real render state.
 *   - uiRegistry alone (no renderChannel/shortCodeIndex) → 503 with
 *     the "try_not_wired" remediation code.
 *   - No uiRegistry at all → 404 (sibling GET also absent; the route
 *     doesn't mount).
 *
 * Failure cases:
 *   - Unknown id → 404 `not_found`.
 *   - Known id, no bundle → 404 `bundle_not_available`.
 *   - Empty / oversized id → 400 `invoked_request`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type {
  ActionSpec,
  ComponentGguiSession,
  PropsSpec,
  StreamSpec,
} from '@ggui-ai/protocol';
import {
  InMemoryGguiSessionStore,
  InMemoryShortCodeIndex,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  UiBundle,
  UiManifestEntry,
  UiRegistry,
  UiRegistryCapabilities,
} from '@ggui-ai/ui-registry';
import { createGguiServer, type GguiServer } from './server.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

interface Fixture {
  server: GguiServer;
  httpServer: HttpServer;
  url: string;
  renderStore: InMemoryGguiSessionStore;
  shortCodeIndex: InMemoryShortCodeIndex;
}

const CONTRACT_PROPS: PropsSpec = {
  properties: {
    title: {
      description: 'Page title',
      schema: { type: 'string' },
      required: true,
    },
  },
};

const CONTRACT_ACTIONS: ActionSpec = {
  toggleTask: {
    label: 'Toggle task',
    schema: {
      type: 'object',
      properties: { id: { type: 'string' } },
      required: ['id'],
    },
    nextStep: 'tasks_complete',
  },
};

const CONTRACT_STREAM: StreamSpec = {
  tasks: {
    schema: {
      type: 'object',
      properties: { items: { type: 'array', items: { type: 'object' } } },
      required: ['items'],
    },
  },
};

const BUNDLE_CODE = "export default function Todo() { return null; }";

interface BlueprintSeed {
  readonly id: string;
  readonly name: string;
  readonly bundle?: UiBundle; // absent → getBundle returns undefined
  readonly contract?: {
    propsSpec?: PropsSpec;
    actions?: ActionSpec;
    stream?: StreamSpec;
  };
}

function makeRegistry(seeds: readonly BlueprintSeed[]): UiRegistry {
  const capabilities: UiRegistryCapabilities = {
    observable: false,
  };
  return {
    capabilities,
    async list(): Promise<UiManifestEntry[]> {
      return seeds.map((s) => ({
        id: s.id,
        contentHash: `hash-${s.id}`,
        manifest: {
          id: s.id,
          name: s.name,
          contract: {
            intent: `test intent for ${s.id}`,
            ...(s.contract?.propsSpec ? { propsSpec: s.contract.propsSpec } : {}),
            ...(s.contract?.actions
              ? { actionSpec: s.contract.actions }
              : {}),
            ...(s.contract?.stream
              ? { streamSpec: s.contract.stream }
              : {}),
          },
        } as UiManifestEntry['manifest'],
      }));
    },
    async get(id: string): Promise<UiManifestEntry | undefined> {
      const s = seeds.find((x) => x.id === id);
      if (!s) return undefined;
      return {
        id: s.id,
        contentHash: `hash-${s.id}`,
        manifest: {
          id: s.id,
          name: s.name,
          contract: {
            intent: `test intent for ${s.id}`,
            ...(s.contract?.propsSpec ? { propsSpec: s.contract.propsSpec } : {}),
            ...(s.contract?.actions
              ? { actionSpec: s.contract.actions }
              : {}),
            ...(s.contract?.stream
              ? { streamSpec: s.contract.stream }
              : {}),
          },
        } as UiManifestEntry['manifest'],
      };
    },
    async getBundle(id: string): Promise<UiBundle | undefined> {
      const s = seeds.find((x) => x.id === id);
      return s?.bundle;
    },
  };
}

async function bootFull(
  seeds: readonly BlueprintSeed[],
  overrides?: {
    readonly schemaCompatCheck?: 'reject' | 'warn' | 'off';
    readonly mcpMounts?: ReadonlyArray<
      import('./mcp-mounts.js').McpServerMount
    >;
  },
): Promise<Fixture> {
  const renderStore = new InMemoryGguiSessionStore();
  const shortCodeIndex = new InMemoryShortCodeIndex();
  const server = createGguiServer({
    logger: silentLogger,
    console: {},
    uiRegistry: makeRegistry(seeds),
    renderStore,
    shortCodeIndex,
    renderChannel: true,
    // Default the existing pre-F4 tests to `schemaCompatCheck: 'off'`
    // so their test-only fixtures referencing the unregistered tool
    // name `tasks_complete` continue to exercise the bundle /
    // render-commit / shortCode / renderChannel flow. A separate
    // describe block below covers the F4 check firing end-to-end.
    schemaCompatCheck: overrides?.schemaCompatCheck ?? 'off',
    ...(overrides?.mcpMounts ? { mcpMounts: overrides.mcpMounts } : {}),
  });
  const httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  return {
    server,
    httpServer,
    url: `http://127.0.0.1:${addr.port}`,
    renderStore,
    shortCodeIndex,
  };
}

describe('POST /ggui/console/blueprint/:id/try', () => {
  let fx: Fixture | null = null;

  afterEach(async () => {
    if (fx) {
      await fx.server.close();
      fx = null;
    }
  });

  it('creates a render + commits GguiSession with full contract + mints shortCode', async () => {
    fx = await bootFull([
      {
        id: 'todo-list',
        name: 'Todo List',
        bundle: {
          code: BUNDLE_CODE,
          contentType: 'application/javascript+react',
        },
        contract: {
          propsSpec: CONTRACT_PROPS,
          actions: CONTRACT_ACTIONS,
          stream: CONTRACT_STREAM,
        },
      },
    ]);

    const res = await fetch(`${fx.url}/ggui/console/blueprint/todo-list/try`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      sessionId: string;
      shortCode: string;
      url: string;
    };
    // Phase B identity collapse: the prior (sessionId=`try-<uuid>`,
    // stackItemId=`blueprint-<bpId>`) pair collapsed to one sessionId
    // `try-<bpId>-<uuid>`. The blueprint slug stays in the id for
    // debug readability; the uuid disambiguates same-blueprint retries.
    expect(body.sessionId).toMatch(/^try-[a-z0-9-]+-[0-9a-f-]{36}$/);
    expect(body.shortCode).toMatch(/^[a-z0-9]{18}$/);
    expect(body.url).toBe(`/s/${body.shortCode}`);

    // Stored render row exists with our GguiSession payload. Post-collapse
    // `render.id === sessionId` (single identity).
    const stored = await fx.renderStore.get(body.sessionId);
    expect(stored).not.toBeNull();
    const item = stored!.render as ComponentGguiSession;
    expect(item.id).toBe(body.sessionId);
    expect(item.componentCode).toBe(BUNDLE_CODE);
    expect(item.contentType).toBe('application/javascript+react');
    // Load-bearing: all three contract fields flowed through.
    expect(item.actionSpec).toEqual(CONTRACT_ACTIONS);
    expect(item.streamSpec).toEqual(CONTRACT_STREAM);
    expect(item.propsSpec).toEqual(CONTRACT_PROPS);

    // ShortCode binding resolves to this render row. Post Phase-B
    // the binding is the (sessionId, appId) pair — the previous
    // `sessionId` slot was renamed to `sessionId` along with the
    // identity collapse.
    const binding = await fx.shortCodeIndex.lookup(body.shortCode);
    expect(binding).not.toBeNull();
    expect(binding!.sessionId).toBe(body.sessionId);
    expect(binding!.appId).toBe('builder');
  });

  it('omits absent contract fields — a blueprint with no actionSpec produces a GguiSession with no actionSpec', async () => {
    fx = await bootFull([
      {
        id: 'static-card',
        name: 'Static Card',
        bundle: {
          code: BUNDLE_CODE,
          contentType: 'application/javascript+react',
        },
        // no actions / stream / props
      },
    ]);

    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/static-card/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const stored = await fx.renderStore.get(body.sessionId);
    const item = stored!.render as ComponentGguiSession;
    expect(item.actionSpec).toBeUndefined();
    expect(item.streamSpec).toBeUndefined();
    expect(item.propsSpec).toBeUndefined();
  });

  it('materializes a ReadableStream bundle into a string componentCode', async () => {
    // Large-bundle path: registries can return code as a stream.
    // The endpoint collapses to a string so the GguiSession carries
    // inline-renderable componentCode.
    const encoder = new TextEncoder();
    const streamCode = "// streamed bundle\n" + BUNDLE_CODE;
    fx = await bootFull([
      {
        id: 'streamed',
        name: 'Streamed',
        bundle: {
          code: new ReadableStream({
            start(controller) {
              controller.enqueue(encoder.encode(streamCode.slice(0, 10)));
              controller.enqueue(encoder.encode(streamCode.slice(10)));
              controller.close();
            },
          }),
          contentType: 'application/javascript+react',
        },
      },
    ]);

    const res = await fetch(`${fx.url}/ggui/console/blueprint/streamed/try`, {
      method: 'POST',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const stored = await fx.renderStore.get(body.sessionId);
    const item = stored!.render as ComponentGguiSession;
    expect(item.componentCode).toBe(streamCode);
  });

  it('404s when the blueprint id is not registered', async () => {
    fx = await bootFull([
      {
        id: 'todo-list',
        name: 'Todo List',
        bundle: { code: BUNDLE_CODE, contentType: 'application/javascript' },
      },
    ]);

    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/does-not-exist/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('not_found');
  });

  it('404s when the blueprint has no bundle (source-only)', async () => {
    fx = await bootFull([
      {
        id: 'source-only',
        name: 'Source Only',
        // no bundle
      },
    ]);

    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/source-only/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('bundle_not_available');
  });

  it('400s on empty id segment', async () => {
    fx = await bootFull([
      {
        id: 'todo-list',
        name: 'Todo List',
        bundle: { code: BUNDLE_CODE, contentType: 'application/javascript' },
      },
    ]);

    // Express strips empty path segments before our handler runs, so an
    // actually-empty `:id` presents as a 404 on the base path. The 400
    // branch covers the oversized case too — exercise that.
    const longId = 'x'.repeat(300);
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/${longId}/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_request');
  });

  it('503s when uiRegistry is wired but renderChannel + shortCodeIndex are absent', async () => {
    // Partial wiring — the route mounts (uiRegistry present) but the
    // try path has nowhere to land renders/shortCodes. Should
    // short-circuit with a specific error code so the operator knows
    // which gate to flip.
    const server = createGguiServer({
      logger: silentLogger,
      console: {},
      uiRegistry: makeRegistry([
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript',
          },
        },
      ]),
      // renderChannel omitted → renderStore also inferred absent
      // shortCodeIndex omitted
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    try {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      const url = `http://127.0.0.1:${addr.port}`;
      const res = await fetch(
        `${url}/ggui/console/blueprint/todo-list/try`,
        { method: 'POST' },
      );
      expect(res.status).toBe(503);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe('try_not_wired');
    } finally {
      await server.close();
    }
  });

  // ── F4 schema compat check (Phase 1 Item 5) ──────────────────
  //
  // Fires at blueprint-registration time (console blueprint-try is the
  // real-world ingress). Three modes — reject / warn / off — cover
  // every operator posture.

  it('schemaCompatCheck=reject: action tool-not-found is advisory → renders (200)', async () => {
    // CONTRACT_ACTIONS references `tasks_complete` which no mount
    // registers. `nextStep` is a documented HINT the agent owns and
    // ggui never dispatches, so an unresolved action `nextStep` is
    // tagged warn-severity — even under `reject` mode it does NOT
    // block the render; the render commits.
    fx = await bootFull(
      [
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript+react',
          },
          contract: { actions: CONTRACT_ACTIONS },
        },
      ],
      { schemaCompatCheck: 'reject' },
    );
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/todo-list/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const stored = await fx.renderStore.get(body.sessionId);
    expect(stored).not.toBeNull();
    // Phase B identity collapse: render.id === sessionId.
    expect(stored!.render.id).toBe(body.sessionId);
  });

  it('schemaCompatCheck=warn: lets the render through; no 422, render commits', async () => {
    fx = await bootFull(
      [
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript+react',
          },
          contract: { actions: CONTRACT_ACTIONS },
        },
      ],
      { schemaCompatCheck: 'warn' },
    );
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/todo-list/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const stored = await fx.renderStore.get(body.sessionId);
    expect(stored).not.toBeNull();
    // Phase B identity collapse: render.id === sessionId.
    expect(stored!.render.id).toBe(body.sessionId);
  });

  it('schemaCompatCheck=reject: compat passes when mcpMount registers the tool with matching schemas', async () => {
    // Wire an `mcpMount` carrying `tasks_complete` whose inputSchema
    // aligns with a strictly-shaped action schema (additionalProperties:
    // false on both sides, same required fields). Compat passes;
    // endpoint returns 200.
    const { z } = await import('zod');
    const taskMount: import('./mcp-mounts.js').McpServerMount = {
      name: 'tasks',
      handlers: [
        {
          name: 'tasks_complete',
          description: 'Complete a task',
          inputSchema: {
            id: z.string(),
          },
          outputSchema: {
            ok: z.boolean(),
          },
          async handler() {
            return { ok: true };
          },
        },
      ],
    };
    const strictActionContract: ActionSpec = {
      toggleTask: {
        label: 'Toggle task',
        schema: {
          type: 'object',
          properties: { id: { type: 'string' } },
          required: ['id'],
          // zod objects serialize to draft-with additionalProperties:
          // false — author-side schemas must match to be a subset.
          additionalProperties: false,
        },
        nextStep: 'tasks_complete',
      },
    };
    fx = await bootFull(
      [
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript+react',
          },
          contract: { actions: strictActionContract },
        },
      ],
      { schemaCompatCheck: 'reject', mcpMounts: [taskMount] },
    );
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/todo-list/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { sessionId: string };
    const stored = await fx.renderStore.get(body.sessionId);
    expect(stored).not.toBeNull();
    // Phase B identity collapse: render.id === sessionId.
    expect(stored!.render.id).toBe(body.sessionId);
  });

  it('schemaCompatCheck=off: skips the check entirely (already exercised by the base tests)', async () => {
    // `off` is the default the pre-F4 tests use. Assert explicitly
    // so future regressions of the default-mode behavior fail loudly
    // at this test, not at the unrelated base suite.
    fx = await bootFull(
      [
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript+react',
          },
          contract: { actions: CONTRACT_ACTIONS },
        },
      ],
      { schemaCompatCheck: 'off' },
    );
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/todo-list/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
  });

  it('404s (route absent) when uiRegistry is not wired at all', async () => {
    // No uiRegistry = no sibling GET, no /try — the endpoint simply
    // never mounts, so Express serves its stock 404.
    const server = createGguiServer({
      logger: silentLogger,
      console: {},
      renderStore: new InMemoryGguiSessionStore(),
      shortCodeIndex: new InMemoryShortCodeIndex(),
      renderChannel: true,
    });
    const httpServer = await server.listen(0, '127.0.0.1');
    try {
      const addr = httpServer.address();
      if (!addr || typeof addr === 'string') throw new Error('no addr');
      const url = `http://127.0.0.1:${addr.port}`;
      const res = await fetch(
        `${url}/ggui/console/blueprint/anything/try`,
        { method: 'POST' },
      );
      expect(res.status).toBe(404);
    } finally {
      await server.close();
    }
  });
});
