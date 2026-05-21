/**
 * Wire tests for `GET /ggui/console/blueprints/registry` — the Slice
 * 16g operator surface for the contract-keyed blueprint registry the
 * three-tier matcher consults.
 *
 * Distinct from sibling endpoints:
 *   - `/ggui/console/blueprints/cached` (legacy, post-16h cleanup) —
 *     intent-keyed generation cache.
 *   - `/ggui/console/registry` (Slice 8c) — operator-declared static
 *     blueprint catalog from `uiRegistry` + primitiveCatalogs.
 *
 * Pinned contract:
 *   - empty scope → `{entries: [], total: 0}`
 *   - populated scope → list of `{id, kind, contractKey, intent,
 *     createdAt, hitCount, lastHitAt?, componentCodeBytes}`. The
 *     full `componentCode` is omitted from the listing — bytes
 *     signal is enough for the operator UI to render "12 KB" without
 *     parsing 12 KB.
 *   - `?kind=` filter narrows by atomic-design level
 *   - `?kind=<garbage>` → 400
 *   - non-enumerable vector store → 501
 *   - console disabled → 404
 *
 * Lane 3 of the testing taxonomy: in-process server boot + real
 * `InMemoryVectorStore` + `MockEmbeddingProvider`. Same fixture shape
 * as `console-blueprints-cache.test.ts` for sibling-endpoint symmetry.
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
import { registerBlueprint } from '@ggui-ai/mcp-server-handlers';
import type { DataContract } from '@ggui-ai/protocol';
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
  const consoleOpt: CreateGguiServerOptions['console'] = opts.console ?? {};
  const server = createGguiServer({
    logger: silentLogger,
    vectors,
    embedding,
    ...opts,
    console: consoleOpt,
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

const NOTEPAD_CONTRACT: DataContract = {
  contextSpec: {
    noteText: { schema: { type: 'string' }, default: '' },
  },
};

const WEATHER_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      city: { schema: { type: 'string' }, required: true },
    },
  },
};

interface RegistryEntry {
  id: string;
  kind: string;
  contractKey: string;
  intent: string;
  createdAt: string;
  hitCount: number;
  lastHitAt?: string;
  componentCodeBytes: number;
  // Slice 5.3 (2026-05-18): surfaced for operator distinction
  // between synth-cached / operator-registered / marketplace-
  // installed rows.
  provenance: 'synth' | 'register' | 'install';
}

describe('GET /ggui/console/blueprints/registry', () => {
  let fixtures: Fixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.map((f) => f.server.close()));
    fixtures = [];
  });

  it('returns empty payload for a fresh server', async () => {
    const f = await boot();
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: RegistryEntry[];
      total: number;
    };
    expect(body.entries).toEqual([]);
    expect(body.total).toBe(0);
  });

  it('returns registered blueprints with stable wire shape', async () => {
    const f = await boot();
    fixtures.push(f);
    const stored = await registerBlueprint(
      { embedding: f.embedding, vectorStore: f.vectors },
      DEFAULT_BUILDER_APP_ID,
      {
        kind: 'template',
        contract: NOTEPAD_CONTRACT,
        intent: 'live notepad',
        componentCode: 'export default () => null;',
      },
    );
    const res = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: RegistryEntry[];
      total: number;
    };
    expect(body.total).toBe(1);
    const entry = body.entries[0]!;
    expect(entry.id).toBe(stored.id);
    expect(entry.kind).toBe('template');
    expect(entry.contractKey).toBe(stored.contractKey);
    expect(entry.intent).toBe('live notepad');
    expect(entry.hitCount).toBe(0);
    expect(entry.componentCodeBytes).toBe(
      'export default () => null;'.length,
    );
    // componentCode itself MUST be omitted from the listing — it can
    // be 12+ KB and bloats the operator UI; bytes signal is enough.
    expect(entry).not.toHaveProperty('componentCode');
    // Slice 5.3 (2026-05-18): provenance surfaces the cache-write
    // origin. registerBlueprint without an explicit provenance
    // defaults to 'synth' (the original cold-gen writer).
    expect(entry.provenance).toBe('synth');
  });

  // Slice 5.3 (2026-05-18): explicit provenance threading. Each of
  // synth/register/install survives the wire projection so the SPA
  // can group + label rows correctly.
  it('threads each provenance value through the wire projection', async () => {
    const f = await boot();
    fixtures.push(f);
    const provenances = ['synth', 'register', 'install'] as const;
    for (const provenance of provenances) {
      await registerBlueprint(
        { embedding: f.embedding, vectorStore: f.vectors },
        DEFAULT_BUILDER_APP_ID,
        {
          kind: 'template',
          // Distinct contracts so the three rows coexist with
          // distinct contractKeys.
          contract: {
            contextSpec: {
              [provenance]: { schema: { type: 'string' }, default: provenance },
            },
          },
          intent: `${provenance} blueprint`,
          componentCode: 'export default () => null;',
          provenance,
        },
      );
    }
    const res = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      entries: RegistryEntry[];
      total: number;
    };
    expect(body.total).toBe(3);
    const byProvenance = new Map(
      body.entries.map((e) => [e.provenance, e]),
    );
    expect(byProvenance.get('synth')?.intent).toBe('synth blueprint');
    expect(byProvenance.get('register')?.intent).toBe('register blueprint');
    expect(byProvenance.get('install')?.intent).toBe('install blueprint');
  });

  it('filters by ?kind=', async () => {
    const f = await boot();
    fixtures.push(f);
    const deps = { embedding: f.embedding, vectorStore: f.vectors };
    await registerBlueprint(deps, DEFAULT_BUILDER_APP_ID, {
      kind: 'template',
      contract: NOTEPAD_CONTRACT,
      intent: 'notepad',
      componentCode: 'a',
    });
    await registerBlueprint(deps, DEFAULT_BUILDER_APP_ID, {
      kind: 'atom',
      contract: WEATHER_CONTRACT,
      intent: 'an atom',
      componentCode: 'b',
    });

    const tplRes = await fetch(
      `${f.url}/ggui/console/blueprints/registry?kind=template`,
    );
    expect(tplRes.status).toBe(200);
    const tplBody = (await tplRes.json()) as { entries: RegistryEntry[] };
    expect(tplBody.entries).toHaveLength(1);
    expect(tplBody.entries[0]!.kind).toBe('template');

    const atomRes = await fetch(
      `${f.url}/ggui/console/blueprints/registry?kind=atom`,
    );
    expect(atomRes.status).toBe(200);
    const atomBody = (await atomRes.json()) as { entries: RegistryEntry[] };
    expect(atomBody.entries).toHaveLength(1);
    expect(atomBody.entries[0]!.kind).toBe('atom');

    const allRes = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    const allBody = (await allRes.json()) as { entries: RegistryEntry[] };
    expect(allBody.entries).toHaveLength(2);
  });

  it('rejects unknown ?kind= with 400', async () => {
    const f = await boot();
    fixtures.push(f);
    const res = await fetch(
      `${f.url}/ggui/console/blueprints/registry?kind=not-a-real-kind`,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('invalid_kind');
  });

  it('returns 501 when the vector store is not enumerable', async () => {
    const inner = new InMemoryVectorStore();
    const opaque: VectorStore = {
      putVector: inner.putVector.bind(inner),
      deleteVector: inner.deleteVector.bind(inner),
      query: inner.query.bind(inner),
    };
    const f = await boot({}, { vectors: opaque });
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    expect(res.status).toBe(501);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('enumeration_unsupported');
  });

  it('does not mount when console is disabled', async () => {
    const f = await boot({ console: false });
    fixtures.push(f);
    const res = await fetch(`${f.url}/ggui/console/blueprints/registry`);
    expect(res.status).toBe(404);
  });
});
