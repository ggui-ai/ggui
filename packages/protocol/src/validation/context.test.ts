/**
 * contextSpec coverage.
 *
 * `ContextSpec` is a flat `Record<slotKey, ContextEntry>`
 * declaring observable client state the LLM context consumes. This
 * file tests two layers:
 *
 *   1. Push-time structural validation via `validateContractStructure`
 *      — rejects malformed contextSpec declarations.
 *   2. Runtime data validation via `validateContextData`
 *      — gates Provider values before posting to the LLM context.
 *
 * The iframe-runtime observer wires `validateContextData` for runtime
 * gating; this validator covers the schema-side contract.
 *
 * See the design-lock block in `data-contract.ts` for the invariants
 * these tests encode.
 */
import { describe, it, expect } from 'vitest';
import {
  validateContractStructure,
  validateContextData,
} from './contract-validator.js';
import {
  DEFAULT_CONTEXT_DEBOUNCE_MS,
  deriveContextDefault,
  type ContextEntry,
  type DataContract,
  type ContextSpec,
} from '../types/data-contract.js';

// ── Fixtures ────────────────────────────────────────────────────────

const WELL_FORMED_SPEC: ContextSpec = {
  currentStep: {
    description: 'wizard step index',
    schema: { type: 'number' },
    default: 0,
  },
  draft: {
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        body: { type: 'string' },
      },
    },
  },
  tab: {
    schema: { type: 'string' },
    debounceMs: 0,
  },
  hoverItem: {
    schema: { type: 'string' },
    debounceMs: 500,
  },
};

// `intent` is retired from `DataContract`. The base fixture is empty
// now; tests spread it for shape symmetry.
const BASE_CONTRACT_FIELDS: Partial<DataContract> = {};

// ── Locked defaults ─────────────────────────────────────────────────

describe('contextSpec — locked defaults', () => {
  it('exports DEFAULT_CONTEXT_DEBOUNCE_MS = 300', () => {
    expect(DEFAULT_CONTEXT_DEBOUNCE_MS).toBe(300);
  });
});

// ── Structural validation — happy path ──────────────────────────────

describe('validateContractStructure — contextSpec happy path', () => {
  it('accepts a well-formed contextSpec contract', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: WELL_FORMED_SPEC,
    });
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('accepts a contract WITHOUT contextSpec (back-compat)', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a contract with empty contextSpec map', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {},
    });
    expect(result.valid).toBe(true);
  });

  it('accepts debounceMs = 0 (immediate)', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        tab: { schema: { type: 'string' }, debounceMs: 0 },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts entries without debounceMs (runtime applies default)', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        tab: { schema: { type: 'string' } },
      },
    });
    expect(result.valid).toBe(true);
  });
});

// ── Structural validation — slot key rejections ─────────────────────

describe('validateContractStructure — contextSpec slot keys', () => {
  it('rejects a number-prefixed key', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        '1step': { schema: { type: 'number' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'contextSpec.1step',
      received: '1step',
    });
    expect(result.violations[0].message).toContain('not a valid JS identifier');
  });

  it('rejects a hyphenated key', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        'current-step': { schema: { type: 'number' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.current-step');
  });

  it('rejects a key with spaces', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        'current step': { schema: { type: 'number' } },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.current step');
  });

  it('rejects empty-string key', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        '': { schema: { type: 'number' } },
      },
    });
    expect(result.valid).toBe(false);
  });

  it('rejects __proto__ as a slot key', () => {
    // `Object.entries(spec)` skips `__proto__` when assigned via
    // object literal in modern engines — exercise the rejection path
    // by setting it explicitly to ensure the validator handles the
    // case if it ever leaks through.
    const spec: ContextSpec = {};
    Object.defineProperty(spec, '__proto__', {
      value: { schema: { type: 'number' } },
      enumerable: true,
      configurable: true,
    });
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: spec,
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.__proto__');
    expect(result.violations[0].message).toContain('reserved');
  });

  it('rejects constructor as a slot key', () => {
    // `constructor` collides with Object.prototype.constructor when
    // typed against the ContextSpec literal — build via a fresh
    // object so the validator sees the user-declared shape.
    const spec: ContextSpec = {};
    spec['constructor'] = { schema: { type: 'number' } };
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: spec,
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.constructor');
    expect(result.violations[0].message).toContain('reserved');
  });

  it('rejects prototype as a slot key', () => {
    const spec: ContextSpec = {};
    spec['prototype'] = { schema: { type: 'number' } };
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: spec,
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.prototype');
  });
});

// ── Structural validation — schema rejections ───────────────────────

describe('validateContractStructure — contextSpec schemas', () => {
  it('rejects a slot missing a schema', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      // intentional shape error — exercises the validator
      contextSpec: {
        bad: {} as ContextSpec[string],
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.bad');
    expect(result.violations[0].message).toContain('no schema');
  });

  it('rejects a slot with a structurally invalid schema (no type / oneOf / anyOf)', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        bad: {
          // schema with no type / oneOf / anyOf — same rule as
          // actionSpec / streamSpec / props.
          schema: { description: 'shapeless' },
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.bad');
  });

  it('rejects a slot whose default does not match its schema', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        currentStep: {
          schema: { type: 'number' },
          default: 'zero', // string default for number schema
        },
      },
    });
    expect(result.valid).toBe(false);
    const violation = result.violations.find(
      v => v.field === 'contextSpec.currentStep.default',
    );
    expect(violation).toBeDefined();
    expect(violation?.expected).toBe('number');
    expect(violation?.received).toBe('string');
  });

  it('accepts a slot whose default matches its schema', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        currentStep: { schema: { type: 'number' }, default: 0 },
      },
    });
    expect(result.valid).toBe(true);
  });
});

// ── Structural validation — debounceMs rejections ───────────────────

describe('validateContractStructure — contextSpec debounceMs', () => {
  it('rejects a negative debounceMs', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        tab: { schema: { type: 'string' }, debounceMs: -1 },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.tab.debounceMs');
    expect(result.violations[0].message).toContain('non-negative integer');
  });

  it('rejects a non-integer debounceMs', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        tab: { schema: { type: 'string' }, debounceMs: 100.5 },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.tab.debounceMs');
  });

  it('rejects a non-numeric debounceMs', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        // Field is typed `number?`; coerce through `unknown` to
        // exercise the runtime guard against wire-shaped values that
        // bypass TS at the boundary.
        tab: {
          schema: { type: 'string' },
          debounceMs: 'fast' as unknown as number,
        },
      },
    });
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('contextSpec.tab.debounceMs');
  });
});

// ── Round-trip / serialization ──────────────────────────────────────

describe('contextSpec — JSON round-trip', () => {
  it('round-trips a DataContract with contextSpec through JSON', () => {
    const original: DataContract = {
      contextSpec: WELL_FORMED_SPEC,
    };
    const restored = JSON.parse(JSON.stringify(original)) as DataContract;
    expect(restored.contextSpec).toEqual(WELL_FORMED_SPEC);
    expect(validateContractStructure(restored).valid).toBe(true);
  });
});

// ── Runtime data validator ──────────────────────────────────────────

describe('validateContextData', () => {
  it('passes when slot is declared and value matches schema', () => {
    const result = validateContextData(
      'currentStep',
      3,
      WELL_FORMED_SPEC,
    );
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('passes for object value matching declared schema', () => {
    const result = validateContextData(
      'draft',
      { title: 'hi', body: 'there' },
      WELL_FORMED_SPEC,
    );
    expect(result.valid).toBe(true);
  });

  it('rejects an undeclared slot name', () => {
    const result = validateContextData(
      'undeclaredSlot',
      'whatever',
      WELL_FORMED_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'contextSpec',
      received: 'undeclaredSlot',
    });
    expect(result.violations[0].message).toContain('Unknown context slot');
  });

  it('reports the empty-spec case distinctly', () => {
    const empty: ContextSpec = {};
    const result = validateContextData('anything', 0, empty);
    expect(result.valid).toBe(false);
    expect(result.violations[0].message).toContain('(none)');
  });

  it('rejects a value that violates the slot schema', () => {
    const result = validateContextData(
      'currentStep',
      'not-a-number',
      WELL_FORMED_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'currentStep.value',
      expected: 'number',
      received: 'string',
    });
  });

  it('skips schema check when value is undefined (no-op)', () => {
    const result = validateContextData(
      'currentStep',
      undefined,
      WELL_FORMED_SPEC,
    );
    expect(result.valid).toBe(true);
  });
});

// ── deriveContextDefault helper ─────────────────────────────────────

describe('deriveContextDefault', () => {
  it('returns entry.default when explicitly set', () => {
    const entry: ContextEntry = { schema: { type: 'number' }, default: 42 };
    expect(deriveContextDefault(entry)).toBe(42);
  });

  it('respects an explicit default of 0 (falsy but defined)', () => {
    const entry: ContextEntry = { schema: { type: 'number' }, default: 0 };
    expect(deriveContextDefault(entry)).toBe(0);
  });

  it('respects an explicit default of empty string', () => {
    const entry: ContextEntry = { schema: { type: 'string' }, default: '' };
    expect(deriveContextDefault(entry)).toBe('');
  });

  it('respects an explicit default of false', () => {
    const entry: ContextEntry = { schema: { type: 'boolean' }, default: false };
    expect(deriveContextDefault(entry)).toBe(false);
  });

  it('falls back to "" for type:string', () => {
    expect(deriveContextDefault({ schema: { type: 'string' } })).toBe('');
  });

  it('falls back to 0 for type:number', () => {
    expect(deriveContextDefault({ schema: { type: 'number' } })).toBe(0);
  });

  it('falls back to 0 for type:integer', () => {
    expect(deriveContextDefault({ schema: { type: 'integer' } })).toBe(0);
  });

  it('falls back to false for type:boolean', () => {
    expect(deriveContextDefault({ schema: { type: 'boolean' } })).toBe(false);
  });

  it('falls back to [] for type:array', () => {
    expect(deriveContextDefault({ schema: { type: 'array', items: { type: 'string' } } }))
      .toEqual([]);
  });

  it('falls back to {} for type:object', () => {
    expect(deriveContextDefault({ schema: { type: 'object' } })).toEqual({});
  });

  it('falls back to null for type:null', () => {
    expect(deriveContextDefault({ schema: { type: 'null' } })).toBe(null);
  });

  it('returns undefined for a oneOf-only schema (no primitive type)', () => {
    const entry: ContextEntry = {
      schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
    };
    expect(deriveContextDefault(entry)).toBeUndefined();
  });

  it('returns undefined for a fully empty schema', () => {
    const entry: ContextEntry = { schema: {} };
    expect(deriveContextDefault(entry)).toBeUndefined();
  });
});

// ── slot/prop name collision ────────────────────────────────────────

describe('validateContractStructure — contextSpec / props collision', () => {
  it('rejects when a slot key matches a props.properties key', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      propsSpec: {
        properties: {
          foo: { schema: { type: 'string' } },
        },
      },
      contextSpec: {
        foo: { schema: { type: 'string' } },
      },
    });
    expect(result.valid).toBe(false);
    const violation = result.violations.find(
      v => v.field === 'contextSpec.foo',
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain("collides with propsSpec.properties.foo");
    expect(violation?.message).toContain('shadow');
  });

  it('accepts a slot whose key does not match any prop key', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      propsSpec: {
        properties: {
          bar: { schema: { type: 'string' } },
        },
      },
      contextSpec: {
        foo: { schema: { type: 'string' } },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts contextSpec when contract.propsSpec is absent', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        foo: { schema: { type: 'string' } },
      },
    });
    expect(result.valid).toBe(true);
  });
});

// ── default-derivability rule ───────────────────────────────────────

describe('validateContractStructure — contextSpec default-derivability', () => {
  it('accepts a slot with a primitive schema (default derived)', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        currentStep: { schema: { type: 'number' } },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('accepts a slot with explicit default + complex schema', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        mode: {
          schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
          default: 'idle',
        },
      },
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a slot whose schema has only oneOf and no explicit default', () => {
    const result = validateContractStructure({
      ...BASE_CONTRACT_FIELDS,
      contextSpec: {
        mode: {
          schema: { oneOf: [{ type: 'string' }, { type: 'number' }] },
        },
      },
    });
    expect(result.valid).toBe(false);
    const violation = result.violations.find(
      v =>
        v.field === 'contextSpec.mode' &&
        v.message.includes('no derivable default'),
    );
    expect(violation).toBeDefined();
    expect(violation?.message).toContain('explicitly set entry.default');
  });
});
