/**
 * Exercises the watcher against a real filesystem. Mocking
 * chokidar misses the event timings + path normalisation that
 * differ by platform; a real tmp dir + real writes are the cheap
 * honest way to pin behaviour.
 *
 * Heuristic: we use `awaitEvent(listener)` with a generous
 * timeout because chokidar debounces bursts — the events
 * themselves are deterministic, but their delivery order is up
 * to the FS + the `awaitWriteFinish` stabilisation window the
 * watcher configures.
 */
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { UiRegistryEvent } from '@ggui-ai/ui-registry';
import { LocalUiRegistry } from './local-registry.js';
import type { GguiJsonV1 } from '@ggui-ai/project-config';

function makeGgui(include: string[]): GguiJsonV1 {
  return {
    schema: '1',
    protocol: '1.1',
    app: { slug: 'test', name: 'Test' },
    blueprints: { include },
    primitives: { packages: ['@ggui-ai/design/primitives'], local: [] },
    mcpMounts: [],
  };
}

function writeUi(root: string, relDir: string, id: string): string {
  const dir = join(root, relDir);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'ggui.ui.json');
  writeFileSync(
    path,
    JSON.stringify({ id, name: id, contract: { intent: 'test' } }),
  );
  return path;
}

/** Wait for the predicate to match one of the received events,
 * with a generous timeout. Returns the first matching event so
 * assertions can introspect it. */
function awaitEvent(
  received: UiRegistryEvent[],
  predicate: (e: UiRegistryEvent) => boolean,
  timeoutMs = 3000,
): Promise<UiRegistryEvent> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = (): void => {
      const hit = received.find(predicate);
      if (hit) return resolve(hit);
      if (Date.now() - start > timeoutMs) {
        return reject(
          new Error(
            `awaitEvent timed out after ${timeoutMs}ms; received ${JSON.stringify(received)}`,
          ),
        );
      }
      setTimeout(tick, 30);
    };
    tick();
  });
}

describe('LocalUiRegistry subscribe + watcher', () => {
  let tmp: string;
  let registry: LocalUiRegistry | null = null;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'ggui-watch-'));
  });

  afterEach(async () => {
    if (registry) {
      await registry.close();
      registry = null;
    }
    rmSync(tmp, { recursive: true, force: true });
  });

  it('flips capabilities.observable to true', () => {
    registry = new LocalUiRegistry({ projectRoot: tmp, manifest: makeGgui([]) });
    expect(registry.capabilities.observable).toBe(true);
  });

  it('emits `changed` when an entry TSX file inside a known manifest dir is edited', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      'export default () => null;',
    );
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    // Prime the manifest dir index.
    await registry.list();

    const received: UiRegistryEvent[] = [];
    registry.subscribe((e) => received.push(e));

    // Give chokidar a moment to ready-up.
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.tsx'),
      'export default () => null; /* edited */',
    );

    const hit = await awaitEvent(received, (e) => e.type === 'changed' && e.id === 'card');
    expect(hit).toMatchObject({ type: 'changed', id: 'card' });
  });

  it('emits `changed` when the ggui.ui.json itself is edited', async () => {
    writeUi(tmp, 'ui/card', 'card');
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    await registry.list();

    const received: UiRegistryEvent[] = [];
    registry.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(
      join(tmp, 'ui/card/ggui.ui.json'),
      JSON.stringify({
        id: 'card',
        name: 'Card edited',
        contract: { intent: 'test' },
      }),
    );

    const hit = await awaitEvent(received, (e) => e.type === 'changed' && e.id === 'card');
    expect(hit.type).toBe('changed');
  });

  it('emits `added` when a new ggui.ui.json appears', async () => {
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    await registry.list();

    const received: UiRegistryEvent[] = [];
    registry.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 200));

    writeUi(tmp, 'ui/new-ui', 'new-ui');

    const hit = await awaitEvent(received, (e) => e.type === 'added' && e.id === 'new-ui');
    expect(hit).toMatchObject({ type: 'added', id: 'new-ui' });
  });

  it('emits `removed` when a ggui.ui.json is deleted', async () => {
    const manifestPath = writeUi(tmp, 'ui/card', 'card');
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    await registry.list();

    const received: UiRegistryEvent[] = [];
    registry.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 200));

    unlinkSync(manifestPath);

    const hit = await awaitEvent(received, (e) => e.type === 'removed' && e.id === 'card');
    expect(hit).toMatchObject({ type: 'removed', id: 'card' });
  });

  it('ignores changes in node_modules', async () => {
    writeUi(tmp, 'ui/card', 'card');
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    await registry.list();

    const received: UiRegistryEvent[] = [];
    registry.subscribe((e) => received.push(e));
    await new Promise((r) => setTimeout(r, 200));

    // Write a tsx deep inside node_modules — should NOT trigger.
    mkdirSync(join(tmp, 'node_modules/fake'), { recursive: true });
    writeFileSync(join(tmp, 'node_modules/fake/index.tsx'), 'export default () => null;');

    // Small grace window.
    await new Promise((r) => setTimeout(r, 300));

    expect(received.filter((e) => e.id === 'card')).toHaveLength(0);
  });

  it('multiple listeners each receive events; unsubscribe stops them', async () => {
    writeUi(tmp, 'ui/card', 'card');
    writeFileSync(join(tmp, 'ui/card/ggui.ui.tsx'), 'export default () => null;');
    registry = new LocalUiRegistry({
      projectRoot: tmp,
      manifest: makeGgui(['ui/**/ggui.ui.json']),
    });
    await registry.list();

    const a: UiRegistryEvent[] = [];
    const b: UiRegistryEvent[] = [];
    const unsubA = registry.subscribe((e) => a.push(e));
    registry.subscribe((e) => b.push(e));
    await new Promise((r) => setTimeout(r, 200));

    writeFileSync(join(tmp, 'ui/card/ggui.ui.tsx'), 'export default () => null; // v2');
    await awaitEvent(b, (e) => e.id === 'card');
    expect(a.some((e) => e.id === 'card')).toBe(true);

    unsubA();
    a.length = 0;
    b.length = 0;
    writeFileSync(join(tmp, 'ui/card/ggui.ui.tsx'), 'export default () => null; // v3');
    await awaitEvent(b, (e) => e.id === 'card');
    expect(a).toHaveLength(0);
  });
});
