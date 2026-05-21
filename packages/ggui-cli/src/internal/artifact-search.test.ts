/**
 * `ggui gadget search` unit tests. Mocks global `fetch`, uses a real
 * `tmpdir()` working directory for ggui.json discovery, and asserts
 * both the human-readable output AND the raw JSON shape — the two
 * paths share validation but diverge at the rendering step.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildSearchQueryString,
  parseArtifactSearchFlags,
  resolveRegistryUrl,
  runArtifactSearch,
  type SearchResponse,
} from './artifact-search.js';

/* -------------------------------------------------------------------------- */
/* parseArtifactSearchFlags                                                    */
/* -------------------------------------------------------------------------- */

describe('parseArtifactSearchFlags', () => {
  it('returns flags={} for no args (search-all is valid)', () => {
    const r = parseArtifactSearchFlags(undefined, []);
    expect(r.error).toBeUndefined();
    expect(r.flags).toEqual({});
  });

  it('returns __help__ on --help / -h', () => {
    expect(parseArtifactSearchFlags(undefined, ['--help']).error).toBe('__help__');
    expect(parseArtifactSearchFlags(undefined, ['-h']).error).toBe('__help__');
  });

  it('parses a bare positional as q', () => {
    const r = parseArtifactSearchFlags(undefined, ['weather']);
    expect(r.error).toBeUndefined();
    expect(r.flags?.q).toBe('weather');
  });

  it('parses every filter flag (space form)', () => {
    const r = parseArtifactSearchFlags(undefined, [
      'weather',
      '--kind',
      'gadget',
      '--hook',
      'useMap',
      '--tag',
      'maps',
      '--author',
      '@my-org',
      '--limit',
      '25',
      '--cursor',
      'abc123',
      '--registry',
      'https://r.example.com',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.flags).toEqual({
      q: 'weather',
      kind: 'gadget',
      hook: 'useMap',
      tag: 'maps',
      author: '@my-org',
      limit: 25,
      cursor: 'abc123',
      registry: 'https://r.example.com',
    });
  });

  it('parses every filter flag (=value form)', () => {
    const r = parseArtifactSearchFlags(undefined, [
      '--kind=blueprint',
      '--limit=200',
      '--registry=https://r.example.com',
    ]);
    expect(r.error).toBeUndefined();
    expect(r.flags?.kind).toBe('blueprint');
    expect(r.flags?.limit).toBe(200);
    expect(r.flags?.registry).toBe('https://r.example.com');
  });

  it('accepts --json (boolean flag)', () => {
    const r = parseArtifactSearchFlags(undefined, ['--json']);
    expect(r.flags?.json).toBe(true);
  });

  it('rejects --kind other than gadget|blueprint', () => {
    const r = parseArtifactSearchFlags(undefined, ['--kind', 'template']);
    expect(r.error).toMatch(/kind/);
  });

  it('rejects --limit out of range', () => {
    expect(parseArtifactSearchFlags(undefined, ['--limit', '0']).error).toMatch(/limit/);
    expect(parseArtifactSearchFlags(undefined, ['--limit', '201']).error).toMatch(/limit/);
    expect(parseArtifactSearchFlags(undefined, ['--limit', 'abc']).error).toMatch(/limit/);
  });

  it('rejects unknown flags', () => {
    expect(parseArtifactSearchFlags(undefined, ['--frobnicate']).error).toMatch(
      /unknown flag/,
    );
  });

  it('rejects flags missing a value', () => {
    expect(parseArtifactSearchFlags(undefined, ['--registry']).error).toMatch(
      /requires a value/,
    );
  });

  it('rejects a second positional', () => {
    expect(parseArtifactSearchFlags(undefined, ['weather', 'extra']).error).toMatch(
      /unexpected positional/,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* buildSearchQueryString                                                    */
/* -------------------------------------------------------------------------- */

describe('buildSearchQueryString', () => {
  it('returns empty string for no filters', () => {
    expect(buildSearchQueryString({})).toBe('');
  });

  it('emits q + kind + hook + tag + author + limit + cursor', () => {
    const qs = buildSearchQueryString({
      q: 'weather',
      kind: 'gadget',
      hook: 'useMap',
      tag: 'maps',
      author: '@my-org',
      limit: 50,
      cursor: 'abc',
    });
    expect(qs.startsWith('?')).toBe(true);
    const params = new URLSearchParams(qs.slice(1));
    expect(params.get('q')).toBe('weather');
    expect(params.get('kind')).toBe('gadget');
    expect(params.get('hook')).toBe('useMap');
    expect(params.get('tag')).toBe('maps');
    expect(params.get('author')).toBe('@my-org');
    expect(params.get('limit')).toBe('50');
    expect(params.get('cursor')).toBe('abc');
  });

  it('URL-encodes special characters', () => {
    const qs = buildSearchQueryString({ q: 'a b&c' });
    expect(qs).toContain('q=a+b%26c');
  });
});

/* -------------------------------------------------------------------------- */
/* resolveRegistryUrl — three-layer chain                                    */
/* -------------------------------------------------------------------------- */

describe('resolveRegistryUrl', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `ggui-gadget-search-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  it('layer 1: --registry flag beats env + config', async () => {
    await writeFile(
      join(workDir, 'ggui.json'),
      JSON.stringify({ registry: 'https://from-config.example.com' }),
      'utf-8',
    );
    const r = resolveRegistryUrl({
      flag: 'https://from-flag.example.com',
      cwd: workDir,
      env: { GGUI_REGISTRY: 'https://from-env.example.com' },
    });
    expect(r).toEqual({ url: 'https://from-flag.example.com' });
  });

  it('layer 2: GGUI_REGISTRY env beats config', async () => {
    await writeFile(
      join(workDir, 'ggui.json'),
      JSON.stringify({ registry: 'https://from-config.example.com' }),
      'utf-8',
    );
    const r = resolveRegistryUrl({
      cwd: workDir,
      env: { GGUI_REGISTRY: 'https://from-env.example.com' },
    });
    expect(r).toEqual({ url: 'https://from-env.example.com' });
  });

  it('layer 3: ggui.json#registry', async () => {
    await writeFile(
      join(workDir, 'ggui.json'),
      JSON.stringify({ registry: 'https://from-config.example.com' }),
      'utf-8',
    );
    const r = resolveRegistryUrl({ cwd: workDir, env: {} });
    expect(r).toEqual({ url: 'https://from-config.example.com' });
  });

  it('errors when nothing is set', () => {
    const r = resolveRegistryUrl({ cwd: workDir, env: {} });
    expect('error' in r).toBe(true);
    if ('error' in r) expect(r.error).toMatch(/no registry/i);
  });

  it('normalizes trailing slashes', () => {
    const r = resolveRegistryUrl({
      flag: 'https://r.example.com/',
      cwd: workDir,
      env: {},
    });
    expect(r).toEqual({ url: 'https://r.example.com' });
  });

  it('rejects a malformed URL', () => {
    const r = resolveRegistryUrl({
      flag: 'not-a-url',
      cwd: workDir,
      env: {},
    });
    expect('error' in r).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* runArtifactSearch — fetch-mocked integration                                */
/* -------------------------------------------------------------------------- */

describe('runArtifactSearch', () => {
  let workDir: string;

  beforeEach(async () => {
    workDir = join(tmpdir(), `ggui-gadget-search-run-${randomUUID()}`);
    await mkdir(workDir, { recursive: true });
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  /** Builds a `Response`-shaped object that satisfies the `fetch`
   *  contract for our parser without dragging in undici. */
  function mockResponse(body: unknown, init: { status?: number } = {}): Response {
    const status = init.status ?? 200;
    const text = JSON.stringify(body);
    return new Response(text, {
      status,
      headers: { 'content-type': 'application/json' },
    });
  }

  it('GETs the expected URL with content-type header', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse({ results: [] }));

    await runArtifactSearch(
      {
        q: 'weather',
        kind: 'gadget',
        registry: 'https://r.example.com',
      },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://r.example.com/search?q=weather&kind=gadget');
    expect(init).toMatchObject({
      method: 'GET',
      headers: { 'content-type': 'application/json' },
    });
  });

  it('renders human-readable output by default', async () => {
    const body: SearchResponse = {
      results: [
        {
          artifactId: '@my-org/weather-card',
          latestVersion: '0.1.0',
          kind: 'gadget',
          description: 'Beautiful weather card',
          tags: ['weather'],
          publishedAt: '2026-05-17T00:00:00Z',
        },
        {
          artifactId: '@my-org/map-tile',
          latestVersion: '1.0.0',
          kind: 'gadget',
          publishedAt: '2026-05-17T00:00:00Z',
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse(body));

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lines).toEqual([
      'gadget @my-org/weather-card@0.1.0 — Beautiful weather card',
      '  install: ggui gadget install @my-org/weather-card@0.1.0 --registry=r.example.com',
      'gadget @my-org/map-tile@1.0.0',
      '  install: ggui gadget install @my-org/map-tile@1.0.0 --registry=r.example.com',
    ]);
  });

  it('--json suppresses human-readable lines + stashes raw JSON', async () => {
    const body: SearchResponse = {
      results: [
        {
          artifactId: '@x/y',
          latestVersion: '0.0.1',
          kind: 'blueprint',
          publishedAt: '2026-05-17T00:00:00Z',
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse(body));

    const out = await runArtifactSearch(
      { json: true, registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lines).toEqual([]);
    expect(JSON.parse(out.json)).toEqual(body);
  });

  it('empty results yield empty lines (the CLI driver renders the stderr message)', async () => {
    const body: SearchResponse = { results: [] };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse(body));

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lines).toEqual([]);
    expect(out.response.results).toEqual([]);
  });

  it('appends a pagination hint when nextCursor is present', async () => {
    const body: SearchResponse = {
      results: [
        {
          artifactId: '@x/y',
          latestVersion: '0.0.1',
          kind: 'gadget',
          publishedAt: '2026-05-17T00:00:00Z',
        },
      ],
      nextCursor: 'eyJhYmMiOjF9',
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse(body));

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.lines.at(-1)).toBe('… (more: rerun with --cursor=eyJhYmMiOjF9)');
  });

  it('cursor round-trip: the returned nextCursor is reusable on a follow-up call', async () => {
    const page1: SearchResponse = {
      results: [
        {
          artifactId: '@x/a',
          latestVersion: '0.0.1',
          kind: 'gadget',
          publishedAt: '2026-05-17T00:00:00Z',
        },
      ],
      nextCursor: 'PAGE2',
    };
    const page2: SearchResponse = {
      results: [
        {
          artifactId: '@x/b',
          latestVersion: '0.0.1',
          kind: 'gadget',
          publishedAt: '2026-05-17T00:00:00Z',
        },
      ],
    };
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(mockResponse(page1))
      .mockResolvedValueOnce(mockResponse(page2));

    const first = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.response.nextCursor).toBe('PAGE2');

    const second = await runArtifactSearch(
      { registry: 'https://r.example.com', cursor: first.response.nextCursor },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;

    // Second call's URL must carry the cursor as a query param.
    const [secondUrl] = fetchMock.mock.calls[1]!;
    expect(String(secondUrl)).toContain('cursor=PAGE2');
    expect(second.response.results[0]?.artifactId).toBe('@x/b');
    expect(second.response.nextCursor).toBeUndefined();
  });

  it('network error → SearchFailure code=network-error', async () => {
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'));

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('network-error');
    expect(out.message).toContain('ECONNREFUSED');
  });

  it('HTTP 5xx → SearchFailure code=http-error, surfaces structured error body', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      mockResponse(
        { error: 'server_error', message: 'failed to search registry' },
        { status: 500 },
      ),
    );

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('http-error');
    expect(out.message).toContain('500');
    expect(out.message).toContain('server_error');
  });

  it('HTTP 400 with malformed body → still http-error, falls back to status code', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('not json', {
        status: 400,
        headers: { 'content-type': 'text/plain' },
      }),
    );

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('http-error');
    expect(out.message).toContain('400');
  });

  it('non-JSON 200 body → SearchFailure code=bad-response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      new Response('not json', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('bad-response');
  });

  it('shape-rejected 200 body → SearchFailure code=bad-response', async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      mockResponse({ results: [{ artifactId: 'missing-everything-else' }] }),
    );

    const out = await runArtifactSearch(
      { registry: 'https://r.example.com' },
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('bad-response');
  });

  it('no registry configured anywhere → SearchFailure code=no-registry, no fetch', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    const out = await runArtifactSearch(
      {},
      { cwd: workDir, env: {}, fetch: fetchMock },
    );

    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.code).toBe('no-registry');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
