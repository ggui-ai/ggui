/**
 * Deterministic preview producer — behavioural tests.
 *
 * We don't mock the orchestrator. A fake `emit` sink captures the
 * payloads verbatim, then tests parse them through the same V1
 * message + component schemas a real renderer sees — round-trippable
 * proof the frames the producer emits are canonical A2UI.
 */
import { describe, it, expect } from 'vitest';
import {
  createDeterministicPreviewEmitter,
  produceDeterministicPreview,
  type DeterministicPreviewContext,
} from './deterministic';
import { parseServerMessage, type ServerMessage } from '../messages';
import { parseComponent } from '../components';
import { GGUI_PREVIEW_CATALOG_V1_ID } from '../catalog';

function makeCtx(
  overrides: Partial<DeterministicPreviewContext> = {},
): {
  ctx: DeterministicPreviewContext;
  recorded: unknown[];
  abortController: AbortController;
} {
  const recorded: unknown[] = [];
  const abortController = new AbortController();
  const ctx: DeterministicPreviewContext = {
    renderId: 'page-1',
    story: { intent: 'build a dashboard' },
    emit: async (payload) => {
      recorded.push(payload);
      return { seq: recorded.length };
    },
    signal: abortController.signal,
    ...overrides,
  };
  return { ctx, recorded, abortController };
}

function expectValidServerMessage(payload: unknown): ServerMessage {
  const result = parseServerMessage(payload);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error('unreachable');
  return result.value;
}

describe('produceDeterministicPreview — happy path', () => {
  it('emits createSurface → updateComponents → updateComponents (3 frames; no deleteSurface on happy path)', async () => {
    // The producer deliberately stops after the enriched-layout
    // update — no deleteSurface frame. The provisional surface
    // stays painted in the renderer until authoritative handoff
    // aborts the runner via `finalizeProvisionalPreview`. Tearing
    // it down here would blank the viewer between
    // "preview-done" and "final-code-arrives".
    const { ctx, recorded } = makeCtx();
    await produceDeterministicPreview(ctx);
    expect(recorded).toHaveLength(3);

    const [one, two, three] = recorded.map((r) =>
      expectValidServerMessage(r),
    );
    expect('createSurface' in one).toBe(true);
    expect('updateComponents' in two).toBe(true);
    expect('updateComponents' in three).toBe(true);
    // Explicit negative: NO deleteSurface in the emitted set.
    for (const frame of [one, two, three]) {
      expect('deleteSurface' in frame).toBe(false);
    }
  });

  it('defaults surfaceId to ctx.renderId and catalogId to ggui.preview.v1', async () => {
    const { ctx, recorded } = makeCtx({ renderId: 'specific-page' });
    await produceDeterministicPreview(ctx);
    const created = expectValidServerMessage(recorded[0]);
    if (!('createSurface' in created)) throw new Error('narrow');
    expect(created.createSurface.surfaceId).toBe('specific-page');
    expect(created.createSurface.catalogId).toBe(GGUI_PREVIEW_CATALOG_V1_ID);
  });

  it('honors surfaceId override on createSurface (no deleteSurface to verify)', async () => {
    const { ctx, recorded } = makeCtx({ renderId: 'page-1' });
    await produceDeterministicPreview(ctx, { surfaceId: 'override-surface' });
    expect(recorded).toHaveLength(3);
    const created = expectValidServerMessage(recorded[0]);
    if (!('createSurface' in created)) throw new Error('narrow');
    expect(created.createSurface.surfaceId).toBe('override-surface');
    // The 3-frame happy path no longer emits deleteSurface — the
    // surface stays painted in the renderer until authoritative
    // handoff. Asserting the override on createSurface alone is
    // sufficient for the surface-id contract.
  });

  it('derives heading from first sentence of intent, capitalized', async () => {
    const { ctx, recorded } = makeCtx({
      story: { intent: 'build a weather dashboard. show the forecast.' },
    });
    await produceDeterministicPreview(ctx);
    const rootUpdate = expectValidServerMessage(recorded[1]);
    if (!('updateComponents' in rootUpdate)) throw new Error('narrow');
    const heading = rootUpdate.updateComponents.components.find(
      (c) => c.id === 'heading',
    );
    expect(heading).toBeDefined();
    if (heading?.component !== 'Text') throw new Error('narrow');
    expect(heading.text).toBe('Build a weather dashboard');
  });

  it('degrades to a placeholder heading when intent is empty', async () => {
    const { ctx, recorded } = makeCtx({ story: { intent: '   ' } });
    await produceDeterministicPreview(ctx);
    const rootUpdate = expectValidServerMessage(recorded[1]);
    if (!('updateComponents' in rootUpdate)) throw new Error('narrow');
    const heading = rootUpdate.updateComponents.components.find(
      (c) => c.id === 'heading',
    );
    if (heading?.component !== 'Text') throw new Error('narrow');
    expect(heading.text).toBe('Preparing your view…');
  });
});

describe('produceDeterministicPreview — keyword-driven shells', () => {
  it('renders form shells when intent mentions a form pattern', async () => {
    const { ctx, recorded } = makeCtx({
      story: { intent: 'collect feedback via a form with a submit button' },
    });
    await produceDeterministicPreview(ctx);
    const enriched = expectValidServerMessage(recorded[2]);
    if (!('updateComponents' in enriched)) throw new Error('narrow');
    const ids = enriched.updateComponents.components.map((c) => c.id);
    expect(ids).toContain('form-card');
    expect(ids).toContain('tf');
    expect(ids).toContain('btn');
  });

  it('renders list shells when intent mentions a list / dashboard pattern', async () => {
    const { ctx, recorded } = makeCtx({
      story: { intent: 'show a todo list dashboard with items' },
    });
    await produceDeterministicPreview(ctx);
    const enriched = expectValidServerMessage(recorded[2]);
    if (!('updateComponents' in enriched)) throw new Error('narrow');
    const ids = enriched.updateComponents.components.map((c) => c.id);
    expect(ids).toContain('list-card');
    expect(ids).toContain('list');
  });

  it('degrades to heading + body only for intents with no keyword match', async () => {
    const { ctx, recorded } = makeCtx({
      story: { intent: 'calm blue sky morning thought' },
    });
    await produceDeterministicPreview(ctx);
    const enriched = expectValidServerMessage(recorded[2]);
    if (!('updateComponents' in enriched)) throw new Error('narrow');
    const root = enriched.updateComponents.components.find(
      (c) => c.id === 'root',
    );
    if (root?.component !== 'Column') throw new Error('narrow');
    expect(root.children).toEqual(['heading', 'body']);
  });
});

describe('produceDeterministicPreview — every emitted component is catalog-valid', () => {
  it('every component in every updateComponents frame parses against the V1 catalog', async () => {
    const { ctx, recorded } = makeCtx({
      story: { intent: 'signup form with submit button' },
    });
    await produceDeterministicPreview(ctx);
    // Frames 2 and 3 are updateComponents.
    for (const idx of [1, 2]) {
      const msg = expectValidServerMessage(recorded[idx]);
      if (!('updateComponents' in msg)) throw new Error('narrow');
      for (const component of msg.updateComponents.components) {
        const parsed = parseComponent(component);
        expect(parsed.ok).toBe(true);
      }
    }
  });
});

describe('produceDeterministicPreview — cancellation', () => {
  it('stops emitting once the signal aborts between frames', async () => {
    const { ctx, recorded, abortController } = makeCtx();
    const originalEmit = ctx.emit;
    const wrappedCtx: DeterministicPreviewContext = {
      ...ctx,
      emit: async (payload) => {
        const result = await originalEmit(payload);
        // Abort after the first frame (createSurface). Producer
        // should not issue any subsequent emits.
        if (recorded.length === 1) abortController.abort();
        return result;
      },
    };
    await produceDeterministicPreview(wrappedCtx);
    // createSurface only — the signal abort kicked in before the
    // next emit.
    expect(recorded).toHaveLength(1);
  });
});

describe('createDeterministicPreviewEmitter', () => {
  it('returns a ProvisionalPreviewEmitter-shaped object with run()', async () => {
    const { ctx, recorded } = makeCtx();
    const emitter = createDeterministicPreviewEmitter();
    expect(typeof emitter.run).toBe('function');
    await emitter.run(ctx);
    // Three frames on the happy path — see the 3-frame contract
    // note in `produceDeterministicPreview`. No deleteSurface so
    // the assembled surface persists in the renderer.
    expect(recorded).toHaveLength(3);
  });

  it('forwards options to the underlying producer', async () => {
    const { ctx, recorded } = makeCtx();
    const emitter = createDeterministicPreviewEmitter({
      surfaceId: 'custom-surface',
    });
    await emitter.run(ctx);
    const created = expectValidServerMessage(recorded[0]);
    if (!('createSurface' in created)) throw new Error('narrow');
    expect(created.createSurface.surfaceId).toBe('custom-surface');
  });
});
