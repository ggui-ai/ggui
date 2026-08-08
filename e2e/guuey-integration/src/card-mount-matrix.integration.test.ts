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
 *   - mounting is `@guuey/mcp-apps-host`'s three-channel dispatcher
 *     (`toolResultViewMount` / `snapshotViewMount` — inline, ggui,
 *     locator).
 *
 * Matrix (issue #429):
 *   1. live mount — ggui tool-result → fold → `toolResultViewMount`,
 *      plus VERBATIM slice parity against ggui's own protocol
 *      host-helper (`toolResultGguiRender`, ggui#427).
 *   2. persist → rehydrate — inline mcp-ui resource through
 *      `appendFold` → card row → `snapshotViewMount`; live ≍ rehydrated.
 *   3. provider-raw channel — a `ui://` resource degraded into a
 *      `provider-raw` content part mounts on BOTH arms.
 *   4. ggui-channel snapshot honesty — persisted ggui renders are
 *      bootstrap-free locator placeholder rows (guuey#122): the durable
 *      `ui://` identity survives, credentials never do (ggui#430).
 *
 * The `@guuey/*` pins are EXACT (0.3.x): the point is testing ggui
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
import {
  isJsonObject,
  snapshotViewMount,
  toolResultViewMount,
  type LocatorViewMount,
} from '@guuey/mcp-apps-host';
import { InMemoryThreadPersistence, ThreadStore, uiCardArtifactsFromMessages } from '@guuey/threads';

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
    // the SAME wire result (ggui#427). Since 0.3.x guuey ships NO copy
    // of the helpers — @guuey/mcp-apps-host re-exports them from the
    // PUBLISHED @ggui-ai/protocol@0.6.3 pinned beneath it, while the
    // `toolResultGguiRender` imported here resolves workspace HEAD. So
    // byte-equality now detects ggui-HEAD-vs-published-pin drift: if
    // HEAD's slice projection moves ahead of what guuey actually pins,
    // it fails HERE, before it fails in guuey's host.
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
// Matrix 4 — ggui-channel snapshots: honest locator placeholders
// ───────────────────────────────────────────────────────────────────────

/** Recursively collect every object key reachable from a value. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, into);
  } else if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeys(child, into);
    }
  }
  return into;
}

describe('matrix 4 — persisted ggui renders are honest locator placeholders, never stale credentials', () => {
  it('a ggui-channel fold persists ONE bootstrap-free locator row', async () => {
    const result = await renderOnce();
    const { fold } = foldToolDone({
      uiData: result.structuredContent,
      meta: result._meta,
    });

    // The ratified 0.3.x invariant (guuey#122: locator placeholder rows +
    // the persistence-lane `_meta` strip; ggui#430): a ggui render
    // persists as exactly ONE bootstrap-free locator row — the durable
    // `ui://` identity survives, the short-TTL wsToken bootstrap never
    // does. Gate history: the 0.2.x pin asserted zero-projection, fired
    // on the 0.3.0 bump (2026-08-08), and was ruled + rewritten the same
    // day — ggui#430 comment 5225026230 carries the observed shape. Going
    // forward this leg guards exactly that: rows persist as bootstrap-free
    // locators, and any future guuey version that persists mount material
    // or `_meta` on a ggui row fails HERE loudly. (The fresh-wsToken
    // re-mint via `resources/read` is matrix 5's territory — deliberately
    // not re-asserted here.)

    // (a) the card projection emits exactly one artifact row for the
    // render, carrying the durable ui:// identity. (The `content` check
    // only proves the projection ADDS nothing of its own — the harness
    // folds an empty tool.done content in to begin with.)
    const projected = uiCardArtifactsFromMessages(fold.messages);
    expect(projected).toHaveLength(1);
    const part = projected[0]!.parts.find(
      (p): p is Extract<AgBlock, { type: 'tool-result' }> => p.type === 'tool-result',
    );
    expect(part).toBeDefined();
    expect(part!.content).toEqual([]);
    const uiData = part!.uiData;
    if (!isJsonObject(uiData)) {
      throw new Error('projected ggui artifact carries no uiData object');
    }
    const resourceUri = uiData.resourceUri;
    expect(typeof resourceUri).toBe('string');
    expect(resourceUri).toMatch(/^ui:\/\/ggui\/render\//);

    // (b) the `_meta` strip — "wsToken never persists": no `_meta` key
    // survives anywhere in ANY persisted row (a strip that held on the
    // card lane but lapsed on the message lane would still leak), and
    // the live wsToken string appears in no persistence lane at all —
    // the string scan is the belt to the key-walk's suspenders.
    const bootstrap = toolResultGguiRender(result);
    expect(bootstrap).toBeDefined();
    const wsToken = bootstrap!.slice.wsToken;
    expect(typeof wsToken).toBe('string');
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
      clientMessageIdBase: 'interop-turn-4',
    });
    const rows = await db.listRecentMessages(threadId, 50);
    const cardRows = rows.filter((r) => r.kind === 'card' && r.cardSnapshot !== undefined);
    expect(cardRows).toHaveLength(1);
    const cardRow = cardRows[0]!;
    expect(collectKeys(rows).has('_meta')).toBe(false);
    expect(JSON.stringify(rows)).not.toContain(String(wsToken));

    // (c) "never a stale wsToken mount": the snapshot mounts as the
    // locator arm, which by construction (the 0.3.1 named LocatorViewMount
    // arm) carries no resource and no bootstrap — only the uri from (a).
    const mount = snapshotViewMount(toJsonValue(cardRow.cardSnapshot));
    expect(mount).toBeDefined();
    expect(mount?.channel).toBe('locator');
    if (mount === undefined || mount.channel !== 'locator') {
      // Unreachable past the two expects above — narrows to the locator arm.
      throw new Error('expected the locator arm');
    }
    const locator: LocatorViewMount = mount;
    // The named arm carries the locator and NOTHING else — no resource,
    // no bootstrap, enforced on the actual runtime object.
    expect(Object.keys(locator).sort()).toEqual(['channel', 'resourceUri']);
    expect(locator.resourceUri).toBe(resourceUri);
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
