/**
 * Covers the new `Session.mcpAppsMode` +
 * `Session.canvasLoaded` fields' round-trip through the in-memory
 * store's `update(id, patch)` API.
 *
 * Two fields, two semantics:
 *
 *   - `mcpAppsMode`: set once at `ggui_new_session` time; frozen for
 *     the session's life. The store doesn't enforce immutability (any
 *     subsequent write would succeed); semantic immutability is owned
 *     by the handlers.
 *   - `canvasLoaded`: flipped to true by the session-channel handler
 *     when the canvas iframe's `ui/initialize` completes AND its
 *     live-channel subscription opens.
 *
 * Pre-existing in-memory store tests live in `session-store.test.ts`
 * driven from the contract-test suite. Keeping the canvas-field
 * coverage in its own file avoids forcing every store implementation
 * (sqlite, dynamo) to handle the new fields before they have a
 * canvas-aware caller.
 */
import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from './session-store.js';

async function newSession(store: InMemorySessionStore): Promise<string> {
  const session = await store.create({ appId: 'app-1' });
  return session.id;
}

describe('InMemorySessionStore — Slice B canvas fields', () => {
  it('Session.mcpAppsMode is undefined on a freshly-created session', async () => {
    const store = new InMemorySessionStore();
    const session = await store.create({ appId: 'app-1' });
    expect(session.mcpAppsMode).toBeUndefined();
    expect(session.canvasLoaded).toBeUndefined();
  });

  it('update({mcpAppsMode}) persists and round-trips', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    const updated = await store.update(id, { mcpAppsMode: 'canvas' });
    expect(updated.mcpAppsMode).toBe('canvas');
    const fetched = await store.get(id);
    expect(fetched?.mcpAppsMode).toBe('canvas');
  });

  it('update({canvasLoaded: true}) persists and round-trips', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    const updated = await store.update(id, { canvasLoaded: true });
    expect(updated.canvasLoaded).toBe(true);
    const fetched = await store.get(id);
    expect(fetched?.canvasLoaded).toBe(true);
  });

  it('update({canvasLoaded: false}) persists a literal false (distinct from undefined)', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    await store.update(id, { canvasLoaded: true });
    const flipped = await store.update(id, { canvasLoaded: false });
    expect(flipped.canvasLoaded).toBe(false);
  });

  it('partial update preserves unrelated fields', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    await store.update(id, { mcpAppsMode: 'canvas' });
    await store.update(id, { canvasLoaded: true });
    const fetched = await store.get(id);
    // Both writes survive — partial update doesn't clobber earlier
    // writes to other fields.
    expect(fetched?.mcpAppsMode).toBe('canvas');
    expect(fetched?.canvasLoaded).toBe(true);
  });

  it('mcpAppsMode + canvasLoaded coexist with other patch fields (lastActivityAt)', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    const updated = await store.update(id, {
      mcpAppsMode: 'canvas',
      canvasLoaded: true,
      lastActivityAt: 1_750_000_000_000,
    });
    expect(updated.mcpAppsMode).toBe('canvas');
    expect(updated.canvasLoaded).toBe(true);
    expect(updated.lastActivityAt).toBe(1_750_000_000_000);
  });

  it('update returned session is a clone — mutating it does not affect store state', async () => {
    const store = new InMemorySessionStore();
    const id = await newSession(store);
    const updated = await store.update(id, { mcpAppsMode: 'canvas' });
    // Mutate the returned object (which is a clone).
    (updated as { mcpAppsMode?: string }).mcpAppsMode = 'inline';
    const fetched = await store.get(id);
    // Store state unchanged.
    expect(fetched?.mcpAppsMode).toBe('canvas');
  });
});
