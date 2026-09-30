import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as zm from 'zod/mini';
import type { JsonValue } from '../types/data-contract';
import { jsonValueSchema } from './data-contract';

// ggui#1637 — the object arm checks its members in code instead of recursing, so the served JSON Schema has no
// definition that reaches itself through required members (a shape Google's function-declaration validator refuses).
// The accepted set must not move: this is the schema as it was, kept here only as the reference to compare against.
const recursingReference: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(recursingReference), z.record(z.string(), recursingReference)]),
);

class Instance {
  a = null;
}
const nullProto: { a?: null } = Object.create(null);
nullProto.a = null;
// eslint-disable-next-line no-sparse-arrays -- a hole is one of the cases the two schemas must agree on
const holey = [null, , null];

const CASES: ReadonlyArray<readonly [string, unknown]> = [
  ['a string', 'x'],
  ['a finite number', 1.5],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['true', true],
  ['null', null],
  ['undefined', undefined],
  ['a function', () => 1],
  ['a bigint', BigInt(1)],
  ['an empty object', {}],
  ['an empty array', []],
  ['a nested JSON object', { a: { b: [1, 'two', { c: null, d: [true, { e: 3 }] }] } }],
  ['an object with an undefined member', { a: undefined }],
  ['an object with a nested undefined member', { a: { b: undefined } }],
  ['an object with a NaN member', { a: Number.NaN }],
  ['an object with a nested Infinity', { a: [{ b: Number.NEGATIVE_INFINITY }] }],
  ['an object with a function member', { a: () => 1 }],
  ['an object with a Date member', { a: new Date(0) }],
  ['an object with a Map member', { a: new Map() }],
  ['an object with a class-instance member', { a: new Instance() }],
  ['a null-prototype object', nullProto],
  ['an object holding a null-prototype object', { a: nullProto }],
  ['a Date', new Date(0)],
  ['a class instance', new Instance()],
  ['an array with a hole', holey],
  ['an object holding an array with a hole', { a: holey }],
  ['an array holding an object with an undefined member', [{ a: undefined }]],
];

describe('jsonValueSchema accepts exactly what it accepted when its object arm recursed (ggui#1637)', () => {
  it.each(CASES)('%s: same verdict as the recursing reference', (_label, value) => {
    expect(jsonValueSchema.safeParse(value).success).toBe(recursingReference.safeParse(value).success);
  });

  it('the cases include both verdicts, so the agreement is not vacuous', () => {
    const verdicts = new Set(CASES.map(([, v]) => recursingReference.safeParse(v).success));
    expect([...verdicts].sort()).toEqual([false, true]);
  });

  it('serves an object arm whose members are open (`additionalProperties: {}`), and an array arm that still recurses', () => {
    // The MCP SDK's own call: zod v4's toJSONSchema, draft-7, input side.
    const emitted = zm.toJSONSchema(z.object({ v: jsonValueSchema }), { target: 'draft-7', io: 'input' });
    expect(emitted.definitions).toEqual({
      __schema0: {
        anyOf: [
          { type: 'string' },
          { type: 'number' },
          { type: 'boolean' },
          { type: 'null' },
          { type: 'array', items: { $ref: '#/definitions/__schema0' } },
          { type: 'object', propertyNames: { type: 'string' }, additionalProperties: {} },
        ],
      },
    });
  });
});
