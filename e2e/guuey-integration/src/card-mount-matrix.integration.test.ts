/**
 * ggui × guuey first-integrator interop matrix (ggui#429).
 *
 * ggui's published render surface, consumed through guuey's PUBLIC SDK
 * exactly as their pod + portal consume it — with zero guuey
 * infrastructure:
 *
 *   - the ggui side is a REAL `createGguiServer` on an ephemeral port,
 *     driven over the real MCP Streamable-HTTP wire;
 *   - the fold is the REAL `@silverprotocol/core` Reducer (the `_meta`
 *     carriage onto tool-result blocks — core 0.4.1, workspace#9 — is
 *     exactly what makes ggui cards mountable, so it is exercised, not
 *     hand-constructed);
 *   - persistence is `@guuey/threads`' `ThreadStore` over
 *     `InMemoryThreadPersistence` — the verbatim-extracted hosted-pod
 *     logic (guuey#107), including the card projection (guuey#86);
 *   - mounting is `@guuey/mcp-apps-host`'s both-channel dispatcher
 *     (`toolResultViewMount` / `snapshotViewMount`).
 *
 * Matrix (issue #429):
 *   1. live mount — ggui tool-result → fold → `toolResultViewMount`,
 *      plus VERBATIM slice parity against ggui's own protocol
 *      host-helper (`toolResultGguiRender`, ggui#427).
 *   2. persist → rehydrate — inline mcp-ui resource through
 *      `appendFold` → card row → `snapshotViewMount`; live ≍ rehydrated.
 *   3. provider-raw channel — a `ui://` resource degraded into a
 *      `provider-raw` content part mounts on BOTH arms.
 *   4. ggui-channel snapshot honesty — pins today's deliberate
 *      behavior (persisted ggui bootstraps are not remountable); the
 *      re-mint design input lives on the issue.
 *
 * The `@guuey/*` pins are EXACT (0.3.0): the point is testing ggui
 * HEAD against the versions guuey actually shipped. The pins are
 * dev-side test harness only — no published `@ggui-ai/*` package
 * depends on anything above MCP.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Server as HttpServer } from 'node:http';
import { createGguiServer, type GguiServer } from '@ggui-ai/mcp-server';
import { InMemoryAuthAdapter, InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import {
  MCP_APP_AI_GGUI_RENDER_META_KEY,
  toolResultGguiRender,
  asGguiRenderBootstrap,
} from '@ggui-ai/protocol/integrations/mcp-apps';
import {
  Reducer,
  type AgBlock,
  type AgReduceResult,
  type JsonValue,
} from '@silverprotocol/core';
import { snapshotViewMount, toolResultViewMount } from '@guuey/mcp-apps-host';
import { InMemoryThreadPersistence, ThreadStore } from '@guuey/threads';

// ───────────────────────────────────────────────────────────────────────
// ggui server fixture — real server, real wire
// ───────────────────────────────────────────────────────────────────────

const AGENT_TOKEN = 'interop-agent-token';

interface SilentLogger {
  info(): void;
  warn(): void;
  error(): void;
  debug(): void;
  child(): SilentLogger;
}

const silentLogger: SilentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

let server: GguiServer;
let httpServer: HttpServer;
let baseUrl = '';
let client: Client;
let renderStore: GguiSessionStore;

beforeAll(async () => {
  // Held externally so the harness can commit mock componentCode into the
  // same instance the server reads — no generator runs in this suite.
  renderStore = new InMemoryGguiSessionStore();

  server = createGguiServer({
    logger: silentLogger,
    auth: new InMemoryAuthAdapter({
      seedTokens: [
        {
          token: AGENT_TOKEN,
          result: { identity: { kind: 'builder' }, source: 'apikey' },
        },
      ],
    }),
    // mcpApps on ⇒ every ggui_render result carries the
    // `ai.ggui/render` slice (wsUrl + short-TTL wsToken); the runtime
    // bundle mount defaults on with it.
    mcpApps: true,
    renderChannel: true,
    renderStore,
  });
  httpServer = await server.listen(0, '127.0.0.1');
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('server.address() did not return AddressInfo');
  }
  baseUrl = `http://127.0.0.1:${addr.port}`;

  client = new Client({ name: 'guuey-interop-harness', version: '0.0.1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${AGENT_TOKEN}` } },
    }),
  );
});

afterAll(async () => {
  await client?.close();
  await server?.close();
});

// ───────────────────────────────────────────────────────────────────────
// Fold helpers — the guuey-pod-shaped ingestion of a tool result
// ───────────────────────────────────────────────────────────────────────

interface ToolDoneMaterial {
  readonly uiData?: unknown;
  readonly meta?: unknown;
  readonly content?: unknown[];
}

/**
 * Drive the REAL Reducer with the minimal well-formed per-invoke event
 * stream (gap-free `seq`, open message pointer, completed outcome) and
 * return the folded tool-result block. Mirrors the guuey pod's Claude
 * facet: a ggui tool result's `structuredContent` routes to `uiData`
 * and its `_meta` rides the tool.done event (core 0.4.1 carries it
 * onto the block — workspace#9).
 */
function foldToolDone(material: ToolDoneMaterial): {
  fold: AgReduceResult;
  block: Extract<AgBlock, { type: 'tool-result' }>;
} {
  const reducer = new Reducer();
  const events = [
    { seq: 0, type: 'turn.start', turnId: 'turn1', threadId: 'thread1' },
    {
      seq: 1,
      type: 'message.start',
      turnId: 'turn1',
      threadId: 'thread1',
      id: 'm1',
      role: 'assistant',
    },
    {
      seq: 2,
      type: 'tool.start',
      turnId: 'turn1',
      toolCallId: 'call1',
      name: 'ggui_render',
      input: {},
    },
    {
      seq: 3,
      type: 'tool.done',
      turnId: 'turn1',
      toolCallId: 'call1',
      content: material.content ?? [],
      ...(material.uiData !== undefined ? { uiData: material.uiData } : {}),
      ...(material.meta !== undefined ? { _meta: material.meta } : {}),
    },
    {
      seq: 4,
      type: 'turn.done',
      turnId: 'turn1',
      finishReason: 'stop',
      outcome: { type: 'completed' },
    },
  ];
  for (const ev of events) {
    reducer.push(ev as Parameters<Reducer['push']>[0]);
  }
  expect(reducer.needsResync).toBe(false);
  const fold = reducer.result();
  const block = fold.messages[0]?.content.find(
    (b): b is Extract<AgBlock, { type: 'tool-result' }> =>
      b.type === 'tool-result',
  );
  if (block === undefined) {
    throw new Error('fold produced no tool-result block');
  }
  return { fold, block };
}

/** Extract + parse the `__GGUI_META__` envelope from a shell HTML string. */
function shellEnvelope(html: string): Record<string, unknown> {
  const match = html.match(/__GGUI_META__\s*=\s*(.*?);<\/script>/);
  expect(match).not.toBeNull();
  const raw = match![1]!
    .replace(/\\u003c/g, '<')
    .replace(/\\u003e/g, '>')
    .replace(/\\u0026/g, '&');
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('shell envelope is not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

async function renderOnce(): Promise<Record<string, unknown>> {
  const handshake = await client.callTool({
    name: 'ggui_handshake',
    arguments: {
      intent: 'weekend reading list with checkable items',
      blueprintDraft: { contract: {} },
    },
  });
  const handshakeId = (
    handshake.structuredContent as { handshakeId: string }
  ).handshakeId;
  expect(handshakeId).toBeTruthy();
  const result = await client.callTool({
    name: 'ggui_render',
    arguments: { handshakeId, props: {}, override: { contract: {} } },
  });
  return result as Record<string, unknown>;
}

// ───────────────────────────────────────────────────────────────────────
// Matrix 1 — live ggui-channel mount
// ───────────────────────────────────────────────────────────────────────

describe('matrix 1 — live ggui render mounts through guuey narrowing', () => {
  it('real ggui_render result → Reducer fold → toolResultViewMount, slice verbatim', async () => {
    const result = await renderOnce();

    // The pod's Claude facet routes structuredContent → uiData and
    // carries _meta on the tool.done event.
    const { block } = foldToolDone({
      uiData: result.structuredContent,
      meta: result._meta,
    });

    const mount = toolResultViewMount(block);
    expect(mount).toBeDefined();
    expect(mount?.channel).toBe('ggui');
    if (mount === undefined || mount.channel === 'locator') {
      // Unreachable past the two expects above — narrows the 0.3.0
      // ViewMount union to its resource-bearing arm.
      throw new Error('expected a resource-bearing ggui mount');
    }

    // The mounted shell inlines the slice envelope — parse it back out
    // and compare VERBATIM against ggui's own host-helper narrowing of
    // the SAME wire result (ggui#427). Both sides must agree on every
    // byte of the slice: guuey's copy and ggui's export cannot drift.
    const bootstrap = toolResultGguiRender(result);
    expect(bootstrap).toBeDefined();
    const envelope = shellEnvelope(mount.resource.text ?? '');
    expect(envelope[MCP_APP_AI_GGUI_RENDER_META_KEY]).toEqual(bootstrap!.slice);

    // Live-mode slice sanity: the render channel minted real creds.
    const slice = bootstrap!.slice;
    expect(typeof slice.wsToken).toBe('string');
    expect(String(slice.wsUrl)).toContain('/ws');
  });
});

// ───────────────────────────────────────────────────────────────────────
// Matrix 2 — inline resource: persist → rehydrate parity
// ───────────────────────────────────────────────────────────────────────

const INLINE_RESOURCE = {
  uri: 'ui://acme/dashboard',
  mimeType: 'text/html',
  text: '<!doctype html><html><body data-acme-card>inline card</body></html>',
};

/**
 * Round-trip through JSON — persisted snapshots ARE JSON data (that is
 * the persistence guarantee), and the parse re-narrows `unknown` to
 * `JsonValue` without a cast.
 */
function toJsonValue(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value));
}

async function persistAndReadCards(fold: AgReduceResult): Promise<JsonValue[]> {
  const db = new InMemoryThreadPersistence();
  const store = new ThreadStore(db);
  const threadId = await store.ensureThread({
    userId: 'g_interop',
    appId: 'app_interop',
    region: 'us-east-1',
  });
  await store.appendFold({
    threadId,
    userId: 'g_interop',
    fold,
    clientMessageIdBase: 'interop-turn-1',
  });
  const rows = await db.listRecentMessages(threadId, 50);
  return rows
    .filter((r) => r.kind === 'card' && r.cardSnapshot !== undefined)
    .map((r) => toJsonValue(r.cardSnapshot));
}

describe('matrix 2 — inline mcp-ui resource: live ≍ rehydrated', () => {
  it('the same fold mounts identically live and after ThreadStore persistence', async () => {
    const { fold, block } = foldToolDone({ uiData: INLINE_RESOURCE });

    const live = toolResultViewMount(block);
    expect(live).toBeDefined();
    expect(live?.channel).toBe('inline');
    if (live === undefined || live.channel === 'locator') {
      // Unreachable past the two expects above — narrows the 0.3.0
      // ViewMount union to its resource-bearing arm.
      throw new Error('expected an inline resource mount');
    }
    expect(live.resource.uri).toBe(INLINE_RESOURCE.uri);
    expect(live.resource.text).toBe(INLINE_RESOURCE.text);

    const artifacts = await persistAndReadCards(fold);
    expect(artifacts).toHaveLength(1);
    const rehydrated = snapshotViewMount(artifacts[0]!);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.channel).toBe('inline');
    if (rehydrated === undefined || rehydrated.channel === 'locator') {
      throw new Error('expected an inline resource mount after rehydration');
    }
    expect(rehydrated.resource).toEqual(live.resource);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Matrix 3 — provider-raw ui:// channel, both arms
// ───────────────────────────────────────────────────────────────────────

describe('matrix 3 — provider-raw-degraded ui:// resource mounts on both arms', () => {
  it('a ui:// resource inside provider-raw.raw mounts live AND rehydrated', async () => {
    const { fold, block } = foldToolDone({
      content: [
        {
          type: 'provider-raw',
          vendor: 'anthropic',
          raw: { resource: INLINE_RESOURCE },
        },
      ],
    });

    const live = toolResultViewMount(block);
    expect(live).toBeDefined();
    expect(live?.channel).toBe('inline');
    if (live === undefined || live.channel === 'locator') {
      // Unreachable past the two expects above — narrows the 0.3.0
      // ViewMount union to its resource-bearing arm.
      throw new Error('expected an inline resource mount');
    }
    expect(live.resource.uri).toBe(INLINE_RESOURCE.uri);

    const artifacts = await persistAndReadCards(fold);
    expect(artifacts).toHaveLength(1);
    const rehydrated = snapshotViewMount(artifacts[0]!);
    expect(rehydrated).toBeDefined();
    expect(rehydrated?.channel).toBe('inline');
    if (rehydrated === undefined || rehydrated.channel === 'locator') {
      throw new Error('expected an inline resource mount after rehydration');
    }
    expect(rehydrated.resource).toEqual(live.resource);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Matrix 4 — ggui-channel snapshots: today's deliberate non-projection
// ───────────────────────────────────────────────────────────────────────

describe('matrix 4 — persisted ggui bootstraps are honestly non-remountable today', () => {
  it('a ggui-channel fold rehydrates to a placeholder, never a dead mount', async () => {
    const result = await renderOnce();
    const { fold } = foldToolDone({
      uiData: result.structuredContent,
      meta: result._meta,
    });

    const artifacts = await persistAndReadCards(fold);
    // 0.2.2's actual behavior, probed directly against
    // `uiCardArtifactsFromMessages`: the card projection SKIPS
    // ggui-channel results entirely (a resourceUri with no inline
    // text/blob persists nothing). Pinned exactly — this harness pins
    // @guuey/* to an exact version, so a future guuey that starts
    // persisting ggui card rows fails HERE loudly and we revisit
    // against the re-mint design (issue #429 item 4) instead of
    // silently accepting dead-on-arrival bootstrap snapshots. If that
    // future version persists rows, the invariant to enforce becomes:
    // `cardCardMount(snapshot)` stays undefined until the snapshot
    // carries a re-mintable locator, never a stale wsToken mount.
    expect(artifacts).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────
// Matrix 5 — rehydration = a fresh `resources/read` of the persisted
// resourceUri over the same authenticated MCP connection, not a replay
// of the originally-persisted (and by now expired) bootstrap.
// ───────────────────────────────────────────────────────────────────────

describe("matrix 5 — rehydrate-by-refetch mints fresh credentials with current state", () => {
  it("re-fetching resourceUri returns a mountable shell: same session, fresh wsToken", async () => {
    const result = await renderOnce();
    const live = toolResultGguiRender(result);
    expect(live).toBeDefined();
    const sessionId = live!.slice.sessionId as string;
    const resourceUri = (result.structuredContent as { resourceUri?: string }).resourceUri;
    expect(typeof resourceUri).toBe("string");

    // Set mock componentCode on the render so the resource template can serve
    // it. Without a generator in the fixture, we manually inject a minimal
    // component to enable the live-mode shell path (wsUrl + wsToken).
    const stored = await renderStore.get(sessionId);
    expect(stored).toBeDefined();
    if (stored && stored.render.type === 'component') {
      await renderStore.commit({
        render: {
          ...stored.render,
          componentCode: 'export default function Card(){return null;}',
        },
        appId: stored.appId,
        ...(stored.userId !== undefined ? { userId: stored.userId } : {}),
      });
    }

    // The rehydration contract: a persisted card re-fetches its
    // resourceUri over the SAME authenticated MCP connection —
    // no stored bootstrap is ever replayed.
    const read = await client.readResource({ uri: resourceUri! });
    const resourceContent = read.contents[0];
    const shellHtml = resourceContent && 'text' in resourceContent ? resourceContent.text : undefined;
    expect(typeof shellHtml).toBe("string");

    const envelope = shellEnvelope(shellHtml as string);
    const refetched = asGguiRenderBootstrap(envelope);
    expect(refetched).toBeDefined();
    // Same render identity…
    expect(refetched!.slice.sessionId).toBe(live!.slice.sessionId);
    // …fresh transport material: the wsToken is re-minted per fetch.
    expect(typeof refetched!.slice.wsToken).toBe("string");
    expect(refetched!.slice.wsToken).not.toBe(live!.slice.wsToken);
  });
});
