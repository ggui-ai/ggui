import { describe, expect, it } from 'vitest';
import type {
  Blueprint,
  DataContract,
  UIGenerationResponse,
} from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  InMemoryBlueprintStore,
  createInMemoryGeneratorRegistry,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  BlueprintProvider,
  GeneratorRegistry,
  UiGenerateInput,
  UiGenerateResult,
  UiGenerator,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext } from '../types.js';
import {
  GeneratorNotFoundError,
  GenerationFailedError,
  MissingCredentialsError,
} from './errors.js';
import { createGguiOpsGenerateBlueprintHandler } from './generate.js';
import type { GenerationCredentials } from '../session-mutations/index.js';

/**
 * Build a mock UiGenerator that returns a pre-baked componentCode.
 * The slug + tier + model are required by the registry; pick valid
 * fixed-format values.
 */
function makeMockGenerator(opts: {
  slug?: string;
  componentCode?: string;
  validatorScore?: number;
  fail?: boolean;
  throws?: boolean;
} = {}): UiGenerator {
  const componentCode = opts.componentCode ?? 'export default function Foo() { return null; }';
  return {
    slug: opts.slug ?? 'ui-gen-default-haiku-4-5',
    tier: 'default',
    model: 'haiku-4-5',
    async generate(_input: UiGenerateInput): Promise<UiGenerateResult> {
      if (opts.throws) {
        throw new Error('mock generator threw');
      }
      if (opts.fail) {
        return {
          ok: false,
          error: {
            code: 'PRODUCTION_FAILED',
            message: 'mock generator failed',
          },
        };
      }
      const response: UIGenerationResponse = {
        renderId: 'render_mock',
        componentCode,
      };
      const metadata = {
        provider: 'anthropic' as const,
        model: 'claude-haiku-4-5-20251001',
        inputTokens: 100,
        outputTokens: 200,
        latencyMs: 50,
        cacheHit: false,
        ...(opts.validatorScore !== undefined
          ? { validatorScore: opts.validatorScore }
          : {}),
      };
      return { ok: true, response, metadata };
    },
  };
}

const fakeBlueprints: BlueprintProvider = {
  async list() {
    return [];
  },
  async get() {
    return null;
  },
};

const fakeCredentials: GenerationCredentials = {
  selection: {
    provider: 'anthropic',
    model: 'claude-haiku-4-5-20251001',
  },
  providerKey: {
    provider: 'anthropic',
    key: 'sk-test',
  },
};

function makeCtx(appId: string): HandlerContext {
  return { appId, requestId: 'req-1' };
}

function emptyContract(): DataContract {
  return {};
}

function defaultDeps(opts: {
  registry?: GeneratorRegistry;
  blueprintStore?: InMemoryBlueprintStore;
  resolveLlm?: (
    ctx: HandlerContext,
  ) =>
    | Promise<GenerationCredentials | null>
    | GenerationCredentials
    | null;
  listAllForApp?: (appId: string) => Promise<readonly Blueprint[]>;
  generator?: UiGenerator;
} = {}) {
  const generator = opts.generator ?? makeMockGenerator();
  const registry =
    opts.registry ??
    createInMemoryGeneratorRegistry({ default: generator });
  const blueprintStore = opts.blueprintStore ?? new InMemoryBlueprintStore();
  return {
    registry,
    blueprintStore,
    blueprints: fakeBlueprints,
    resolveLlm:
      opts.resolveLlm ??
      (() => fakeCredentials),
    putCode: (codeHash: string, body: string) => {
      blueprintStore.putCode(codeHash, body);
    },
    ...(opts.listAllForApp ? { listAllForApp: opts.listAllForApp } : {}),
    now: () => '2026-05-12T00:00:00.000Z',
    mintBlueprintId: (() => {
      let n = 0;
      return () => `bp_test_${++n}`;
    })(),
  };
}

describe('createGguiOpsGenerateBlueprintHandler — declaration', () => {
  it('exposes the canonical tool name', () => {
    const handler = createGguiOpsGenerateBlueprintHandler(defaultDeps());
    expect(handler.name).toBe('ggui_ops_generate_blueprint');
  });

  it('is tagged audience: ops', () => {
    const handler = createGguiOpsGenerateBlueprintHandler(defaultDeps());
    expect(handler.audience).toEqual(['ops']);
  });
});

describe('createGguiOpsGenerateBlueprintHandler — happy path', () => {
  it('dispatches through the registry default generator', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      { contract: emptyContract() },
      makeCtx('app-1'),
    );
    expect(result.blueprintId).toBe('bp_test_1');
    expect(result.generator).toBe('ui-gen-default-haiku-4-5');
    expect(result.codeHash).toBeDefined();
    expect(result.codeHash?.length).toBe(32);
  });

  it('dispatches through an explicit generator slug', async () => {
    const advancedGen = makeMockGenerator({
      slug: 'ui-gen-advanced-opus-4-7',
      componentCode: 'export default function Bar() { return null; }',
      validatorScore: 0.92,
    });
    const registry = createInMemoryGeneratorRegistry({
      default: makeMockGenerator(),
      generators: [advancedGen],
    });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        generator: 'ui-gen-advanced-opus-4-7',
      },
      makeCtx('app-1'),
    );
    expect(result.generator).toBe('ui-gen-advanced-opus-4-7');
    expect(result.validatorScore).toBe(0.92);
  });

  it('persists the blueprint with createdBy="operator"', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      { contract: emptyContract() },
      makeCtx('app-1'),
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted).not.toBeNull();
    expect(persisted?.createdBy).toBe('operator');
    expect(persisted?.appId).toBe('app-1');
    expect(persisted?.generator).toBe('ui-gen-default-haiku-4-5');
    expect(persisted?.contractHash).toBe(blueprintKey(emptyContract()));
  });

  it('normalizes persona to lowercase + trim', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        persona: '  Data-Dense  ',
      },
      makeCtx('app-1'),
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance.persona).toBe('data-dense');
  });

  it('persists seedPrompt and context', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        seedPrompt: 'make it red',
        context: { palette: 'warm' },
      },
      makeCtx('app-1'),
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.variance.seedPrompt).toBe('make it red');
    expect(persisted?.variance.context).toEqual({ palette: 'warm' });
  });

  it('pins as operator default when setAsOperatorDefault=true', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      {
        contract: emptyContract(),
        setAsOperatorDefault: true,
      },
      makeCtx('app-1'),
    );
    const persisted = await deps.blueprintStore.get(result.blueprintId);
    expect(persisted?.isOperatorDefault).toBe(true);
  });

  it('clears prior default when setAsOperatorDefault=true', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    // First generation pinned as default
    const first = await handler.handler(
      {
        contract: emptyContract(),
        setAsOperatorDefault: true,
      },
      makeCtx('app-1'),
    );
    // Second generation also pinned — should clear first
    const second = await handler.handler(
      {
        contract: emptyContract(),
        persona: 'data-dense',
        setAsOperatorDefault: true,
      },
      makeCtx('app-1'),
    );
    const firstRow = await deps.blueprintStore.get(first.blueprintId);
    const secondRow = await deps.blueprintStore.get(second.blueprintId);
    expect(firstRow?.isOperatorDefault).toBeUndefined();
    expect(secondRow?.isOperatorDefault).toBe(true);
  });

  it('makes code retrievable via the in-memory putCode hook', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    const result = await handler.handler(
      { contract: emptyContract() },
      makeCtx('app-1'),
    );
    expect(result.codeHash).toBeDefined();
    const code = deps.blueprintStore.getCode(result.codeHash!);
    expect(code).toContain('export default');
  });
});

describe('createGguiOpsGenerateBlueprintHandler — error paths', () => {
  it('throws GeneratorNotFoundError for unknown slug', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        {
          contract: emptyContract(),
          generator: 'ui-gen-nonexistent-gpt-99',
        },
        makeCtx('app-1'),
      ),
    ).rejects.toBeInstanceOf(GeneratorNotFoundError);
  });

  it('throws MissingCredentialsError when resolveLlm returns null', async () => {
    const deps = defaultDeps({
      resolveLlm: () => null,
    });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        { contract: emptyContract() },
        makeCtx('app-1'),
      ),
    ).rejects.toBeInstanceOf(MissingCredentialsError);
  });

  it('throws GenerationFailedError when generator returns ok:false', async () => {
    const failingGen = makeMockGenerator({ fail: true });
    const registry = createInMemoryGeneratorRegistry({ default: failingGen });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        { contract: emptyContract() },
        makeCtx('app-1'),
      ),
    ).rejects.toBeInstanceOf(GenerationFailedError);
  });

  it('throws GenerationFailedError when generator throws', async () => {
    const throwingGen = makeMockGenerator({ throws: true });
    const registry = createInMemoryGeneratorRegistry({ default: throwingGen });
    const deps = defaultDeps({ registry });
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        { contract: emptyContract() },
        makeCtx('app-1'),
      ),
    ).rejects.toBeInstanceOf(GenerationFailedError);
  });

  it('throws when appId is empty', async () => {
    const deps = defaultDeps();
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await expect(
      handler.handler(
        { contract: emptyContract() },
        { appId: '', requestId: 'req-1' },
      ),
    ).rejects.toThrow();
  });
});

describe('createGguiOpsGenerateBlueprintHandler — persona near-dup', () => {
  it('emits a near-duplicate-persona warning via telemetry when distance < 2', async () => {
    // Seed an existing blueprint with persona='minimalist'
    const blueprintStore = new InMemoryBlueprintStore();
    const seed: Blueprint = {
      blueprintId: 'bp_seed',
      contractHash: blueprintKey(emptyContract()),
      appId: 'app-1',
      generator: 'ui-gen-default-haiku-4-5',
      variance: { persona: 'minimalist' },
      createdAt: '2026-05-12T00:00:00.000Z',
      createdBy: 'operator',
      contract: emptyContract(),
    };
    await blueprintStore.put(seed);

    const emissions: Array<{ name: string; attributes?: Record<string, unknown> }> = [];
    const deps = {
      ...defaultDeps({ blueprintStore }),
      listAllForApp: (appId: string) => blueprintStore.listAllForApp(appId),
      telemetry: {
        emit(event: { name: string; at: number; attributes?: Record<string, string | number | boolean> }) {
          emissions.push({ name: event.name, attributes: event.attributes });
        },
      },
    };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await handler.handler(
      {
        contract: emptyContract(),
        persona: 'minimalst', // distance 1 from 'minimalist'
      },
      makeCtx('app-1'),
    );
    const nearDup = emissions.find(
      (e) => e.name === 'blueprint.near_duplicate_persona',
    );
    expect(nearDup).toBeDefined();
    expect(nearDup?.attributes?.newPersona).toBe('minimalst');
    expect(nearDup?.attributes?.nearestExisting).toBe('minimalist');
    expect(nearDup?.attributes?.nearestDistance).toBe(1);
  });

  it('does NOT emit a warning when persona is unique', async () => {
    const blueprintStore = new InMemoryBlueprintStore();
    const seed: Blueprint = {
      blueprintId: 'bp_seed',
      contractHash: blueprintKey(emptyContract()),
      appId: 'app-1',
      generator: 'ui-gen-default-haiku-4-5',
      variance: { persona: 'minimalist' },
      createdAt: '2026-05-12T00:00:00.000Z',
      createdBy: 'operator',
      contract: emptyContract(),
    };
    await blueprintStore.put(seed);

    const emissions: Array<{ name: string }> = [];
    const deps = {
      ...defaultDeps({ blueprintStore }),
      listAllForApp: (appId: string) => blueprintStore.listAllForApp(appId),
      telemetry: {
        emit(event: { name: string; at: number; attributes?: Record<string, string | number | boolean> }) {
          emissions.push({ name: event.name });
        },
      },
    };
    const handler = createGguiOpsGenerateBlueprintHandler(deps);
    await handler.handler(
      {
        contract: emptyContract(),
        persona: 'data-dense', // unrelated
      },
      makeCtx('app-1'),
    );
    const nearDup = emissions.find(
      (e) => e.name === 'blueprint.near_duplicate_persona',
    );
    expect(nearDup).toBeUndefined();
  });
});
