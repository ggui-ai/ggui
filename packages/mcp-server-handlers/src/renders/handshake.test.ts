/**
 * `ggui_handshake` handler tests — MVB-5 three-step handshake.
 *
 * Post-Phase-B (flatten-render-identity): handshake input no longer
 * carries `sessionId` — the paired `ggui_render` mints the render
 * server-side. Host conversation grouping (sibling renders within one
 * host chat) lives on the `_meta["ai.ggui/host-session"]` envelope,
 * not on the handshake input.
 *
 * Tests cover:
 *   - declaration shape (outputSchema fields match the new spec)
 *   - no-negotiator default produces `origin: 'agent'`
 *   - negotiator binding round-trips through the suggestion
 *   - record persistence + TTL
 *   - handshake input validation
 *   - blueprintMeta is always present (Option B from the plan)
 *   - alternatives carry through when negotiator supplies them
 */
import { describe, expect, it } from 'vitest';
import { InMemoryKeyValueStore } from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract, HandshakeSuggestion, Blueprint } from '@ggui-ai/protocol';
import {
  createGguiHandshakeHandler,
  consumeHandshakeRecord,
  handshakeRecordKey,
  HANDSHAKE_RECORD_TTL_SEC,
  DEFAULT_GENERATOR_SLUG,
  type HandshakeNegotiator,
  type HandshakeRecord,
} from './handshake';

const MINIMAL_DRAFT = {
  contract: {} as DataContract,
};

const minimalInput = (overrides: Record<string, unknown> = {}) => ({
  intent: 'show weather',
  blueprintDraft: MINIMAL_DRAFT,
  ...overrides,
});

describe('createGguiHandshakeHandler — MVB-5', () => {
  describe('declaration', () => {
    it('exposes the canonical tool name ggui_handshake', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      expect(handler.name).toBe('ggui_handshake');
    });

    it('declares the lean handshakeOutputSchema shape — {handshakeId, action, suggestion, nextStep?}', () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const outKeys = Object.keys(handler.outputSchema).sort();
      // Post-2026-05-13 trim: reason/target/alternatives/contractHash/
      // serverCapabilities echo fields retired (push.ts set the bar;
      // handshake follows). These survive on the internal TS shape /
      // HandshakeRecord for telemetry + post-classify tracing — zod
      // strips them before structuredContent serialization.
      expect(outKeys).toEqual([
        'action',
        'handshakeId',
        'nextStep',
        'suggestion',
      ]);
    });
  });

  describe('no-negotiator default — origin: agent', () => {
    it("stamps an agent-origin suggestion with the agent's draft verbatim", async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('create');
      expect(out.reason).toMatch(/no-negotiator-bound/);
      expect(out.suggestion.origin).toBe('agent');
      expect(out.suggestion.blueprintMeta).toBeDefined();
      expect(out.suggestion.blueprintMeta.codeHash).toBeUndefined();
      expect(out.suggestion.blueprintMeta.generator).toBe(DEFAULT_GENERATOR_SLUG);
    });

    it('returns a non-empty handshakeId', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
      expect(typeof out.handshakeId).toBe('string');
    });

    it('returns a canonical contractHash of the draft', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.contractHash).toBeTruthy();
      expect(out.contractHash).toBe(out.suggestion.blueprintMeta.contractHash);
    });

    it('threads draft variance into the suggestion blueprintMeta', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            variance: {
              persona: 'minimalist',
              context: { aesthetic: 'glassy' },
            },
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.suggestion.blueprintMeta.variance.persona).toBe('minimalist');
      expect(out.suggestion.blueprintMeta.variance.context).toEqual({
        aesthetic: 'glassy',
      });
    });

    it('honors the draft.generator hint when it matches a registered generator', async () => {
      // Strict generator-validator (ea26d3481, 2026-05-18) is an
      // allow-list against the deployment's `defaultGenerator` dep —
      // unknown slugs fail at the wire boundary. To exercise the
      // honor-the-hint path we inject the slug as the registered
      // generator and re-assert; the value flows through to
      // `blueprintMeta.generator`.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        defaultGenerator: 'custom-generator-slug',
      });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            generator: 'custom-generator-slug',
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.suggestion.blueprintMeta.generator).toBe('custom-generator-slug');
    });

    it('forgivingly drops an unknown draft.generator — default used + GENERATOR_UNKNOWN finding', async () => {
      // Forgiving handshake (af7d938b7): an unrecognized generator slug is
      // DROPPED (the server default is used) and surfaced as a warn
      // finding, rather than thrown — the handshake never hard-fails on a
      // fixable detail. (The STRICT render-override path keeps the throwing
      // assert.) The finding names the offending slug so the agent's
      // recovery is unambiguous (omit the field or pass a known one).
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput({
          blueprintDraft: {
            contract: {} as DataContract,
            generator: 'unregistered-slug',
          },
        }),
        { appId: 'app-1', requestId: 'r' },
      );
      // Did NOT throw: falls back to the server default generator…
      expect(out.suggestion.blueprintMeta.generator).toBe(DEFAULT_GENERATOR_SLUG);
      // …and surfaces a GENERATOR_UNKNOWN warn finding naming the slug.
      const finding = out.suggestion.validationFindings?.find(
        (f) => f.code === 'GENERATOR_UNKNOWN',
      );
      expect(finding?.severity).toBe('warn');
      expect(finding?.message).toMatch(/unregistered-slug/);
    });
  });

  describe('persistence', () => {
    it('persists a HandshakeRecord under the (appId, handshakeId) key', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const raw = await kvStore.get(handshakeRecordKey('app-1', out.handshakeId));
      expect(raw).toBeTruthy();
      const record = JSON.parse(raw as string) as HandshakeRecord;
      expect(record.handshakeId).toBe(out.handshakeId);
      expect(record.appId).toBe('app-1');
      expect(record.input.intent).toBe('show weather');
      expect(record.suggestion.origin).toBe('agent');
      expect(record.effectiveContract).toBeDefined();
    });

    it('consumes the record on consumeHandshakeRecord', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const record = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(record).toBeTruthy();
      const second = await consumeHandshakeRecord(kvStore, 'app-1', out.handshakeId);
      expect(second).toBeNull();
    });

    it('scopes records per (appId, handshakeId) — cross-tenant returns null', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const cross = await consumeHandshakeRecord(
        kvStore,
        'app-OTHER',
        out.handshakeId,
      );
      expect(cross).toBeNull();
    });
  });

  describe('negotiator binding', () => {
    it('propagates an `origin: cache` suggestion verbatim', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const cachedSuggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'contract-hash → score 1.00',
        blueprintMeta: {
          blueprintId: 'bp_existing',
          contractHash: 'hash_cached',
          codeHash: 'code_hash_abc',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
      };
      const cachedContract = {} as DataContract;
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'reuse',
          reason: 'cache hit',
          suggestion: cachedSuggestion,
          effectiveContract: cachedContract,
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.action).toBe('reuse');
      expect(out.suggestion).toEqual(cachedSuggestion);
      expect(out.suggestion.blueprintMeta.codeHash).toBe('code_hash_abc');
    });

    it('propagates an `origin: synth` suggestion with amendments', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const synthSuggestion: HandshakeSuggestion = {
        origin: 'synth',
        rationale: 'synth amended invalid draft',
        blueprintMeta: {
          blueprintId: 'bp_provisional',
          contractHash: 'hash_amended',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
        amendments: {
          contractDiff: [
            { op: 'add', path: '/actionSpec/submit', value: { schema: {} } },
          ],
          reasoning: 'added required submit action',
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'create',
          reason: 'synth amended',
          suggestion: synthSuggestion,
          effectiveContract: {} as DataContract,
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.suggestion.origin).toBe('synth');
      expect(out.suggestion.amendments?.reasoning).toBe('added required submit action');
    });

    it('surfaces alternatives from the negotiator', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const alternative: Blueprint = {
        blueprintId: 'bp_alt',
        contractHash: 'hash_alt',
        appId: 'app-1',
        generator: 'ui-gen-default-haiku-4-5',
        variance: { persona: 'data-dense' },
        createdAt: '2026-05-12T00:00:00.000Z',
        createdBy: 'agent',
        contract: {} as DataContract,
      };
      const suggestion: HandshakeSuggestion = {
        origin: 'agent',
        rationale: 'novel-but-clean',
        blueprintMeta: {
          blueprintId: 'bp_prim',
          contractHash: 'hash_prim',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'create',
          reason: 'novel draft',
          suggestion,
          effectiveContract: {} as DataContract,
          alternatives: [alternative],
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.alternatives).toEqual([alternative]);
    });

    it('propagates a target.renderId routing hint from the negotiator', async () => {
      // Phase-B: routing hint collapsed from {sessionId, stackItemId}
      // to a single {renderId?}. The negotiator MAY suggest reusing
      // an existing render (cache / update path).
      const kvStore = new InMemoryKeyValueStore();
      const suggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'reuse existing render',
        blueprintMeta: {
          blueprintId: 'bp_existing',
          contractHash: 'hash_x',
          generator: 'ui-gen-default-haiku-4-5',
          variance: {},
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'update',
          reason: 'update existing render in place',
          suggestion,
          effectiveContract: {} as DataContract,
          target: { renderId: 'render-existing-123' },
        }),
      };
      const handler = createGguiHandshakeHandler({ kvStore, negotiator });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.target.renderId).toBe('render-existing-123');
    });
  });

  describe('input validation', () => {
    it('rejects an input missing blueprintDraft', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      await expect(
        handler.handler(
          { intent: 'hi' },
          { appId: 'app-1', requestId: 'r' },
        ),
      ).rejects.toThrow();
    });

    it('rejects an empty intent', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      await expect(
        handler.handler(
          minimalInput({ intent: '' }),
          { appId: 'app-1', requestId: 'r' },
        ),
      ).rejects.toThrow();
    });

    it('accepts an input WITHOUT sessionId (Phase B — sessionId removed from handshake input)', async () => {
      // Phase B: the handshake no longer carries a sessionId. The
      // paired ggui_render mints the render server-side; host
      // conversation grouping lives on `_meta["ai.ggui/host-session"]`.
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      const out = await handler.handler(
        { intent: 'hi', blueprintDraft: MINIMAL_DRAFT },
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
    });
  });

  describe('TTL', () => {
    it('writes a record with the default TTL (10 minutes)', async () => {
      expect(HANDSHAKE_RECORD_TTL_SEC).toBe(600);
    });
  });

  describe('serverCapabilities', () => {
    it('emits serverCapabilities when the resolver returns a value', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        serverCapabilities: () => ({
          streamWebSocket: { url: 'wss://example.com/ws' },
          streamWebSocketLocalTools: ['get_weather'],
        }),
      });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.serverCapabilities?.streamWebSocket?.url).toBe('wss://example.com/ws');
    });

    it('omits serverCapabilities when the resolver returns undefined', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        serverCapabilities: () => undefined,
      });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.serverCapabilities).toBeUndefined();
    });
  });

  // ============================================================
  // MVB-6 — telemetry signals on `handshake.decided`
  // ============================================================
  describe('MVB-6 telemetry', () => {
    it('emits handshake.decided with selection fields', async () => {
      const events: Array<{ name: string; attributes: Record<string, unknown> }> = [];
      const telemetrySink = {
        emit(event: {
          name: string;
          at: number;
          attributes?: Readonly<Record<string, string | number | boolean>>;
        }) {
          events.push({
            name: event.name,
            attributes: { ...(event.attributes ?? {}) },
          });
        },
      };
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore, telemetrySink });
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(events).toHaveLength(1);
      expect(events[0]!.name).toBe('handshake.decided');
      const attrs = events[0]!.attributes;
      expect(attrs['appId']).toBe('app-1');
      // Phase B: telemetry no longer carries sessionId (the handshake
      // input no longer accepts one; the paired ggui_render mints the
      // render later).
      expect(attrs['sessionId']).toBeUndefined();
      expect(attrs['handshakeId']).toBe(out.handshakeId);
      expect(attrs['action']).toBe('create');
      expect(attrs['origin']).toBe('agent');
      expect(attrs['selectedBlueprintId']).toBe(
        out.suggestion.blueprintMeta.blueprintId,
      );
      expect(attrs['selectionReason']).toBeTruthy();
      expect(attrs['generator']).toBe(DEFAULT_GENERATOR_SLUG);
      // No selectVariant ran ⇒ no confidence axis.
      expect(attrs['selectionConfidence']).toBeUndefined();
    });

    it('threads selectionConfidence when selectedReason carries a conf= suffix', async () => {
      const events: Array<{ attributes: Record<string, unknown> }> = [];
      const telemetrySink = {
        emit(event: {
          name: string;
          at: number;
          attributes?: Readonly<Record<string, string | number | boolean>>;
        }) {
          events.push({ attributes: { ...(event.attributes ?? {}) } });
        },
      };
      const cachedSuggestion: HandshakeSuggestion = {
        origin: 'cache',
        rationale: 'cache hit',
        blueprintMeta: {
          blueprintId: 'bp_picked',
          contractHash: 'hash_x',
          generator: 'ui-gen-advanced-opus-4-7',
          variance: { persona: 'minimalist' },
          // Confidence encoded onto selectedReason per the MVB-6
          // convention (BlueprintMeta doesn't carry confidence as
          // first-class so it round-trips through the reason string).
          selectedReason: 'persona match (data-dense) conf=0.87',
        },
      };
      const negotiator: HandshakeNegotiator = {
        decide: () => ({
          action: 'reuse',
          reason: 'cache hit',
          suggestion: cachedSuggestion,
          effectiveContract: {} as DataContract,
        }),
      };
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({
        kvStore,
        negotiator,
        telemetrySink,
      });
      await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      const attrs = events[0]!.attributes;
      expect(attrs['origin']).toBe('cache');
      expect(attrs['selectedBlueprintId']).toBe('bp_picked');
      expect(attrs['selectionReason']).toContain('persona match');
      expect(attrs['selectionConfidence']).toBe(0.87);
      expect(attrs['generator']).toBe('ui-gen-advanced-opus-4-7');
    });

    it('absent telemetrySink is a noop (no throw)', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const handler = createGguiHandshakeHandler({ kvStore });
      // Without telemetrySink the handler MUST still resolve.
      const out = await handler.handler(
        minimalInput(),
        { appId: 'app-1', requestId: 'r' },
      );
      expect(out.handshakeId).toBeTruthy();
    });
  });
});

// ============================================================
// extractSelectionConfidence pure-function tests
// ============================================================
describe('extractSelectionConfidence', () => {
  it('parses conf=<n> from a reason string', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    expect(extractSelectionConfidence('persona match conf=0.85')).toBe(0.85);
    expect(extractSelectionConfidence('conf=1 — perfect')).toBe(1);
    expect(extractSelectionConfidence('conf=0 — none')).toBe(0);
    expect(extractSelectionConfidence('conf=.5 — weak')).toBe(0.5);
  });

  it('returns undefined when no conf= present', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    expect(extractSelectionConfidence('persona match')).toBeUndefined();
    expect(extractSelectionConfidence(undefined)).toBeUndefined();
    expect(extractSelectionConfidence('')).toBeUndefined();
  });

  it('returns undefined on out-of-range values', async () => {
    const { extractSelectionConfidence } = await import('./handshake');
    // Matcher only accepts 0–1; "1.5" doesn't match because `1` is
    // followed by `.5` which the regex sees as 1.5 — that IS captured
    // (1.5) but rejected by the [0,1] gate. "2.0" doesn't match the
    // regex pattern.
    expect(extractSelectionConfidence('conf=1.5 — weird')).toBeUndefined();
  });
});
