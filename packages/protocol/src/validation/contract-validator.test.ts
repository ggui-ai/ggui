import { describe, it, expect } from 'vitest';
import {
  validateActionData,
  validatePropsData,
  buildPropsWrapperSchema,
  compileContractValidators,
  bundleCompiledValidatorsAsModule,
  computeContractBundle,
  ContractViolationError,
} from './contract-validator.js';
import { compileForValidation } from './ajv-runtime.js';
import type {
  ActionSpec,
  ContextSpec,
  PropsSpec,
  StreamSpec,
} from '../types/data-contract.js';

const SUBMIT_SPEC: ActionSpec = {
  submit: {
    label: 'Submit',
    schema: {
      type: 'object',
      properties: {
        email: { type: 'string', format: 'email' },
        age: { type: 'number' },
      },
      required: ['email'],
    },
  },
  archive: {
    label: 'Archive',
    nextStep: 'archive_record',
  },
  confirmDelete: {
    label: 'Delete',
    schema: { type: 'string' },
  },
};

describe('validateActionData', () => {
  describe('happy path', () => {
    it('passes when action is declared and data matches schema', () => {
      const result = validateActionData(
        { action: 'submit', data: { email: 'a@b.co', age: 30 } },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('passes for void-payload action (no schema declared)', () => {
      const result = validateActionData({ action: 'archive' }, SUBMIT_SPEC);
      expect(result.valid).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('tolerates extra data on void-payload action (forward-compat)', () => {
      const result = validateActionData(
        { action: 'archive', data: { meta: 'client-only' } },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(true);
    });

    it('accepts primitive payload when schema expects primitive', () => {
      const result = validateActionData(
        { action: 'confirmDelete', data: 'item-42' },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(true);
    });
  });

  describe('shape rejections', () => {
    it('rejects non-object value', () => {
      const result = validateActionData('submit', SUBMIT_SPEC);
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toMatchObject({
        field: 'value',
        expected: 'object',
      });
    });

    it('rejects null value', () => {
      const result = validateActionData(null, SUBMIT_SPEC);
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('value');
    });

    it('rejects array value', () => {
      const result = validateActionData(['submit'], SUBMIT_SPEC);
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('value');
    });

    it('rejects missing action id', () => {
      const result = validateActionData(
        { data: { email: 'a@b.co' } },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('action');
    });

    it('rejects empty action id', () => {
      const result = validateActionData({ action: '' }, SUBMIT_SPEC);
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('action');
    });

    it('rejects non-string action id', () => {
      const result = validateActionData({ action: 42 }, SUBMIT_SPEC);
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toBe('action');
    });
  });

  describe('allowlist enforcement', () => {
    it('rejects undeclared action with list of declared actions', () => {
      const result = validateActionData(
        { action: 'deleteAccount', data: {} },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0]).toMatchObject({
        field: 'action',
        received: 'deleteAccount',
      });
      expect(result.violations[0].message).toContain('submit');
      expect(result.violations[0].message).toContain('archive');
    });

    it('reports the empty-spec case distinctly', () => {
      const empty: ActionSpec = {};
      const result = validateActionData(
        { action: 'anything', data: {} },
        empty,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].message).toContain('(none)');
    });
  });

  describe('schema violations', () => {
    it('rejects when declared action is missing a required field', () => {
      const result = validateActionData(
        { action: 'submit', data: { age: 20 } },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toContain('submit.data');
    });

    it('rejects top-level type mismatch (data is not an object when schema expects object)', () => {
      const result = validateActionData(
        { action: 'submit', data: 'not-an-object' },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(false);
      expect(result.violations[0].field).toContain('submit.data');
      expect(result.violations[0].expected).toBe('object');
    });

    it('rejects primitive schema mismatch', () => {
      const result = validateActionData(
        { action: 'confirmDelete', data: 42 },
        SUBMIT_SPEC,
      );
      expect(result.valid).toBe(false);
    });
  });
});

describe('validateJsonSchemaType — JSON Schema integer subtype', () => {
  // Exercise the private `validateJsonSchemaType` via the exported
  // `validatePropsData` path. JSON Schema spec: `type: 'integer'` matches
  // a numeric value iff `typeof v === 'number'` AND `Number.isInteger(v)`.
  // Mirrors `contract-inference.ts` (TS-side `'integer' → number`) and
  // `schema-subset.ts` (`isSchemaSubset({type:'integer'}, {type:'number'})`
  // = true).
  const INTEGER_SPEC: PropsSpec = {
    properties: {
      count: {
        required: true,
        schema: { type: 'integer', minimum: 0 },
      },
    },
  };

  const NUMBER_SPEC: PropsSpec = {
    properties: {
      ratio: {
        required: true,
        schema: { type: 'number' },
      },
    },
  };

  it('accepts an integer value for type: integer', () => {
    const result = validatePropsData({ count: 5 }, INTEGER_SPEC);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('rejects a fractional number for type: integer', () => {
    const result = validatePropsData({ count: 5.5 }, INTEGER_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'count',
      expected: 'integer',
      received: 'number',
    });
  });

  it('rejects a non-numeric value for type: integer', () => {
    const result = validatePropsData({ count: '5' }, INTEGER_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'count',
      expected: 'integer',
      received: 'string',
    });
  });

  it('regression: type: number still accepts both integers and fractionals', () => {
    expect(validatePropsData({ ratio: 5 }, NUMBER_SPEC).valid).toBe(true);
    expect(validatePropsData({ ratio: 5.5 }, NUMBER_SPEC).valid).toBe(true);
  });
});

describe('validatePropsData — closed-shape (strict mode)', () => {
  // propsSpec is the contract; undeclared keys are a contract
  // violation. Load-bearing for `ggui_update kind:'merge'` (RFC 7396)
  // where a typo'd patch field would otherwise silently land on the
  // stack item with no propsSpec coverage.
  const SHAPE_SPEC: PropsSpec = {
    properties: {
      title: { required: true, schema: { type: 'string' } },
      done: { schema: { type: 'boolean' } },
    },
  };

  it('rejects an undeclared key', () => {
    const result = validatePropsData(
      { title: 'hi', done: false, extra: 'snuck-in' },
      SHAPE_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toMatchObject({
      field: 'extra',
      received: 'string',
    });
    expect(result.violations[0].message).toContain('Undeclared field');
    expect(result.violations[0].message).toContain('title');
    expect(result.violations[0].message).toContain('done');
  });

  it('rejects multiple undeclared keys with one violation each', () => {
    const result = validatePropsData(
      { title: 'hi', a: 1, b: 2 },
      SHAPE_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations.map((v) => v.field).sort()).toEqual(['a', 'b']);
  });

  it('compounds with required + type violations', () => {
    const result = validatePropsData(
      { done: 'not-a-bool', extra: 1 },
      SHAPE_SPEC,
    );
    expect(result.valid).toBe(false);
    const fields = result.violations.map((v) => v.field).sort();
    // 'title' missing-required + 'done' wrong-type + 'extra' undeclared
    expect(fields).toEqual(['done', 'extra', 'title']);
  });

  it('reports received="null" for null-valued undeclared keys', () => {
    const result = validatePropsData(
      { title: 'hi', extra: null },
      SHAPE_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'extra',
      received: 'null',
    });
  });

  it('accepts an exactly-declared shape (no false positives)', () => {
    const result = validatePropsData({ title: 'hi', done: true }, SHAPE_SPEC);
    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('accepts the required-only subset (optional keys still optional)', () => {
    const result = validatePropsData({ title: 'hi' }, SHAPE_SPEC);
    expect(result.valid).toBe(true);
  });
});

describe('validatePropsData — deep closed-shape (recursive)', () => {
  // The same "propsSpec IS the contract" rule that bans extra top-level
  // keys also bans extras inside arrays and nested objects. Component
  // code is statically generated against the schema at every depth, so
  // any field name divergence (`done` vs declared `completed`, etc.) is
  // a contract violation that must reject at the wire, not silently
  // land on the iframe's props bag.
  const TODO_LIST_SPEC: PropsSpec = {
    properties: {
      todos: {
        required: true,
        schema: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              text: { type: 'string' },
              completed: { type: 'boolean' },
            },
          },
        },
      },
    },
  };

  it('rejects an undeclared key inside an array item (todo.done vs declared todo.completed)', () => {
    const result = validatePropsData(
      {
        todos: [
          { id: '1', text: 'buy milk', done: false }, // ← `done` not declared
        ],
      },
      TODO_LIST_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0]).toMatchObject({
      field: 'todos[0].done',
      received: 'boolean',
    });
    expect(result.violations[0].message).toContain('Undeclared field');
    expect(result.violations[0].message).toContain('completed');
  });

  it('rejects an undeclared key on a later array item (walks the full array)', () => {
    const result = validatePropsData(
      {
        todos: [
          { id: '1', text: 'a', completed: true },
          { id: '2', text: 'b', completed: false },
          { id: '3', text: 'c', completed: true },
          { id: '4', text: 'd', completed: false },
          { id: '5', text: 'e', completed: true },
          { id: '6', text: 'f', done: false }, // ← past the old 5-item cap
        ],
      },
      TODO_LIST_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('todos[5].done');
  });

  it('rejects an undeclared key in a deeply nested object', () => {
    const spec: PropsSpec = {
      properties: {
        user: {
          required: true,
          schema: {
            type: 'object',
            properties: {
              name: { type: 'string' },
              address: {
                type: 'object',
                properties: {
                  city: { type: 'string' },
                  zip: { type: 'string' },
                },
              },
            },
          },
        },
      },
    };
    const result = validatePropsData(
      { user: { name: 'a', address: { city: 'NYC', zipcode: '10001' } } }, // `zipcode` not declared
      spec,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('user.address.zipcode');
  });

  it('rejects a type mismatch inside an array item', () => {
    const result = validatePropsData(
      {
        todos: [{ id: '1', text: 'buy milk', completed: 'yes' }], // wrong type for completed
      },
      TODO_LIST_SPEC,
    );
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('todos[0].completed');
  });

  it('accepts a well-shaped nested structure at all depths', () => {
    const result = validatePropsData(
      {
        todos: [
          { id: '1', text: 'buy milk', completed: false },
          { id: '2', text: 'walk dog', completed: true },
        ],
      },
      TODO_LIST_SPEC,
    );
    expect(result.valid).toBe(true);
  });

  it('still requires top-level fields when nested objects are present', () => {
    const result = validatePropsData({}, TODO_LIST_SPEC);
    expect(result.valid).toBe(false);
    expect(result.violations[0].field).toBe('todos');
  });
});

describe('ContractViolationError with ggui_event tool', () => {
  it('accepts ggui_event tool value', () => {
    const err = new ContractViolationError({
      tool: 'ggui_event',
      violations: [{ field: 'action', message: 'bad' }],
    });
    expect(err.tool).toBe('ggui_event');
    expect(err.violations).toHaveLength(1);
  });

  it('uses an action-specific default hint for ggui_event', () => {
    const err = new ContractViolationError({
      tool: 'ggui_event',
      violations: [{ field: 'action', message: 'bad' }],
    });
    expect(err.hint).toContain('actionSpec');
    expect(err.hint).not.toContain('ggui_push'); // different framing than the mutation default
  });

  it('keeps the original default hint for mutation tools', () => {
    const err = new ContractViolationError({
      tool: 'ggui_update',
      violations: [{ field: 'props.x', message: 'bad' }],
    });
    expect(err.hint).toContain('ggui_push');
  });

  it('toErrorData carries tool=ggui_event and violations', () => {
    const err = new ContractViolationError({
      tool: 'ggui_event',
      violations: [{ field: 'action', message: 'bad' }],
    });
    const data = err.toErrorData();
    expect(data).toMatchObject({
      error: 'contract_violation',
      tool: 'ggui_event',
      violations: [{ field: 'action', message: 'bad' }],
    });
    expect(typeof data.hint).toBe('string');
  });

  it('honors custom hint override', () => {
    const err = new ContractViolationError({
      tool: 'ggui_event',
      violations: [],
      hint: 'custom hint',
    });
    expect(err.hint).toBe('custom hint');
  });
});

describe('buildPropsWrapperSchema', () => {
  it('synthesizes the object wrapper with required[] from entry.required', () => {
    const spec: PropsSpec = {
      properties: {
        title: { schema: { type: 'string' }, required: true },
        count: { schema: { type: 'number' } },
      },
    };
    const wrapper = buildPropsWrapperSchema(spec);
    expect(wrapper).toEqual({
      type: 'object',
      properties: {
        title: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['title'],
    });
  });

  it('drives validatePropsData identically — same wrapper, no drift', () => {
    const spec: PropsSpec = {
      properties: {
        name: { schema: { type: 'string' }, required: true },
      },
    };
    // The wrapper compiled directly must accept / reject the same data
    // `validatePropsData` does (which now routes through this helper).
    const direct = compileForValidation(buildPropsWrapperSchema(spec));
    expect(direct({ name: 'ok' })).toBe(true);
    expect(validatePropsData({ name: 'ok' }, spec).valid).toBe(true);
    expect(direct({ name: 42 })).toBe(false);
    expect(validatePropsData({ name: 42 }, spec).valid).toBe(false);
  });
});

describe('compileContractValidators', () => {
  const propsSpec: PropsSpec = {
    properties: { title: { schema: { type: 'string' }, required: true } },
  };
  const actionSpec: ActionSpec = {
    createTask: { label: 'Create', schema: { type: 'object', properties: { name: { type: 'string' } } } },
    archive: { label: 'Archive', nextStep: 'archive_record' }, // void — no schema
  };
  const streamSpec: StreamSpec = {
    tasks: { schema: { type: 'array', items: { type: 'string' } } },
  };
  const contextSpec: ContextSpec = {
    selection: { schema: { type: 'string' }, default: '' },
  };

  it('emits one ESM module per runtime-validated surface', () => {
    const out = compileContractValidators({
      propsSpec,
      actionSpec,
      streamSpec,
      contextSpec,
    });
    expect(out).toBeDefined();
    expect(typeof out?.props).toBe('string');
    expect(typeof out?.actions?.createTask).toBe('string');
    expect(typeof out?.streams?.tasks).toBe('string');
    expect(typeof out?.context?.selection).toBe('string');
    // Emitted text is ESM validator-module source.
    expect(out?.props).toContain('export default');
  });

  it('skips void actions that declare no schema', () => {
    const out = compileContractValidators({ actionSpec });
    expect(out?.actions).toBeDefined();
    expect(out?.actions?.createTask).toBeDefined();
    expect(out?.actions?.archive).toBeUndefined();
  });

  it('returns undefined when the contract has no runtime-validated schema', () => {
    expect(compileContractValidators({})).toBeUndefined();
    expect(
      compileContractValidators({ actionSpec: { archive: { label: 'A' } } }),
    ).toBeUndefined();
  });

  it('omits the props key when propsSpec has no properties', () => {
    const out = compileContractValidators({
      propsSpec: { properties: {} },
      actionSpec,
    });
    expect(out?.props).toBeUndefined();
    expect(out?.actions?.createTask).toBeDefined();
  });

  it('does not throw on a degenerate `props: {}` contract (no properties key)', () => {
    // A wire contract may carry `props: {}` — a propsSpec object with
    // no `properties` field at all. `Object.keys(undefined)` would
    // throw; the projection must tolerate it and just skip props.
    // `JSON.parse` yields the genuine runtime `{}` (typed `any`) the
    // wire delivers — no schema-violating cast needed.
    const degenerate: PropsSpec = JSON.parse('{}');
    expect(() =>
      compileContractValidators({ propsSpec: degenerate, actionSpec }),
    ).not.toThrow();
    const out = compileContractValidators({
      propsSpec: degenerate,
      actionSpec,
      streamSpec,
    });
    expect(out?.props).toBeUndefined();
    expect(out?.actions?.createTask).toBeDefined();
    expect(out?.streams?.tasks).toBeDefined();
  });
});

describe('bundleCompiledValidatorsAsModule', () => {
  it('wraps a CompiledContractValidators as an ES module whose default is the same object', () => {
    const compiled = {
      props: 'export default function v(d){return true};',
      actions: { increment: 'export default function v(d){return true};' },
    };
    const module = bundleCompiledValidatorsAsModule(compiled);
    expect(module).toBe(
      `export default ${JSON.stringify(compiled)};\n`,
    );
  });
});

describe('computeContractBundle', () => {
  it('returns undefined when the contract declares no runtime-validated schema', async () => {
    expect(await computeContractBundle({})).toBeUndefined();
  });

  it('returns {contractHash, bundleSource, validators} for a contract with an action', async () => {
    const result = await computeContractBundle({
      actionSpec: {
        increment: {
          label: 'inc',
          schema: { type: 'object', properties: { by: { type: 'integer' } } },
        },
      },
    });
    expect(result).toBeDefined();
    if (!result) return;
    expect(result.contractHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.bundleSource).toContain('export default');
    expect(result.validators.actions?.increment).toBeDefined();
  });

  it('produces a stable contractHash for the same contract on repeated calls', async () => {
    // Hash is over the INPUT specs, not the compiled output, so it's
    // stable across calls even though Ajv's standalone emitter uses
    // incrementing counter names (`validate10`, `validate11`) that change
    // per call from the shared singleton.
    const specs = {
      actionSpec: {
        increment: {
          label: 'inc',
          schema: { type: 'object', properties: { by: { type: 'integer' } } },
        },
      },
    };
    const a = await computeContractBundle(specs);
    const b = await computeContractBundle(specs);
    expect(a?.contractHash).toBe(b?.contractHash);
  });

  it('produces a stable contractHash regardless of input-key insertion order', async () => {
    // Canonical-JSON serialization sorts keys at every depth, so two
    // logically-identical specs built with different key orders hash to
    // the same value.
    const a = await computeContractBundle({
      actionSpec: {
        b: { label: 'b', schema: { type: 'object', properties: { y: { type: 'string' }, x: { type: 'integer' } } } },
        a: { label: 'a', schema: { type: 'object' } },
      },
    });
    const b = await computeContractBundle({
      actionSpec: {
        a: { label: 'a', schema: { type: 'object' } },
        b: { label: 'b', schema: { type: 'object', properties: { x: { type: 'integer' }, y: { type: 'string' } } } },
      },
    });
    expect(a?.contractHash).toBe(b?.contractHash);
  });

  it('produces different hashes for different contracts', async () => {
    const a = await computeContractBundle({
      actionSpec: {
        a: { label: 'a', schema: { type: 'object' } },
      },
    });
    const b = await computeContractBundle({
      actionSpec: {
        b: { label: 'b', schema: { type: 'object' } },
      },
    });
    expect(a?.contractHash).not.toBe(b?.contractHash);
  });
});
