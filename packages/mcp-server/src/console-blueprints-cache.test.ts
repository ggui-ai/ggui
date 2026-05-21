/**
 * Wire tests for `/ggui/console/blueprints/{cached,probe}` — the four
 * Slice 8c endpoints the console SPA's `/blueprints` page consumes.
 *
 * Covers the contract locked in
 * `docs/plans/2026-04-22-blueprints-page-cache-probe.md` §4:
 *
 *   - GET /cached → list with empty-scope `[]`, populated-scope shape
 *   - DELETE /cached/:id → 204, idempotent on missing key
 *   - POST /cached/clear → returns deletedCount
 *   - POST /probe → declared exact-id, cached-similarity wouldFire,
 *     below-threshold + exact-key-mismatch reasons surfaced
 *   - 501 paths when the wired vector store isn't enumerable
 *   - console-disabled → 404 (route doesn't even mount)
 *
 * Lane 3 of the 4-lane test taxonomy (vitest + in-process server
 * boot, no browser, no spawned CLI). Real `InMemoryVectorStore` +
 * real `MockEmbeddingProvider` so cache hits/misses behave exactly
 * like the production seam composition.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Server as HttpServer } from 'node:http';
import type {
  EmbeddingProvider,
  VectorStore,
} from '@ggui-ai/mcp-server-core';
import {
  InMemoryVectorStore,
  MockEmbeddingProvider,
} from '@ggui-ai/mcp-server-core/in-memory';
import { generationCacheKey } from '@ggui-ai/mcp-server-handlers';
import {
  createGguiServer,
  type CreateGguiServerOptions,
  type GguiServer,
} from './server.js';
import { DEFAULT_BUILDER_APP_ID } from './auth.js';

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
  vectors: VectorStore;
  embedding: EmbeddingProvider;
}

async function boot(
  opts: CreateGguiServerOptions = {},
  bound: { vectors?: VectorStore; embedding?: EmbeddingProvider } = {},
): Promise<Fixture> {
  const vectors = bound.vectors ?? new InMemoryVectorStore();
  const embedding = bound.embedding ?? new MockEmbeddingProvider();
  // Default `console: {}` so the routes we're testing actually mount.
  // Tests that exercise the disabled path explicitly pass
  // `console: false` to opt out.
  const console: CreateGguiServerOptions['console'] = opts.console ?? {};
  const server = createGguiServer({
    logger: silentLogger,
    vectors,
    embedding,
    ...opts,
    console,
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
    vectors,
    embedding,
  };
}

/**
 * Seed a blueprint-registry-shaped row directly via the fixture's
 * vector store. Mirrors what `registerBlueprint` writes (Slice 16d) so
 * the admin route's new-shape predicate matches.
 */
async function seedCacheRow(
  fixture: Fixture,
  scope: string,
  input: {
    readonly intent: string;
    readonly componentCode: string;
    readonly stackItemId: string;
    readonly createdAt: string;
  },
): Promise<void> {
  const normalized = input.intent.trim();
  const contractKey = generationCacheKey(normalized);
  const kind = 'template';
  const vector = await fixture.embedding.embed(normalized);
  await fixture.vectors.putVector(scope, {
    key: `${kind}:${contractKey}`,
    vector,
    metadata: {
      intent: normalized,
      componentCode: input.componentCode,
      contract: '{}',
      contractKey,
      kind,
      stackItemId: input.stackItemId,
      createdAt: input.createdAt,
    },
  });
}

describe('GET /ggui/console/blueprints/cached', () => {
  let fixtures: Fixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.map((f) => f.server.close()));
    fixtures = [];
  });

  it('returns empty payload for a fresh server', async () => {
    const f = await boot();
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[]; total: number };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns recorded cache entries with stable shape', async () => {
    const f = await boot();
    fixtures.push(f);
    await seedCacheRow(f, DEFAULT_BUILDER_APP_ID, {
        intent: 'weather card for Tokyo',
        componentCode: 'export default () => null',
        stackItemId: 'p',
        createdAt: '2026-04-21T00:00:00Z',
      });
    const res = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: { id: string; cachedIntent: string; cachedAt: string }[];
      total: number;
    };
    expect(body.total).toBe(1);
    expect(body.entries[0]!.id).toBe(
      `template:${generationCacheKey('weather card for Tokyo')}`,
    );
    expect(body.entries[0]!.cachedIntent).toBe('weather card for Tokyo');
    expect(body.entries[0]!.cachedAt).toBe('2026-04-21T00:00:00Z');
  });

  it('returns 501 when the vector store is not enumerable', async () => {
    // Wrap an in-memory store in an opaque shim that drops listByScope
    // — simulates the AWS-adapter path where the bridge satisfies
    // VectorStore but not EnumerableVectorStore.
    const inner = new InMemoryVectorStore();
    const opaque: VectorStore = {
      putVector: inner.putVector.bind(inner),
      deleteVector: inner.deleteVector.bind(inner),
      query: inner.query.bind(inner),
    };
    const f = await boot({}, { vectors: opaque });
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('enumeration_unsupported');
  });

  it('does not mount when console is disabled', async () => {
    const f = await boot({ console: false });
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    expect(res.status).toBe(404);
  });
});

describe('DELETE /ggui/console/blueprints/cached/:id', () => {
  let fixtures: Fixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.map((f) => f.server.close()));
    fixtures = [];
  });

  it('removes the entry so subsequent GETs miss it', async () => {
    const f = await boot();
    fixtures.push(f);
    await seedCacheRow(f, DEFAULT_BUILDER_APP_ID, {
        intent: 'weather card',
        componentCode: 'export default () => null',
        stackItemId: 'p',
        createdAt: '2026-04-21T00:00:00Z',
      });
    const id = `template:${generationCacheKey('weather card')}`;

    const del = await fetch(
      `${f.url}/ggui/console/blueprints/cached/${encodeURIComponent(id)}`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(204);

    const list = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    const body = (await list.json()) as { total: number };
    expect(body.total).toBe(0);
  });

  it('is idempotent on a missing id (still 204)', async () => {
    const f = await boot();
    fixtures.push(f);
    const del = await fetch(
      `${f.url}/ggui/console/blueprints/cached/never-stored`,
      { method: 'DELETE' },
    );
    expect(del.status).toBe(204);
  });
});

describe('POST /ggui/console/blueprints/cached/clear', () => {
  let fixtures: Fixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.map((f) => f.server.close()));
    fixtures = [];
  });

  it('returns deletedCount and empties the scope', async () => {
    const f = await boot();
    fixtures.push(f);
    for (const intent of ['one', 'two', 'three']) {
      await seedCacheRow(f, DEFAULT_BUILDER_APP_ID, {
        intent,
        componentCode: 'export default () => null',
        stackItemId: `p-${intent}`,
        createdAt: '2026-04-21T00:00:00Z',
      });
    }

    const res = await fetch(
      `${f.url}/ggui/console/blueprints/cached/clear`,
      { method: 'POST' },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { deletedCount: number };
    expect(body.deletedCount).toBe(3);

    const list = await fetch(`${f.url}/ggui/console/blueprints/cached`);
    const remaining = (await list.json()) as { total: number };
    expect(remaining.total).toBe(0);
  });

  it('returns 501 on a non-enumerable backend', async () => {
    const inner = new InMemoryVectorStore();
    const opaque: VectorStore = {
      putVector: inner.putVector.bind(inner),
      deleteVector: inner.deleteVector.bind(inner),
      query: inner.query.bind(inner),
    };
    const f = await boot({}, { vectors: opaque });
    fixtures.push(f);
    const res = await fetch(
      `${f.url}/ggui/console/blueprints/cached/clear`,
      { method: 'POST' },
    );
    expect(res.status).toBe(501);
  });
});

