/**
 * Synthesizer unit tests.
 *
 * Pins the cold-path contract synthesizer's behavior:
 *   - empty intent short-circuits without an LLM call
 *   - provider lacking callStructured collapses to null
 *   - LLM throw / parse-fail collapses to null with a diagnostic reason
 *   - well-formed tool input → valid DataContract with the inferred specs
 *   - actionSpec entries are normalized to payload-less object schemas
 *     (matches what the validator expects on every action)
 *   - contextSpec entries pass schema + default through
 */
import { describe, it, expect } from 'vitest';
import { dataContractSchema, type DataContract } from '@ggui-ai/protocol';
import type { LLMCaller, ToolSchema } from './llm-caller.js';
import { synthesizeContract, SYNTHESIZE_TOOL } from './synthesize-contract.js';

interface Captured {
  system: string;
  user: string;
  tool: ToolSchema;
}

function captureLlm(
  ret: unknown | (() => unknown) | (() => Promise<unknown>),
  capture?: Captured[],
): LLMCaller {
  return {
    async call() {
      throw new Error('text-mode not used by synthesizer');
    },
    async callStructured<T>(
      system: string,
      user: string,
      tool: ToolSchema,
    ): Promise<T> {
      capture?.push({ system, user, tool });
      const value = typeof ret === 'function' ? await (ret as () => unknown)() : ret;
      return value as T;
    },
  };
}

function llmWithoutStructured(): LLMCaller {
  return {
    async call() {
      return '';
    },
  };
}

describe('synthesizeContract — short-circuit cases', () => {
  it('returns null on empty intent without an LLM call', async () => {
    const calls: Captured[] = [];
    const result = await synthesizeContract({ llm: captureLlm({}, calls) }, '');
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/empty intent/);
    expect(calls).toHaveLength(0);
  });

  it('returns null on whitespace-only intent', async () => {
    const calls: Captured[] = [];
    const result = await synthesizeContract({ llm: captureLlm({}, calls) }, '   \t\n');
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/empty intent/);
    expect(calls).toHaveLength(0);
  });

  it('returns null when provider does not support callStructured', async () => {
    const result = await synthesizeContract(
      { llm: llmWithoutStructured() },
      'a counter widget',
    );
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/does not support callStructured/);
  });
});

describe('synthesizeContract — LLM error paths', () => {
  it('collapses LLM throw to null with diagnostic reason', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm(() => {
          throw new Error('429 rate limited');
        }),
      },
      'a counter widget',
    );
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/synthesize-fail.*429/);
  });

  it('collapses non-object tool input to null', async () => {
    const result = await synthesizeContract(
      { llm: captureLlm('not an object') },
      'a counter widget',
    );
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/did not match expected shape/);
  });

  it('non-object reason still parses (reason is the only required field)', async () => {
    // The synthesizer no longer requires an `interaction` field; only
    // `reason` is required by the tool schema. A bare reason produces
    // an empty contract — the LLM declined to declare any specs.
    const result = await synthesizeContract(
      { llm: captureLlm({ reason: 'no specs needed' }) },
      'a counter widget',
    );
    expect(result.contract).toEqual({});
    expect(result.reason).toMatch(/synthesize-ok/);
  });
});

describe('synthesizeContract — happy path', () => {
  it('emits an empty contract when no specs were inferred', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          reason: 'static weather card, no actions',
        }),
      },
      'a weather card for Tokyo',
    );
    expect(result.contract).toEqual({});
    expect(result.reason).toMatch(/synthesize-ok/);
  });

  it('builds actionSpec entries with payload-less schemas', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            increment: { label: 'Increment the counter' },
            reset: { label: 'Reset to zero' },
          },
          reason: 'counter widget needs increment + reset',
        }),
      },
      'a counter widget',
    );
    expect(result.contract).toEqual({
      actionSpec: {
        increment: {
          label: 'Increment the counter',
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
          // Dispatch default — synth-emitted actions inherit
          // `` so the wire schema accepts
          // them on confirm. Agent overriding via a refined contract
          // can replace dispatch with `{ kind: 'tool', tool: '...' }`
          // for same-server dispatch or add `intendedTool`.
        },
        reset: {
          label: 'Reset to zero',
          schema: {
            type: 'object',
            properties: {},
            additionalProperties: false,
          },
        },
      },
    });
  });

  it('preserves LLM-supplied action payload schemas (Bug 1 fix — chip-style actions)', async () => {
    // The pre-fix synthesizer always overrode entry.schema with a
    // payload-less default, even when the intent + LLM correctly
    // declared a payload (e.g. "chip text" for a sendChipPrompt
    // action). Pin the new behavior: when the LLM supplies a
    // schema with non-empty properties, it MUST flow through
    // verbatim into the synthesized contract.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            sendChipPrompt: {
              label: 'Send chip prompt',
              schema: {
                type: 'object',
                properties: {
                  chipText: { type: 'string' },
                },
                required: ['chipText'],
              },
            },
            // Mix in a payload-less action — should still get the
            // default empty schema.
            cancel: { label: 'Cancel' },
          },
          reason: 'chip widget needs sendChipPrompt with chipText payload',
        }),
      },
      'a chip widget where chips send their text when tapped',
    );
    expect(result.contract?.actionSpec?.['sendChipPrompt']).toEqual({
      label: 'Send chip prompt',
      schema: {
        type: 'object',
        properties: { chipText: { type: 'string' } },
        required: ['chipText'],
      },
    });
    // Payload-less action still gets the empty-object fallback.
    expect(result.contract?.actionSpec?.['cancel']).toEqual({
      label: 'Cancel',
      schema: {
        type: 'object',
        properties: {},
        additionalProperties: false,
      },
    });
  });

  it('falls back to empty payload schema when LLM supplies a non-object schema', async () => {
    // Defensive: an LLM that returns garbage under `schema` (string,
    // array, null) should fall back to the payload-less default
    // rather than letting the garbage flow through.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            increment: {
              label: 'Increment',
              // Bad: "object" but actually a string
              schema: 'not-an-object',
            },
          },
          reason: 'edge case',
        }),
      },
      'a counter',
    );
    expect(result.contract?.actionSpec?.['increment']?.schema).toEqual({
      type: 'object',
      properties: {},
      additionalProperties: false,
    });
  });

  it('passes contextSpec schema + default through', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          contextSpec: {
            count: {
              schema: { type: 'number' },
              default: 0,
            },
            label: {
              schema: { type: 'string' },
              default: 'Counter',
            },
          },
          reason: 'counter has count + label state',
        }),
      },
      'a labeled counter',
    );
    expect(result.contract?.contextSpec).toEqual({
      count: { schema: { type: 'number' }, default: 0 },
      label: { schema: { type: 'string' }, default: 'Counter' },
    });
  });

  it('combines action + context specs in one contract', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            submit: { label: 'Submit the form' },
          },
          contextSpec: {
            draft: { schema: { type: 'string' }, default: '' },
          },
          reason: 'form widget',
        }),
      },
      'a feedback form',
    );
    expect(result.contract?.actionSpec?.['submit']).toBeDefined();
    expect(result.contract?.contextSpec?.['draft']).toBeDefined();
  });

  it('passes the intent verbatim into the user message', async () => {
    const calls: Captured[] = [];
    await synthesizeContract(
      {
        llm: captureLlm(
          { reason: '' },
          calls,
        ),
      },
      '   a notepad widget   ',
    );
    expect(calls).toHaveLength(1);
    // Trimmed before the call.
    expect(calls[0]?.user).toBe('INTENT: a notepad widget');
    expect(calls[0]?.system).toMatch(/contract inferrer/);
    expect(calls[0]?.tool.name).toBe('submit_inferred_contract');
  });
});

describe('synthesizeContract — streamSpec (broadcast/converse UIs)', () => {
  it('builds streamSpec entries when LLM declares live channels', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          streamSpec: {
            messages: {
              schema: {
                type: 'object',
                properties: {
                  role: { type: 'string' },
                  text: { type: 'string' },
                },
              },
            },
            ticker: {
              schema: { type: 'number' },
            },
          },
          reason: 'live chat with messages + a ticker',
        }),
      },
      'a chat with the agent showing live messages and a counter ticker',
    );
    expect(result.contract?.streamSpec).toEqual({
      messages: {
        schema: {
          type: 'object',
          properties: {
            role: { type: 'string' },
            text: { type: 'string' },
          },
        },
      },
      ticker: { schema: { type: 'number' } },
    });
  });

  it('skips streamSpec entries with missing/null schema', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          streamSpec: {
            good: { schema: { type: 'object' } },
            // LLM emits an entry without a schema — would break runtime
            // delivery validation. Defensive synth drops it.
            bad: { schema: null },
          },
          reason: 'edge case',
        }),
      },
      'a stream',
    );
    expect(result.contract?.streamSpec).toEqual({
      good: { schema: { type: 'object' } },
    });
  });

  it('omits streamSpec when LLM emits an empty map', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          streamSpec: {},
          reason: 'no streams needed',
        }),
      },
      'a form',
    );
    expect(result.contract?.streamSpec).toBeUndefined();
  });
});

describe('synthesizeContract — propsSpec (static-display UIs)', () => {
  it('builds propsSpec.properties entries with required flag preserved', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          propsSpec: {
            properties: {
              city: { schema: { type: 'string' }, required: true },
              temp: { schema: { type: 'number' }, required: true },
              icon: { schema: { type: 'string' } },
            },
          },
          reason: 'weather card needs city + temp; icon optional',
        }),
      },
      'a weather card for Tokyo with temperature and an icon',
    );
    expect(result.contract?.propsSpec?.properties).toEqual({
      city: { schema: { type: 'string' }, required: true },
      temp: { schema: { type: 'number' }, required: true },
      // optional prop — required flag NOT emitted (avoids the noise
      // `required: false` on entries that were never required)
      icon: { schema: { type: 'string' } },
    });
  });

  it('handles flattened propsSpec variant — LLM omitting the wrapper', async () => {
    // LLMs sometimes return the inner properties directly under
    // `propsSpec` instead of `propsSpec.properties`. parseToolInput's
    // defensive check rejects that shape and the contract just lacks
    // propsSpec.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          // Wrong shape — flat instead of wrapped
          propsSpec: {
            city: { schema: { type: 'string' } },
          },
          reason: 'malformed shape',
        }),
      },
      'a weather card',
    );
    // Wrapper missing → propsSpec dropped
    expect(result.contract?.propsSpec).toBeUndefined();
  });

  it('omits propsSpec when properties map is empty', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          propsSpec: { properties: {} },
          reason: 'no static props',
        }),
      },
      'a counter',
    );
    expect(result.contract?.propsSpec).toBeUndefined();
  });
});

describe('synthesizeContract — gadget refs (package-keyed clientCapabilities)', () => {
  it('builds a package-keyed clientCapabilities.gadgets map for a hook gadget', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          contextSpec: {
            location: { schema: { type: 'object' }, default: {} },
          },
          clientCapabilities: {
            gadgets: { '@ggui-ai/gadgets': { useGeolocation: {} } },
          },
          reason: 'map needs the device location capability',
        }),
      },
      'show my current location on a map',
    );
    expect(result.contract).not.toBeNull();
    expect(result.contract?.clientCapabilities?.gadgets).toEqual({
      '@ggui-ai/gadgets': { useGeolocation: {} },
    });
    expect(result.reason).toMatch(/synthesize-ok/);
  });

  it('builds a package-keyed map for a COMPONENT gadget (PascalCase export)', async () => {
    // The export-name grammar — PascalCase — is the kind discriminator;
    // there is no `component` field on the wire. A component-gadget
    // contract must round-trip through buildContract + schema
    // validation just like a hook one.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          propsSpec: {
            properties: {
              revenue: { schema: { type: 'array' }, required: true },
            },
          },
          clientCapabilities: {
            gadgets: {
              '@acme/charts': {
                RevenueChart: { usage: 'Render the quarterly revenue series.' },
              },
            },
          },
          reason: 'revenue chart is a registered component gadget',
        }),
      },
      'show last quarter revenue as a bar chart',
    );
    expect(result.contract).not.toBeNull();
    expect(result.contract?.clientCapabilities?.gadgets).toEqual({
      '@acme/charts': {
        RevenueChart: { usage: 'Render the quarterly revenue series.' },
      },
    });
    expect(result.reason).toMatch(/synthesize-ok/);
  });

  it('drops gadget export entries that are not objects', async () => {
    // Defensive: an LLM that emits garbage under an export key (string,
    // array, null) should have that entry skipped rather than letting
    // it flow into the contract.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          clientCapabilities: {
            gadgets: {
              '@ggui-ai/gadgets': {
                useGeolocation: {},
                // Garbage value under an export key — the mock LLM
                // return is typed `unknown`, so no cast is needed to
                // feed buildContract a structurally-invalid entry.
                useCamera: 'not-an-object',
              },
            },
          },
          reason: 'one good ref, one garbage ref',
        }),
      },
      'a capability widget',
    );
    expect(result.contract?.clientCapabilities?.gadgets).toEqual({
      '@ggui-ai/gadgets': { useGeolocation: {} },
    });
  });
});

describe('synthesizeContract — schema validation gate', () => {
  it('rejects contracts that fail dataContractSchema.safeParse', async () => {
    // LLM emits a malformed actionSpec entry — label is a number,
    // not a string. The loose tool input_schema doesn't catch it
    // (additionalProperties is permissive), but the canonical schema
    // does. Synth must collapse to null rather than letting garbage
    // flow through to the registry.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            // label MUST be a string per ActionEntry; LLM violated.
            // (Cast through unknown so the test compiles even though
            // the captured value is structurally invalid at runtime.)
            broken: { label: 12345 as unknown as string },
          },
          reason: 'bad shape',
        }),
      },
      'a broken contract',
    );
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/synthesize-fail.*schema validation/);
  });

  it('passes contracts that satisfy dataContractSchema', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            submit: {
              label: 'Submit',
              schema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
          contextSpec: {
            draft: { schema: { type: 'string' }, default: '' },
          },
          reason: 'a form',
        }),
      },
      'a form with a submit',
    );
    expect(result.contract).not.toBeNull();
    expect(result.contract?.actionSpec?.['submit']?.label).toBe('Submit');
    expect(result.reason).toMatch(/synthesize-ok/);
  });
});

describe('synthesizeContract — tool-schema ↔ DataContract field coverage', () => {
  // Every property the synth tool schema exposes maps to one
  // DataContract spec. A parser that reads the wrong key silently
  // drops the spec — green unit tests, broken production: the
  // `props` vs `propsSpec` key mismatch did exactly that for every
  // static-display contract, and `streamSpec.source` was dropped the
  // same way. Each case mocks the LLM filling one tool field, then
  // asserts the synthesized contract surfaces the matching spec AND
  // validates as a protocol DataContract.
  const fieldCases: ReadonlyArray<{
    readonly toolField: string;
    readonly mock: Record<string, unknown>;
    readonly surfaces: (c: DataContract) => unknown;
  }> = [
    {
      toolField: 'actionSpec',
      mock: {
        actionSpec: {
          submit: {
            label: 'Submit',
            schema: {
              type: 'object',
              properties: {},
              additionalProperties: false,
            },
          },
        },
      },
      surfaces: (c) => c.actionSpec?.['submit'],
    },
    {
      toolField: 'contextSpec',
      mock: { contextSpec: { count: { schema: { type: 'number' }, default: 0 } } },
      surfaces: (c) => c.contextSpec?.['count'],
    },
    {
      toolField: 'streamSpec',
      mock: { streamSpec: { ticks: { schema: { type: 'object' } } } },
      surfaces: (c) => c.streamSpec?.['ticks'],
    },
    {
      toolField: 'propsSpec',
      mock: {
        propsSpec: {
          properties: { city: { schema: { type: 'string' }, required: true } },
        },
      },
      surfaces: (c) => c.propsSpec?.properties?.['city'],
    },
    {
      toolField: 'clientCapabilities',
      mock: {
        contextSpec: { location: { schema: { type: 'object' }, default: {} } },
        clientCapabilities: {
          gadgets: { '@ggui-ai/gadgets': { useGeolocation: {} } },
        },
      },
      surfaces: (c) => c.clientCapabilities?.gadgets?.['@ggui-ai/gadgets'],
    },
    {
      toolField: 'agentCapabilities',
      // Self-consistent source-fed stream — the streamSpec source
      // references the agentCapabilities catalog entry, so no
      // dangling reference and `streamSpec.source` round-trips too.
      mock: {
        streamSpec: {
          ticker: {
            schema: {
              type: 'object',
              properties: { price: { type: 'number' } },
            },
            source: { tool: 'fetch_quote' },
          },
        },
        agentCapabilities: {
          tools: {
            fetch_quote: {
              inputSchema: { type: 'object' },
              outputSchema: {
                type: 'object',
                properties: { price: { type: 'number' } },
                required: ['price'],
              },
              usage: 'Fetches the latest quote for a symbol.',
            },
          },
        },
      },
      surfaces: (c) => c.agentCapabilities?.tools?.['fetch_quote'],
    },
  ];

  it('has a coverage case for every contract-bearing tool-schema property', () => {
    // Drift guard — a new tool field added without a round-trip case
    // (the failure mode that hid the dropped propsSpec) fails here.
    const toolProps = Object.keys(
      SYNTHESIZE_TOOL.input_schema['properties'] as Record<string, unknown>,
    ).filter((k) => k !== 'reason');
    expect(toolProps.sort()).toEqual(
      fieldCases.map((fc) => fc.toolField).sort(),
    );
  });

  for (const fc of fieldCases) {
    it(`surfaces ${fc.toolField} from the tool output into a valid DataContract`, async () => {
      const result = await synthesizeContract(
        {
          llm: captureLlm({ ...fc.mock, reason: `${fc.toolField} round-trip` }),
        },
        `an intent exercising ${fc.toolField}`,
      );
      expect(
        result.contract,
        `${fc.toolField}: synth collapsed the contract to null`,
      ).not.toBeNull();
      expect(
        fc.surfaces(result.contract as DataContract),
        `${fc.toolField}: not surfaced in the contract — parser likely reads the wrong key`,
      ).toBeDefined();
      // The synthesized output MUST be a valid protocol DataContract.
      const parsed = dataContractSchema.safeParse(result.contract);
      expect(
        parsed.success,
        `${fc.toolField}: synthesized contract failed dataContractSchema`,
      ).toBe(true);
    });
  }

  it('round-trips streamSpec.source onto the channel (wired source-fed stream)', () => {
    return synthesizeContract(
      {
        llm: captureLlm({
          streamSpec: {
            ticker: {
              schema: { type: 'object' },
              source: { tool: 'fetch_quote', args: { symbol: 'AAPL' } },
            },
          },
          agentCapabilities: {
            tools: {
              fetch_quote: {
                outputSchema: { type: 'object' },
                usage: 'Fetches a quote.',
              },
            },
          },
          reason: 'a live AAPL ticker',
        }),
      },
      'a live-refreshing AAPL quote',
    ).then((result) => {
      // `source` is the wire that binds the channel to the polling
      // tool — dropping it silently de-wires the source-fed stream.
      expect(result.contract?.streamSpec?.['ticker']?.source?.tool).toBe(
        'fetch_quote',
      );
    });
  });
});

describe('synthesizeContract — programmatic validator wiring', () => {
  it('prunes redundant mutator-actions from an over-specified counter contract', async () => {
    // The LLM over-specifies: actionSpec.increment / reset (empty
    // payload) alongside contextSpec.count. By the actions-vs-context
    // placement rule those are not actions — the slot setter IS the
    // wire. The synthesizer prunes them deterministically, so the
    // contract comes back contextSpec-only.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            increment: { label: 'Increment' },
            reset: { label: 'Reset' },
          },
          contextSpec: {
            count: { schema: { type: 'number' }, default: 0 },
          },
          reason: 'counter widget',
        }),
      },
      'a counter widget',
    );
    expect(result.contract).not.toBeNull();
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.contract).toEqual({
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
    });
  });

  it('does not mention validator when contract has no findings', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            submit: {
              label: 'Submit',
              schema: {
                type: 'object',
                properties: { value: { type: 'string' } },
                required: ['value'],
              },
            },
          },
          contextSpec: {
            formData: { schema: { type: 'object' }, default: {} },
          },
          reason: 'form',
        }),
      },
      'a form',
    );
    expect(result.contract).not.toBeNull();
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.reason).not.toMatch(/validator/);
  });
});

// Phase 5.4 — exercise validateActionsVsContext findings end-to-end
// through the synth pipeline. Each placement-rule kind must surface on
// `result.reason` for operator visibility, but `result.contract` MUST
// stay non-null because findings are warning-only (loose validator;
// operators can investigate without traffic loss).
describe('synthesizeContract — placement validator findings (Slice KK)', () => {
  it('drops the contract when a name collides across actionSpec + contextSpec (CTR_DUP_NAME, post-HH)', async () => {
    // Post-HH (2026-05-11) the protocol-level linter promotes this to a
    // hard error: the boilerplate generator emits identifiers from
    // these keys, and `actionSpec.count` + `contextSpec.count` would
    // shadow each other in the generated source. Synth drops the
    // contract and falls back to the legacy stub; the placement
    // heuristic's `actions-vs-context-name-collision` warning is still
    // emitted in the reason, alongside the linter's `CTR_DUP_NAME`
    // error. Agent retries on the next handshake with non-colliding
    // names.
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            count: { label: 'Count' },
          },
          contextSpec: {
            count: { schema: { type: 'number' }, default: 0 },
          },
          reason: 'collision case',
        }),
      },
      'a stepper',
    );
    expect(result.contract).toBeNull();
    expect(result.reason).toMatch(/synthesize-fail-validator/);
    expect(result.reason).toMatch(/CTR_DUP_NAME/);
    expect(result.reason).toMatch(/count/);
  });

  it('surfaces action-name-looks-state-y when actionSpec name matches a state-mirror pattern', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            // 'autosave' is state-mirror-shaped (continuous, not a
            // turn-driving event). Validator suggests contextSpec.
            autosave: {
              label: 'Auto-save',
              schema: {
                type: 'object',
                properties: { draft: { type: 'string' } },
                required: ['draft'],
              },
            },
          },
          reason: 'autosave-as-action case',
        }),
      },
      'a draft editor',
    );
    expect(result.contract).not.toBeNull();
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.reason).toMatch(/validator/);
    expect(result.reason).toMatch(/action-name-looks-state-y/);
    expect(result.reason).toMatch(/autosave/);
  });

  it('surfaces context-name-looks-action-y when contextSpec name matches a discrete-event pattern', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            // Need at least one action so the result has a turn-driver.
            type: { label: 'Type' },
          },
          contextSpec: {
            // 'submit' is a discrete event — should be in actionSpec.
            submit: { schema: { type: 'string' }, default: 'idle' },
          },
          reason: 'submit-as-context case',
        }),
      },
      'a quick form',
    );
    expect(result.contract).not.toBeNull();
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.reason).toMatch(/validator/);
    expect(result.reason).toMatch(/context-name-looks-action-y/);
    expect(result.reason).toMatch(/submit/);
  });

  it('emits multiple placement findings when the contract has compound issues', async () => {
    const result = await synthesizeContract(
      {
        llm: captureLlm({
          actionSpec: {
            // state-y action name
            draft: { label: 'Draft' },
            // legitimate action
            send: {
              label: 'Send',
              schema: {
                type: 'object',
                properties: { body: { type: 'string' } },
                required: ['body'],
              },
            },
          },
          contextSpec: {
            // action-y context name
            confirm: { schema: { type: 'boolean' }, default: false },
          },
          reason: 'compound case',
        }),
      },
      'a chat composer',
    );
    expect(result.contract).not.toBeNull();
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.reason).toMatch(/action-name-looks-state-y/);
    expect(result.reason).toMatch(/context-name-looks-action-y/);
  });
});

describe('synthesizeContract — schema-type normalizer (inline repair)', () => {
  it('fixes an invalid type:"enum" schema with no retry', async () => {
    const calls: Captured[] = [];
    const result = await synthesizeContract(
      {
        llm: captureLlm(
          {
            contextSpec: {
              gameStatus: {
                schema: { type: 'enum', enum: ['waiting', 'playing', 'done'] },
                default: 'waiting',
              },
            },
            reason: 'quiz lifecycle slot',
          },
          calls,
        ),
      },
      'a multiplayer quiz',
    );
    expect(result.contract).not.toBeNull();
    // Normalizer ran inside buildContract → the gate saw a valid type.
    expect(result.contract).toMatchObject({
      contextSpec: {
        gameStatus: {
          schema: { type: 'string', enum: ['waiting', 'playing', 'done'] },
        },
      },
    });
    // Deterministic fix — no repair retry.
    expect(calls).toHaveLength(1);
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(result.reason).not.toMatch(/repaired/);
  });
});

describe('synthesizeContract — validate-and-repair loop', () => {
  it('repairs a gate failure on the second attempt and notes it', async () => {
    let n = 0;
    const calls: Captured[] = [];
    const result = await synthesizeContract(
      {
        llm: captureLlm(() => {
          n++;
          // Attempt 1: actionSpec entry with no label → fails the
          // schema gate (label is required); the type-only normalizer
          // cannot fix a missing field.
          return n === 1
            ? { actionSpec: { save: {} }, reason: 'attempt 1' }
            : { actionSpec: { save: { label: 'Save' } }, reason: 'attempt 2' };
        }, calls),
      },
      'a notepad',
    );
    expect(result.contract).not.toBeNull();
    expect(result.contract).toMatchObject({
      actionSpec: { save: { label: 'Save' } },
    });
    expect(calls).toHaveLength(2);
    expect(result.reason).toMatch(/repaired on attempt 2/);
    // The retry carries the rejected contract + failure reason back.
    expect(calls[1]!.user).toMatch(/YOUR PREVIOUS ATTEMPT/);
    expect(calls[1]!.user).toMatch(/Reason —/);
  });

  it('declines after exhausting the attempt budget', async () => {
    const calls: Captured[] = [];
    const result = await synthesizeContract(
      {
        llm: captureLlm({ actionSpec: { save: {} }, reason: 'bad' }, calls),
      },
      'a notepad',
    );
    expect(result.contract).toBeNull();
    expect(calls).toHaveLength(5);
    expect(result.reason).toMatch(/synthesize-fail/);
  });

  it('retries the same prompt on a transient callStructured throw', async () => {
    let n = 0;
    const calls: Captured[] = [];
    const result = await synthesizeContract(
      {
        llm: captureLlm(() => {
          n++;
          if (n === 1) throw new Error('fetch failed');
          return { reason: 'recovered after network blip' };
        }, calls),
      },
      'a weather card',
    );
    expect(result.contract).toEqual({});
    expect(result.reason).toMatch(/synthesize-ok/);
    expect(calls).toHaveLength(2);
    // No repair note on a network retry — the prompt is unchanged.
    expect(calls[0]!.user).toBe(calls[1]!.user);
  });
});
