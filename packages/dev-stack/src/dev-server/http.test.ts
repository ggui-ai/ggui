import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GguiJsonV1 } from '@ggui-ai/project-config';
import type { UiManifestEntry } from '@ggui-ai/ui-registry';
import { LocalUiRegistry } from '../local-registry/local-registry.js';
import { startDevServer, type DevServerHandle } from './http.js';

function makeGgui(include: string[]): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'smoke', name: 'Smoke' },
    blueprints: { include },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
  };
}

function writeUi(root: string, dir: string, id: string): void {
  const full = join(root, dir);
  mkdirSync(full, { recursive: true });
  writeFileSync(
    join(full, 'ggui.ui.json'),
    JSON.stringify({ id, name: id, contract: { intent: 'test' } }),
  );
}

describe('dev server HTTP surface', () => {
  let tmp: string;
  let handle: DevServerHandle | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-cli-http-'));
  });

  afterEach(async () => {
    if (handle) {
      await handle.close();
      handle = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  async function boot(include: string[]): Promise<DevServerHandle> {
    const manifest = makeGgui(include);
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const h = await startDevServer({ registry, manifest, port: 0 });
    handle = h;
    return h;
  }

  function base(h: DevServerHandle): string {
    return `http://${h.host}:${h.port}`;
  }

  it('binds to 127.0.0.1 by default', async () => {
    const h = await boot([]);
    expect(h.host).toBe('127.0.0.1');
    expect(h.port).toBeGreaterThan(0);
  });

  it('GET /health reports uiCount + issueCount', async () => {
    writeUi(tmp, 'ui/card', 'card');
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      ok: boolean;
      app: { slug: string };
      uiCount: number;
      issueCount: number;
    };
    expect(body.ok).toBe(true);
    expect(body.app.slug).toBe('smoke');
    expect(body.uiCount).toBe(1);
    expect(body.issueCount).toBe(0);
  });

  it('GET /uis lists discovered UIs', async () => {
    writeUi(tmp, 'ui/a', 'a');
    writeUi(tmp, 'ui/b', 'b');
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiManifestEntry[];
    expect(body.map((e) => e.id).sort()).toEqual(['a', 'b']);
  });

  it('GET /uis/:id returns a single entry', async () => {
    writeUi(tmp, 'ui/card', 'card');
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis/card`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as UiManifestEntry;
    expect(body.id).toBe('card');
    expect(body.manifest.name).toBe('card');
  });

  it('GET /uis/:id returns 404 for unknown id', async () => {
    const h = await boot([]);
    const res = await fetch(`${base(h)}/uis/missing`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; id: string };
    expect(body.error).toBe('not-found');
    expect(body.id).toBe('missing');
  });

  it('GET /uis/:id/bundle serves the colocated compiled bundle', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(join(tmp, 'ui/card/ggui.ui.js'), 'export default 42;');
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis/card/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript+react');
    expect(await res.text()).toBe('export default 42;');
  });

  it('GET /uis/:id/bundle 404s with missing-entry when no precompiled AND no TSX entry exists', async () => {
    writeUi(tmp, 'ui/card', 'card');
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis/card/bundle`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as {
      error: string;
      message: string;
      tried?: string[];
    };
    expect(body.error).toBe('missing-entry');
    expect(body.message).toMatch(/entryPoint|ggui\.ui\.tsx/);
    expect(Array.isArray(body.tried)).toBe(true);
    expect(body.tried!.length).toBeGreaterThan(0);
  });

  it('GET /uis/:id/bundle compiles a colocated ggui.ui.tsx on demand and returns JS', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      `export default function Card() { return null; }`,
    );
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis/card/bundle`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/javascript+react');
    const text = await res.text();
    expect(text).toMatch(/as\s+default|export\s+default/);
  });

  it('GET /uis/:id/bundle returns 422 with structured esbuild errors on compile failure', async () => {
    writeUi(tmp, 'ui/broken', 'broken');
    writeFileSync(
      join(tmp, 'ui/broken/ggui.ui.tsx'),
      `export default function Broken() { return <div>; }`,
    );
    const h = await boot(['ui/**/ggui.ui.json']);
    const res = await fetch(`${base(h)}/uis/broken/bundle`);
    expect(res.status).toBe(422);
    const body = (await res.json()) as {
      error: string;
      id: string;
      entry: string;
      errors: Array<{ text: string; location: unknown }>;
    };
    expect(body.error).toBe('compile-failed');
    expect(body.id).toBe('broken');
    expect(body.entry).toMatch(/ggui\.ui\.tsx$/);
    expect(body.errors.length).toBeGreaterThan(0);
    // At least one error should carry a useful location.
    const withLocation = body.errors.find(
      (e) => e.location !== null && typeof e.location === 'object',
    );
    expect(withLocation).toBeDefined();
  });

  it('rejects non-GET methods with 405', async () => {
    const h = await boot([]);
    const res = await fetch(`${base(h)}/uis`, { method: 'POST' });
    expect(res.status).toBe(405);
  });

  it('returns 404 for unknown paths', async () => {
    const h = await boot([]);
    const res = await fetch(`${base(h)}/nope`);
    expect(res.status).toBe(404);
  });

  it('GET /events opens an SSE stream with a hello preamble and forwards watcher events', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      'export default () => null;',
    );
    const h = await boot(['ui/**/ggui.ui.json']);

    const abort = new AbortController();
    const res = await fetch(`${base(h)}/events`, { signal: abort.signal });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buf = '';

    async function readUntil(predicate: (chunk: string) => boolean, timeoutMs = 3000) {
      const start = Date.now();
      while (!predicate(buf)) {
        const remaining = timeoutMs - (Date.now() - start);
        if (remaining <= 0) {
          throw new Error(`SSE stream never matched: ${buf}`);
        }
        // Race the read against the remaining budget. Without the race
        // the deadline is only checked BETWEEN chunks, so a silent
        // stream parks forever inside `reader.read()` and the intended
        // diagnostic above is replaced by an opaque vitest testTimeout
        // kill at 30s — the shape of both 2026-07 CI flakes.
        const result = await Promise.race([
          reader.read(),
          new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), remaining)),
        ]);
        if (result === 'timeout') {
          throw new Error(`SSE stream never matched: ${buf}`);
        }
        const { value, done } = result;
        if (done) break;
        buf += decoder.decode(value, { stream: true });
      }
    }

    // hello preamble first
    await readUntil((c) => c.includes('event: hello'));

    // Trigger a change — and KEEP re-triggering until the watcher reports
    // it. Root cause of the 2× 2026-07 CI flakes (30s testTimeout): the
    // first `/events` subscribe lazy-STARTS chokidar (`LocalUiRegistry.
    // subscribe → watcher.start`), and nothing awaits its ready before the
    // SSE hello is written. A single one-shot write racing the initial
    // scan on a contended runner is silently absorbed by
    // `ignoreInitial: true` (the scan stats the file AFTER the write and
    // counts it as initial state — no 'change' ever fires), so no timeout
    // bump can help. Re-writing on an interval makes the trigger
    // deterministic: the first write AFTER the scan completes always
    // emits. The 500ms cadence stays above the watcher's awaitWriteFinish
    // stabilityThreshold (100ms) so writes aren't coalesced forever.
    let rev = 2;
    const trigger = setInterval(() => {
      writeFileSync(join(tmp, 'ui/card/ggui.ui.tsx'), `export default () => null; // v${rev++}`);
    }, 500);
    try {
      // Still generous: chokidar detection + SSE forward can take several
      // seconds on a contended 2-core CI runner (passes ~instantly
      // locally); the deadline guards a real hang, not the trigger race.
      await readUntil((c) => c.includes('event: ui') && c.includes('"id":"card"'), 20_000);
    } finally {
      clearInterval(trigger);
    }

    abort.abort();
    try {
      await reader.cancel();
    } catch {
      // ok — aborted
    }
  });

  it('GET /events with no token still gets 401 from the security layer', async () => {
    // Use a policy-wrapped boot to prove the events endpoint
    // participates in the standard auth flow like every other
    // protected route.
    writeUi(tmp, 'ui/card', 'card');
    const manifest = makeGgui(['ui/**/ggui.ui.json']);
    const registry = new LocalUiRegistry({ projectRoot: tmp, manifest });
    const { createSecurityPolicy } = await import('./auth.js');
    const security = createSecurityPolicy({ token: 'secret', env: {} });
    handle = await startDevServer({ registry, manifest, port: 0, security });
    const res = await fetch(`${base(handle)}/events`);
    expect(res.status).toBe(401);
  });
});
