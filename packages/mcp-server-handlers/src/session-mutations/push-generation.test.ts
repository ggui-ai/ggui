/**
 * Focused coverage for `ggui_push` wired against a real `UiGenerator`.
 * The tests use a fake `UiGenerator` (no live LLM, no vitest network
 * dep) to prove the wiring:
 *
 *   - happy path: push awaits generation, appends real componentCode
 *     as a StackItem, returns codeReady:true, preview is torn down
 *     via the handoff helper.
 *   - generator failure: push returns codeReady:false, the error is
 *     recorded as a stack item, preview cancel reason is
 *     `'generation-failed'`, the RPC does NOT throw.
 *   - no-credentials: `resolveLlm` returns `null` → same shape with
 *     reason `'no-credentials'`.
 *   - no generation deps: existing placeholder behavior preserved.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { combineMcpAppAiGguiMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  BlueprintProvider,
  LlmProvider,
  SessionStore,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import {
  InMemoryKeyValueStore,
  InMemorySessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { createGguiPushHandler } from './push.js';
import { createGguiHandshakeHandler } from './handshake.js';
import type { GenerationCredentials, GenerationDeps } from './push.js';
import type {
  ProvisionalPreviewDeps,
  ProvisionalPreviewOutcome,
} from './provisional-preview.js';
import { createInMemoryProvisionalPreviewRegistry } from './provisional-preview.js';

// Minimal contract used when a test doesn't care about contract content.
const NOOP_CONTRACT: DataContract = {};

// ─── Fixtures ─────────────────────────────────────────────────

const PROVIDER: LlmProvider = 'anthropic';
const MODEL = 'claude-opus-4-7';

const emptyBlueprints: BlueprintProvider = {
  async list() {
    return [];
  },
  async get() {
    return null;
  },
};

const validCreds: GenerationCredentials = {
  selection: { provider: PROVIDER, model: MODEL },
  providerKey: { provider: PROVIDER, key: 'test-key' },
};

function makeGenerator(impl: UiGenerator['generate']): UiGenerator {
  return {
    slug: 'ui-gen-default-test',
    tier: 'default',
    model: 'test',
    generate: impl,
  };
}

function makeGenerationDeps(overrides: {
  readonly uiGenerator: UiGenerator;
  readonly resolveLlm?: GenerationDeps['resolveLlm'];
}): GenerationDeps {
  return {
    uiGenerator: overrides.uiGenerator,
    resolveLlm: overrides.resolveLlm ?? (() => validCreds),
    blueprints: emptyBlueprints,
  };
}

function makePreviewDeps(): {
  readonly deps: ProvisionalPreviewDeps;
  readonly outcomes: ProvisionalPreviewOutcome[];
} {
  const outcomes: ProvisionalPreviewOutcome[] = [];
  const registry = createInMemoryProvisionalPreviewRegistry();
  const deps: ProvisionalPreviewDeps = {
    config: { enabled: true },
    emitter: {
      run: async (ctx) => {
        await Promise.resolve();
        if (ctx.signal.aborted) return;
        await ctx.emit({
          type: 'createSurface',
          surfaceId: ctx.stackItemId,
          components: {},
        });
      },
    },
    sendEnvelope: async () => ({ seq: 1 }),
    registry,
    onOutcome: (o) => outcomes.push(o),
  };
  return { deps, outcomes };
}

async function seedHandshake(
  kvStore: InMemoryKeyValueStore,
  input: {
    readonly intent: string;
    readonly contract?: DataContract;
    /**
     * Optional variance — migrated from the pre-MVB-5 `hint`
     * group, which has been retired. The handshake handler stamps
     * variance.context onto `suggestion.blueprintMeta.variance.context`
     * (it does NOT flow to `UIGenerationRequest.context` — the
     * pre-MVB-5 `hint.context → request.context` plumbing was
     * removed in D10).
     */
    readonly variance?: {
      readonly persona?: string;
      readonly aesthetic?: string;
      readonly context?: Record<string, unknown>;
      readonly seedPrompt?: string;
    };
  },
  appId = 'app-1',
): Promise<string> {
  const handshake = createGguiHandshakeHandler({ kvStore });
  const out = await handshake.handler(
    {
      sessionId: 'sess-test',
      intent: input.intent,
      blueprintDraft: {
        contract: input.contract ?? {},
        ...(input.variance !== undefined ? { variance: input.variance } : {}),
      },
    },
    { appId, requestId: 'req-hs' },
  );
  return out.handshakeId;
}

// ─── Tests ────────────────────────────────────────────────────

describe('ggui_push — real generator wiring', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  it('happy path: awaits generation, appends StackItem, returns codeReady:true, preview handoff fires', async () => {
    let generateArgs: Parameters<UiGenerator['generate']>[0] | null = null;
    const uiGenerator = makeGenerator(async (input) => {
      generateArgs = input;
      return {
        ok: true,
        response: {
          stackItemId: 'generator-stack-item-id-ignored',
          componentCode:
            "export default function Card() { return <div>generated!</div>; }",
          sourceCode:
            "export default function Card() { return <div>generated!</div>; }",
        },
        metadata: {
          provider: PROVIDER,
          model: MODEL,
          inputTokens: 10,
          outputTokens: 20,
          latencyMs: 42,
          cacheHit: false,
          attempts: 1,
        },
      };
    });

    const { deps: preview, outcomes } = makePreviewDeps();
    const kvStore = new InMemoryKeyValueStore();

    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      provisionalPreview: preview,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'make a card',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(true);
    expect(output.stackItemId).toMatch(/[0-9a-f-]{36}/);

    const session = await sessionStore.get(output.sessionId);
    expect(session?.stack.length).toBe(1);
    const entry = session?.stack[0];
    if (!entry || entry.type === 'mcpApps' || entry.type === 'system') {
      throw new Error('expected a component stack entry');
    }
    expect(entry.id).toBe(output.stackItemId);
    expect(entry.componentCode).toContain('generated!');
    expect(entry.prompt).toBe('make a card');
    expect(entry.contentType).toBe('application/javascript+react');
    expect(entry.error).toBeUndefined();

    expect(generateArgs).not.toBeNull();
    expect(generateArgs!.request.prompt).toBe('make a card');
    expect(generateArgs!.request.sessionId).toBe(output.sessionId);
    expect(generateArgs!.llm).toEqual(validCreds.selection);
    expect(generateArgs!.providerKey).toEqual(validCreds.providerKey);
    expect(generateArgs!.blueprints).toBe(emptyBlueprints);

    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.status !== 'cancelled') return;
    expect(cancelled.reason).toBe('handoff');
    expect(cancelled.stackItemId).toBe(output.stackItemId);
  });

  it('generator error: returns codeReady:false, appends error-only stack item, preview cancels with generation-failed', async () => {
    const uiGenerator = makeGenerator(async () => ({
      ok: false,
      error: {
        code: 'PRODUCTION_FAILED',
        message: 'provider returned 429 — rate-limited',
        details: { kind: 'rate-limited', provider: PROVIDER, status: 429 },
      },
    }));

    const { deps: preview, outcomes } = makePreviewDeps();
    const kvStore = new InMemoryKeyValueStore();

    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      provisionalPreview: preview,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'make a card',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(false);

    const session = await sessionStore.get(output.sessionId);
    expect(session?.stack.length).toBe(1);
    const entry = session?.stack[0];
    if (!entry || entry.type === 'mcpApps' || entry.type === 'system') {
      throw new Error('expected a component stack entry (error shape)');
    }
    expect(entry.id).toBe(output.stackItemId);
    expect(entry.componentCode).toBe('');
    expect(entry.error).toBe('provider returned 429 — rate-limited');
    expect(entry.prompt).toBe('make a card');

    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    expect(cancelled).toBeDefined();
    if (cancelled?.status !== 'cancelled') return;
    expect(cancelled.reason).toBe('generation-failed');
  });

  it('no-credentials: resolveLlm returns null → codeReady:false, error stack item, preview cancel reason "no-credentials"', async () => {
    const uiGenerator = makeGenerator(async () => {
      throw new Error(
        'generator should NOT be invoked when resolveLlm returns null',
      );
    });

    const { deps: preview, outcomes } = makePreviewDeps();
    const kvStore = new InMemoryKeyValueStore();

    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      provisionalPreview: preview,
      generation: makeGenerationDeps({
        uiGenerator,
        resolveLlm: () => null,
      }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'make a card',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(false);

    const session = await sessionStore.get(output.sessionId);
    expect(session?.stack.length).toBe(1);
    const entry = session?.stack[0];
    if (!entry || entry.type === 'mcpApps' || entry.type === 'system') {
      throw new Error('expected a component stack entry (error shape)');
    }
    expect(entry.componentCode).toBe('');
    expect(entry.error).toMatch(/no credentials available/i);

    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') return;
    expect(cancelled.reason).toBe('no-credentials');
  });

  it('generator thrown exception: does not crash the RPC, commits error stack item with reason "generator-threw"', async () => {
    const uiGenerator = makeGenerator(async () => {
      throw new Error('simulated crash in generator');
    });

    const { deps: preview, outcomes } = makePreviewDeps();
    const kvStore = new InMemoryKeyValueStore();

    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      provisionalPreview: preview,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'buggy generator',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(false);

    const session = await sessionStore.get(output.sessionId);
    const entry = session?.stack[0];
    if (!entry || entry.type === 'mcpApps' || entry.type === 'system') {
      throw new Error('expected a component stack entry (error shape)');
    }
    expect(entry.error).toMatch(/generator threw.*simulated crash/i);

    const cancelled = outcomes.find((o) => o.status === 'cancelled');
    if (cancelled?.status !== 'cancelled') return;
    expect(cancelled.reason).toBe('generator-threw');
  });

  it('blueprintDraft.variance.context does NOT flow into UIGenerationRequest.context (D10 — request.context is not a wire surface)', async () => {
    // Pre-MVB-5 pinned `handshake({hint: {context}}) → push → UIGenerationRequest.context`.
    // D10 retires that plumbing: agent-supplied variance.context is
    // captured on `suggestion.blueprintMeta.variance.context` for
    // variant-selection / synth observability, but it does NOT flow
    // to the generator's `request.context`. Lock the new invariant
    // so a future regression that accidentally re-wires the field
    // fails loudly here instead of silently re-leaking agent
    // variance into prompt context.
    let generateArgs: Parameters<UiGenerator['generate']>[0] | null = null;
    const uiGenerator = makeGenerator(async (input) => {
      generateArgs = input;
      return {
        ok: true,
        response: {
          stackItemId: 'ignored',
          componentCode: 'export default () => null;',
        },
        metadata: {
          provider: PROVIDER,
          model: MODEL,
          inputTokens: 1,
          outputTokens: 1,
          latencyMs: 1,
          cacheHit: false,
        },
      };
    });

    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'weather card',
      variance: { context: { city: 'Tokyo' } },
      contract: NOOP_CONTRACT,
    });

    await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(generateArgs).not.toBeNull();
    expect(generateArgs!.request.context).toBeUndefined();
  });

  it('regression lock: no generation deps → codeReady:false, stack empty (placeholder behavior)', async () => {
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'make a card',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(false);
    const session = await sessionStore.get(output.sessionId);
    expect(session?.stack).toEqual([]);
  });

  it('resolveLlm receives the handler context (appId passthrough)', async () => {
    let seenCtx: { appId: string; requestId: string } | null = null;
    const uiGenerator = makeGenerator(async () => ({
      ok: true,
      response: {
        stackItemId: 'ignored',
        componentCode: 'export default () => null;',
      },
      metadata: {
        provider: PROVIDER,
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        cacheHit: false,
      },
    }));

    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      generation: makeGenerationDeps({
        uiGenerator,
        resolveLlm: (ctx) => {
          seenCtx = { appId: ctx.appId, requestId: ctx.requestId };
          return validCreds;
        },
      }),
    });
    const handshakeId = await seedHandshake(
      kvStore,
      { intent: 'x', contract: NOOP_CONTRACT },
      'multi-tenant-app',
    );

    await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'multi-tenant-app', requestId: 'req-xyz' },
    );

    expect(seenCtx).toEqual({
      appId: 'multi-tenant-app',
      requestId: 'req-xyz',
    });
  });
});

// ─── Phase 3.1b — generator override seam ───
//
// Pin the cold-gen wiring of the cloud-flavored `generator` seam:
// a pre-resolved generator that bypasses `resolveLlm` because cloud's
// pod-side runner owns its own credentials (BYOK or pool key).

describe('ggui_push — Phase 3.1b cloud seam (generator override)', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  describe('generator override', () => {
    it('when set, bypasses resolveLlm and routes cold-gen through the override', async () => {
      let resolveLlmCalled = false;
      let overrideArgs: unknown = null;
      const override = async (input: unknown) => {
        overrideArgs = input;
        return {
          ok: true as const,
          response: {
            stackItemId: 'ignored',
            componentCode:
              "export default function Card() { return <div>via-override</div>; }",
            sourceCode:
              "export default function Card() { return <div>via-override</div>; }",
          },
          metadata: {
            provider: PROVIDER,
            model: MODEL,
            inputTokens: 0,
            outputTokens: 0,
            latencyMs: 1,
            cacheHit: false,
          },
        };
      };
      // OSS uiGenerator that should NEVER be called when the override is wired.
      const ossGenerator = makeGenerator(async () => {
        throw new Error('OSS uiGenerator should not run when override is set');
      });
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiPushHandler({
        sessionStore,
        renderBaseUrl: 'http://localhost/r/',
        handshakeStore: kvStore,
        generation: makeGenerationDeps({
          uiGenerator: ossGenerator,
          resolveLlm: () => {
            resolveLlmCalled = true;
            return validCreds;
          },
        }),
        generator: override,
      });
      const handshakeId = await seedHandshake(kvStore, {
        intent: 'cloud-bypass test',
        contract: NOOP_CONTRACT,
      });
      const output = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        { appId: 'app-1', requestId: 'req-1' },
      );
      expect(output.codeReady).toBe(true);
      // Most important: resolveLlm was not invoked.
      expect(resolveLlmCalled).toBe(false);
      // Override input shape: NO `llm` / `providerKey` keys (omitted by type).
      expect(overrideArgs).not.toBeNull();
      expect((overrideArgs as { llm?: unknown }).llm).toBeUndefined();
      expect(
        (overrideArgs as { providerKey?: unknown }).providerKey,
      ).toBeUndefined();
      expect(
        (overrideArgs as { request: { prompt: string } }).request.prompt,
      ).toBe('cloud-bypass test');
    });

    it('when override throws, commits an error stack item with reason "generator-threw"', async () => {
      const override = async () => {
        throw new Error('cloud generator exploded');
      };
      const ossGenerator = makeGenerator(async () => {
        throw new Error('should not run');
      });
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiPushHandler({
        sessionStore,
        renderBaseUrl: 'http://localhost/r/',
        handshakeStore: kvStore,
        generation: makeGenerationDeps({ uiGenerator: ossGenerator }),
        generator: override,
      });
      const handshakeId = await seedHandshake(kvStore, {
        intent: 'override-throws',
        contract: NOOP_CONTRACT,
      });
      const output = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        { appId: 'app-1', requestId: 'req-1' },
      );
      expect(output.codeReady).toBe(false);
      const session = await sessionStore.get(output.sessionId);
      const entry = session?.stack[0];
      if (!entry || entry.type !== 'component') {
        throw new Error('expected component error stack entry');
      }
      expect(entry.error).toBeDefined();
      // `error` is a string envelope, not an object — see commitErrorStackItem.
      expect(entry.error).toContain('generator threw');
    });
  });

});

// ─── F2 fix: contextSpec projection ─────────────
//
// Pin the cold-gen path's contextSpec projection from
// `runGenerationIntoSession` → `StackItem.contextSpec` →
// `bootstrap.contextSlots`. Pre-fix, the projection only spread
// actionSpec/streamSpec/props but omitted contextSpec, so LLM-authored
// slots silently failed to reach the iframe runtime.

describe('ggui_push — contextSpec projection', () => {
  let sessionStore: SessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
  });

  it('cold-gen path: generator-returned contextSpec lands on StackItem AND bootstrap.contextSlots', async () => {
    const uiGenerator = makeGenerator(async () => ({
      ok: true,
      response: {
        stackItemId: 'ignored',
        componentCode: "export default function C() { return <div>x</div>; }",
        sourceCode: "export default function C() { return <div>x</div>; }",
        contract: {
          contextSpec: {
            currentStep: { schema: { type: 'number' }, default: 1 },
            draftText: { schema: { type: 'string' }, debounceMs: 500 },
          },
        },
      },
      metadata: {
        provider: PROVIDER,
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        cacheHit: false,
        attempts: 1,
      },
    }));

    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'wizard',
      contract: NOOP_CONTRACT,
    });

    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );

    expect(output.codeReady).toBe(true);

    const session = await sessionStore.get(output.sessionId);
    const entry = session?.stack[0];
    if (!entry || entry.type === 'mcpApps' || entry.type === 'system') {
      throw new Error('expected component stack entry');
    }
    expect(entry.contextSpec).toBeDefined();
    expect(entry.contextSpec?.currentStep?.schema).toEqual({ type: 'number' });
    expect(entry.contextSpec?.draftText?.debounceMs).toBe(500);

    const meta = await handler.resultMeta?.(output, {}, {
      appId: 'app-1',
      requestId: 'req-1',
    });
    const combined = combineMcpAppAiGguiMeta(meta);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    const bootstrap = combined.bootstrap;
    expect(bootstrap.contextSlots).toBeDefined();
    expect(bootstrap.contextSlots).toHaveLength(2);
    const byName = Object.fromEntries(
      (bootstrap.contextSlots ?? []).map((s) => [s.name, s]),
    );
    expect(byName.currentStep?.default).toBe(1);
    expect(byName.draftText?.default).toBe('');
    expect(byName.currentStep?.contextName).toBe('CurrentStepContext');
    expect(byName.draftText?.debounceMs).toBe(500);
  });

  it('cold-gen path: contextSpec absent → bootstrap.contextSlots undefined', async () => {
    const uiGenerator = makeGenerator(async () => ({
      ok: true,
      response: {
        stackItemId: 'ignored',
        componentCode: 'export default () => null;',
      },
      metadata: {
        provider: PROVIDER,
        model: MODEL,
        inputTokens: 1,
        outputTokens: 1,
        latencyMs: 1,
        cacheHit: false,
        attempts: 1,
      },
    }));
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiPushHandler({
      sessionStore,
      renderBaseUrl: 'http://localhost/r/',
      handshakeStore: kvStore,
      generation: makeGenerationDeps({ uiGenerator }),
    });
    const handshakeId = await seedHandshake(kvStore, {
      intent: 'no contextSpec',
      contract: NOOP_CONTRACT,
    });
    const output = await handler.handler(
      { handshakeId, decision: { kind: 'accept' } },
      { appId: 'app-1', requestId: 'req-1' },
    );
    const meta = await handler.resultMeta?.(output, {}, {
      appId: 'app-1',
      requestId: 'req-1',
    });
    const combined = combineMcpAppAiGguiMeta(meta);
    expect(combined.ok).toBe(true);
    if (!combined.ok) return;
    expect(combined.bootstrap.contextSlots).toBeUndefined();
  });
});
