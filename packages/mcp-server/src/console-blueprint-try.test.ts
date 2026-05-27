/**
 * Wire tests for `POST /ggui/console/blueprint/:id/try` — Slice 11.5 C4
 * try-live endpoint.
 *
 * What the endpoint ships:
 *   - Creates a session via the configured `RenderStore`.
 *   - Resolves the blueprint via `UiRegistry.get` + `getBundle`.
 *   - Materializes the bundle code (string OR ReadableStream).
 *   - Pushes a `Render` with `componentCode` + manifest-backed
 *     `propsSpec` / `actionSpec` / `streamSpec`.
 *   - Mints a fresh shortCode, binds it via `ShortCodeIndex`, returns
 *     `{renderId, shortCode, url}`.
 *
 * Gate combinations covered:
 *   - Full wiring (uiRegistry + sessionChannel + shortCodeIndex) →
 *     200 with full payload + real session state.
 *   - uiRegistry alone (no sessionChannel/shortCodeIndex) → 503 with
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
  PropsSpec,
  Render,
  StreamSpec,
} from '@ggui-ai/protocol';
import {
  InMemoryRenderStore,
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
  renderStore: InMemoryRenderStore;
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
    tool: 'tasks_list',
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
    writable: false,
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
  const renderStore = new InMemoryRenderStore();
  const shortCodeIndex = new InMemoryShortCodeIndex();
  const server = createGguiServer({
    logger: silentLogger,
    console: {},
    uiRegistry: makeRegistry(seeds),
    renderStore,
    shortCodeIndex,
    sessionChannel: true,
    // Default the existing pre-F4 tests to `schemaCompatCheck: 'off'`
    // so their test-only fixtures referencing unregistered tool names
    // (`tasks_complete`, `tasks_list`) continue to exercise the
    // bundle / stack-push / shortCode / sessionChannel flow. A separate
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

  it('creates a session + pushes Render with full contract + mints shortCode', async () => {
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
      renderId: string;
      shortCode: string;
      url: string;
    };
    expect(body.renderId).toMatch(/^try-[0-9a-f-]{36}$/);
    expect(body.shortCode).toMatch(/^[a-z0-9]{18}$/);
    expect(body.url).toBe(`/s/${body.shortCode}`);

    // Session exists with our Render.
    const session = await fx.renderStore.get(body.renderId);
    expect(session).not.toBeNull();
    expect(session!.stack).toHaveLength(1);
    const item = session!.stack[0] as Render;
    expect(item.id).toBe('blueprint-todo-list');
    expect(item.componentCode).toBe(BUNDLE_CODE);
    expect(item.contentType).toBe('application/javascript+react');
    // Load-bearing: all three contract fields flowed through.
    expect(item.actionSpec).toEqual(CONTRACT_ACTIONS);
    expect(item.streamSpec).toEqual(CONTRACT_STREAM);
    expect(item.propsSpec).toEqual(CONTRACT_PROPS);

    // ShortCode binding resolves to this session.
    const binding = await fx.shortCodeIndex.lookup(body.shortCode);
    expect(binding).not.toBeNull();
    expect(binding!.renderId).toBe(body.renderId);
    expect(binding!.appId).toBe('builder');
  });

  it('omits absent contract fields — a blueprint with no actionSpec produces a Render with no actionSpec', async () => {
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
    const body = (await res.json()) as { renderId: string };
    const session = await fx.renderStore.get(body.renderId);
    const item = session!.stack[0] as Render;
    expect(item.actionSpec).toBeUndefined();
    expect(item.streamSpec).toBeUndefined();
    expect(item.propsSpec).toBeUndefined();
  });

  it('materializes a ReadableStream bundle into a string componentCode', async () => {
    // Large-bundle path: registries can return code as a stream.
    // The endpoint collapses to a string so the Render carries
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
    const body = (await res.json()) as { renderId: string };
    const session = await fx.renderStore.get(body.renderId);
    const item = session!.stack[0] as Render;
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

  it('503s when uiRegistry is wired but sessionChannel + shortCodeIndex are absent', async () => {
    // Partial wiring — the route mounts (uiRegistry present) but the
    // try path has nowhere to land sessions/shortCodes. Should
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
      // sessionChannel omitted → renderStore also inferred absent
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

  it('schemaCompatCheck=reject: rejects with 422 when action tool is not registered', async () => {
    // CONTRACT_ACTIONS references `tasks_complete` which no mount
    // registers; `reject` mode surfaces `tool-not-found` BEFORE the
    // stack item commits.
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
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      findings: Array<{
        kind: string;
        specName: string;
        toolName: string;
        reason: string;
      }>;
    };
    expect(body.error).toBe('SCHEMA_MISMATCH_ERROR');
    expect(body.findings).toHaveLength(1);
    expect(body.findings[0]?.kind).toBe('action');
    expect(body.findings[0]?.specName).toBe('toggleTask');
    expect(body.findings[0]?.toolName).toBe('tasks_complete');
    expect(body.findings[0]?.reason).toBe('tool-not-found');
  });

  it('schemaCompatCheck=warn: lets the push through; no 422, stack commits', async () => {
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
    const body = (await res.json()) as { renderId: string };
    const session = await fx.renderStore.get(body.renderId);
    expect(session!.stack).toHaveLength(1);
  });

  it('schemaCompatCheck=reject: rejects on streamSpec tool ref too (inverse direction)', async () => {
    // `CONTRACT_STREAM` references `tasks_list` which no mount
    // registers. Same tool-not-found path; proves the streamSpec
    // side of the check fires at this ingress.
    fx = await bootFull(
      [
        {
          id: 'todo-list',
          name: 'Todo List',
          bundle: {
            code: BUNDLE_CODE,
            contentType: 'application/javascript+react',
          },
          contract: { stream: CONTRACT_STREAM },
        },
      ],
      { schemaCompatCheck: 'reject' },
    );
    const res = await fetch(
      `${fx.url}/ggui/console/blueprint/todo-list/try`,
      { method: 'POST' },
    );
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      findings: Array<{
        kind: string;
        specName: string;
        toolName: string;
        reason: string;
      }>;
    };
    expect(body.error).toBe('SCHEMA_MISMATCH_ERROR');
    expect(body.findings[0]?.kind).toBe('stream');
    expect(body.findings[0]?.specName).toBe('tasks');
    expect(body.findings[0]?.toolName).toBe('tasks_list');
    expect(body.findings[0]?.reason).toBe('tool-not-found');
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
    const body = (await res.json()) as { renderId: string };
    const session = await fx.renderStore.get(body.renderId);
    expect(session!.stack).toHaveLength(1);
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
      renderStore: new InMemoryRenderStore(),
      shortCodeIndex: new InMemoryShortCodeIndex(),
      sessionChannel: true,
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
