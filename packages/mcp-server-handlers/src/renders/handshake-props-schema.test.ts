/**
 * Schema-precise render P1 — the frozen handshake wire fields
 * (`propsSchema` / `propsSchemaHash` / `propsSchemaProfile`) and the
 * persisted-schema AUTHORITY path on `ggui_render`.
 *
 * Frozen shape (P3 consumer review, guuey#271, 2026-08-19 — the six
 * pins in docs/plans/2026-08-19-schema-precise-render.md §2):
 *
 *   - pin 1: fields ride the RESULT BODY (the handler's zod
 *     outputSchema declares them; they survive the strip gate).
 *   - pin 2: hash + profile on EVERY non-declined handshake — the
 *     verbatim-agent path omits only the schema VALUE; declined
 *     handshakes carry none of the three.
 *   - AUTHORITY (persisted, not recomputed): ggui_render validates
 *     against the schema PERSISTED on the HandshakeRecord at
 *     handshake time — under version skew the returned schema and
 *     the enforced schema cannot diverge. Proven here by seeding a
 *     record whose persisted schema deliberately differs from its
 *     propsSpec and asserting the persisted schema wins.
 *   - Breach classifier: props violations carry the ENFORCED schema's
 *     hash on the error data and the telemetry event.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryBlueprintIndex,
  InMemoryKeyValueStore,
  InMemoryGguiSessionStore,
  InMemoryVectorStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type {
  EmbeddingProvider,
  UiGenerateResult,
} from '@ggui-ai/mcp-server-core';
import {
  buildEnforcedPropsSchema,
  canonicalizeValue,
  classifyPropsSchemaProfile,
  ContractViolationError,
  type DataContract,
  type JsonSchema,
} from '@ggui-ai/protocol';
import { computePropsSchemaHash } from '@ggui-ai/protocol/props-schema-hash';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import {
  createGguiHandshakeHandler,
  handshakeRecordKey,
  type HandshakeNegotiator,
  type HandshakeRecord,
} from './handshake.js';
import { createGguiRenderHandler } from './render.js';
import type { HandlerContext } from '../types.js';

const APP_ID = 'app-p1';
const CTX: HandlerContext = { appId: APP_ID, requestId: 'req-p1' };

const ENUM_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      status: {
        schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
        required: true,
      },
    },
  },
};

const FULL_CONTRACT: DataContract = {
  propsSpec: {
    properties: {
      code: { schema: { type: 'string', pattern: '^[A-Z]+$' } },
    },
  },
};

function minimalInput(contract: DataContract): Record<string, unknown> {
  return { intent: 'a scheduler card', blueprintDraft: { contract } };
}

describe('ggui_handshake — frozen propsSchema wire fields', () => {
  it('verbatim agent accept: hash + profile present, schema value omitted, record persists the schema (pin 2)', async () => {
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiHandshakeHandler({ kvStore });
    const out = await handler.handler(minimalInput(ENUM_CONTRACT), CTX);

    const expectedSchema = buildEnforcedPropsSchema(
      ENUM_CONTRACT.propsSpec!,
    );
    expect(out.propsSchemaHash).toBe(computePropsSchemaHash(expectedSchema));
    expect(out.propsSchemaProfile).toBe('grammar-safe');
    expect(out.propsSchema).toBeUndefined();

    const raw = await kvStore.get(
      handshakeRecordKey(APP_ID, out.handshakeId),
    );
    const record = JSON.parse(raw!) as HandshakeRecord;
    expect(record.propsSchema).toEqual(expectedSchema);
    expect(record.propsSchemaHash).toBe(out.propsSchemaHash);
    expect(record.propsSchemaProfile).toBe('grammar-safe');
  });

  it('amended effective contract: propsSchema value rides the wire (the closed asymmetry)', async () => {
    const amended: DataContract = {
      propsSpec: {
        properties: {
          status: {
            schema: { type: 'string', enum: ['open', 'busy'] },
            required: true,
          },
        },
      },
    };
    const negotiator: HandshakeNegotiator = {
      decide: async () => ({
        action: 'create',
        reason: 'synth amended the draft',
        suggestion: {
          origin: 'synth',
          rationale: 'test',
          blueprintMeta: { contractHash: blueprintKey(amended), variance: {} },
        },
        effectiveContract: amended,
      }),
    };
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiHandshakeHandler({ kvStore, negotiator });
    const out = await handler.handler(minimalInput(ENUM_CONTRACT), CTX);

    const expectedSchema = buildEnforcedPropsSchema(amended.propsSpec!);
    expect(out.propsSchema).toEqual(expectedSchema);
    expect(out.propsSchemaHash).toBe(computePropsSchemaHash(expectedSchema));
    expect(out.propsSchemaProfile).toBe(
      classifyPropsSchemaProfile(expectedSchema),
    );
  });

  it('out-of-core keywords classify full on the wire (pins 4+5)', async () => {
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiHandshakeHandler({ kvStore });
    const out = await handler.handler(minimalInput(FULL_CONTRACT), CTX);
    expect(out.propsSchemaProfile).toBe('full');
  });

  it('declined handshake carries none of the three fields (pin 2 boundary)', async () => {
    const negotiator: HandshakeNegotiator = {
      decide: async () => ({
        action: 'declined',
        reason: 'nothing to render for this intent',
        suggestion: {
          origin: 'agent',
          rationale: 'declined',
          blueprintMeta: {
            contractHash: blueprintKey(ENUM_CONTRACT),
            variance: {},
          },
        },
        effectiveContract: null,
      }),
    };
    const kvStore = new InMemoryKeyValueStore();
    const handler = createGguiHandshakeHandler({ kvStore, negotiator });
    const out = await handler.handler(minimalInput(ENUM_CONTRACT), CTX);
    expect(out.action).toBe('declined');
    expect(out.propsSchema).toBeUndefined();
    expect(out.propsSchemaHash).toBeUndefined();
    expect(out.propsSchemaProfile).toBeUndefined();
  });
});

describe('ggui_render — persisted-schema AUTHORITY', () => {
  const fakeEmbedding: EmbeddingProvider = {
    id: 'mock',
    dimensions: 4,
    embed: async () => [0, 0, 0, 0],
  };
  const fakeGenerator = async (input: {
    request: { sessionId: string };
  }): Promise<UiGenerateResult> => ({
      ok: true,
      response: {
        sessionId: input.request.sessionId,
        componentCode: 'export default function T(){return null}',
      },
      metadata: {
        provider: 'anthropic',
        generator: 'fake-generator',
        model: 'fake',
        inputTokens: 0,
        outputTokens: 0,
        latencyMs: 0,
        cacheHit: false,
      },
    });

  /**
   * Seed a record whose PERSISTED schema deliberately diverges from
   * its propsSpec — the version-skew simulation. propsSpec allows only
   * 'open'; the persisted schema additionally allows 'busy'.
   */
  function skewedRecord(handshakeId: string): {
    record: HandshakeRecord;
    persistedSchema: JsonSchema;
    persistedHash: string;
  } {
    const narrowContract: DataContract = {
      propsSpec: {
        properties: {
          status: { schema: { type: 'string', enum: ['open'] }, required: true },
        },
      },
    };
    const persistedSchema: JsonSchema = {
      additionalProperties: false,
      properties: {
        status: { enum: ['open', 'busy'], type: 'string' },
      },
      required: ['status'],
      type: 'object',
    };
    const persistedHash = computePropsSchemaHash(persistedSchema);
    return {
      record: {
        handshakeId,
        action: 'create',
        reason: 'test',
        input: {
          intent: 'a test card',
          blueprintDraft: { contract: narrowContract },
        },
        target: {},
        suggestion: {
          origin: 'agent',
          rationale: 'test',
          blueprintMeta: {
            contractHash: blueprintKey(narrowContract),
            variance: {},
          },
        },
        effectiveContract: narrowContract,
        propsSchema: persistedSchema,
        propsSchemaHash: persistedHash,
        propsSchemaProfile: 'grammar-safe',
        appId: APP_ID,
        createdAt: new Date().toISOString(),
      },
      persistedSchema,
      persistedHash,
    };
  }

  async function buildRenderHarness(handshakeId: string) {
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const seeded = skewedRecord(handshakeId);
    await handshakeStore.set(
      handshakeRecordKey(APP_ID, handshakeId),
      JSON.stringify(seeded.record),
    );
    const events: Array<{ name: string; attributes: Record<string, unknown> }> =
      [];
    const handler = createGguiRenderHandler({
      handshakeStore,
      renderStore,
      telemetrySink: {
        emit: (e) =>
          events.push({ name: e.name, attributes: { ...(e.attributes ?? {}) } }),
      },
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-fake',
          tier: 'default',
          model: 'fake',
          generate: fakeGenerator,
        },
        resolveLlm: () => null,
        blueprints: { get: async () => null, list: async () => [] },
        cache: { embedding: fakeEmbedding, vectorStore, index },
      },
      generator: fakeGenerator,
    });
    return { handler, events, ...seeded };
  }

  it('validates against the PERSISTED schema, not a propsSpec recomputation (skew-proof)', async () => {
    const { handler } = await buildRenderHarness('hs-skew-accept');
    // 'busy' is INVALID under the record's propsSpec (enum ['open'])
    // but VALID under the persisted schema — the persisted schema must
    // win or AUTHORITY breaks under rolling-deploy version skew.
    const out = await handler.handler(
      { handshakeId: 'hs-skew-accept', props: { status: 'busy' } },
      CTX,
    );
    expect(out).toMatchObject({ codeReady: true });
  });

  it('stamps the persisted schema hash on the violation error and the telemetry event', async () => {
    const { handler, events, persistedHash } =
      await buildRenderHarness('hs-skew-reject');
    let thrown: unknown;
    try {
      await handler.handler(
        { handshakeId: 'hs-skew-reject', props: { status: 'closed' } },
        CTX,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContractViolationError);
    const violationError = thrown as ContractViolationError;
    expect(violationError.propsSchemaHash).toBe(persistedHash);
    expect(violationError.toErrorData().propsSchemaHash).toBe(persistedHash);

    const event = events.find((e) => e.name === 'render.contract_violation')!;
    expect(event.attributes['propsSchemaHash']).toBe(persistedHash);
    expect(event.attributes['violationKeywords']).toBe('enum');
  });

  it('override.contract re-aims enforcement to the recomputed schema with ITS hash (outside the AUTHORITY proviso)', async () => {
    const { handler } = await buildRenderHarness('hs-skew-override');
    const overrideContract: DataContract = {
      propsSpec: {
        properties: {
          status: {
            schema: { type: 'string', enum: ['confirmed'] },
            required: true,
          },
        },
      },
    };
    const expectedHash = computePropsSchemaHash(
      buildEnforcedPropsSchema(overrideContract.propsSpec!),
    );
    let thrown: unknown;
    try {
      await handler.handler(
        {
          handshakeId: 'hs-skew-override',
          props: { status: 'busy' },
          override: { contract: overrideContract },
        },
        CTX,
      );
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ContractViolationError);
    expect((thrown as ContractViolationError).propsSchemaHash).toBe(
      expectedHash,
    );
  });

  it('SESSION CONTINUITY pin (obligation 3): the committed session propsSpec canonically equals the handshake-effective propsSpec', async () => {
    // Regression PIN, not a new behavior: the OSS generator echoes the
    // input contract verbatim today, so this passes — its job is to
    // fail loudly if any generator seam (incl. a composing
    // deployment's override) ever commits a session whose propsSpec
    // differs from the contract the returned schema was derived from.
    // Without this invariant a compiled grammar is NOT legitimately
    // reusable on the update/amend legs.
    const handshakeStore = new InMemoryKeyValueStore();
    const renderStore = new InMemoryGguiSessionStore();
    const vectorStore = new InMemoryVectorStore();
    const index = new InMemoryBlueprintIndex();
    const handshake = createGguiHandshakeHandler({ kvStore: handshakeStore });
    const handshakeOut = await handshake.handler(
      minimalInput(ENUM_CONTRACT),
      CTX,
    );
    const render = createGguiRenderHandler({
      handshakeStore,
      renderStore,
      generation: {
        uiGenerator: {
          slug: 'ui-gen-default-fake',
          tier: 'default',
          model: 'fake',
          generate: fakeGenerator,
        },
        resolveLlm: () => null,
        blueprints: { get: async () => null, list: async () => [] },
        cache: { embedding: fakeEmbedding, vectorStore, index },
      },
      generator: fakeGenerator,
    });
    const out = (await render.handler(
      { handshakeId: handshakeOut.handshakeId, props: { status: 'open' } },
      CTX,
    )) as { sessionId: string };
    const stored = await renderStore.get(out.sessionId);
    expect(stored).not.toBeNull();
    const committedSpec =
      stored!.render.type === 'component'
        ? stored!.render.propsSpec
        : undefined;
    expect(JSON.stringify(canonicalizeValue(committedSpec, false))).toBe(
      JSON.stringify(canonicalizeValue(ENUM_CONTRACT.propsSpec, false)),
    );
  });
});
