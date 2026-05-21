import { describe, it, expect } from 'vitest';
import type { DataContract } from '../types/data-contract';
import {
  CTR_DUP_NAME,
  CTR_RESERVED_NAME,
  NameInvariantError,
  assertNameInvariants,
  checkNameCollisions,
  checkNameInvariants,
  checkReservedNames,
} from './name-invariants';

const stringSchema = { type: 'string' as const };

describe('checkNameCollisions', () => {
  it('returns no violations on an empty contract', () => {
    expect(checkNameCollisions({})).toEqual([]);
  });

  it('returns no violations when names are unique across specs', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
      streamSpec: { progress: { schema: stringSchema } },
      contextSpec: { draft: { schema: stringSchema, default: '' } },
    };
    expect(checkNameCollisions(contract)).toEqual([]);
  });

  it('flags a collision between actionSpec and contextSpec', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
      contextSpec: { submit: { schema: { type: 'boolean' }, default: false } },
    };
    const violations = checkNameCollisions(contract);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_DUP_NAME);
    expect(violations[0].message).toContain('submit');
    expect(violations[0].message).toContain('actionSpec');
    expect(violations[0].message).toContain('contextSpec');
  });

  it('flags a collision across all three specs (one violation, three fields named)', () => {
    const contract: DataContract = {
      actionSpec: { x: { label: 'X' } },
      streamSpec: { x: { schema: stringSchema } },
      contextSpec: { x: { schema: stringSchema, default: '' } },
    };
    const violations = checkNameCollisions(contract);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_DUP_NAME);
    expect(violations[0].received).toBe('actionSpec + streamSpec + contextSpec');
  });

  it('flags multiple distinct collisions independently', () => {
    const contract: DataContract = {
      actionSpec: { foo: { label: 'F' }, bar: { label: 'B' } },
      contextSpec: {
        foo: { schema: stringSchema, default: '' },
        bar: { schema: stringSchema, default: '' },
      },
    };
    const violations = checkNameCollisions(contract);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.received).sort()).toEqual([
      'actionSpec + contextSpec',
      'actionSpec + contextSpec',
    ]);
  });

  it('returns no violations when only one spec carries the name', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
    };
    expect(checkNameCollisions(contract)).toEqual([]);
  });
});

describe('checkReservedNames', () => {
  it('returns no violations on empty contract', () => {
    expect(checkReservedNames({})).toEqual([]);
  });

  it('returns no violations on author-namespaced names', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
      contextSpec: { draft: { schema: stringSchema, default: '' } },
    };
    expect(checkReservedNames(contract)).toEqual([]);
  });

  it('flags `_ggui:`-prefixed action keys', () => {
    const contract: DataContract = {
      actionSpec: {
        '_ggui:internal': { label: 'reserved' },
      },
    };
    const violations = checkReservedNames(contract);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_RESERVED_NAME);
    expect(violations[0].received).toBe('_ggui:internal');
    expect(violations[0].field).toBe('actionSpec._ggui:internal');
  });

  it('flags `_ggui:`-prefixed context slot keys', () => {
    const contract: DataContract = {
      contextSpec: {
        '_ggui:runtime': { schema: stringSchema, default: '' },
      },
    };
    const violations = checkReservedNames(contract);
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_RESERVED_NAME);
    expect(violations[0].field).toBe('contextSpec._ggui:runtime');
  });

  it('does NOT flag streamSpec reserved keys (covered by validateContractStructure)', () => {
    const contract: DataContract = {
      streamSpec: {
        '_ggui:preview': { schema: stringSchema },
      },
    };
    expect(checkReservedNames(contract)).toEqual([]);
  });

  it('flags multiple reserved keys in one pass', () => {
    const contract: DataContract = {
      actionSpec: { '_ggui:a': { label: 'a' } },
      contextSpec: { '_ggui:b': { schema: stringSchema, default: '' } },
    };
    const violations = checkReservedNames(contract);
    expect(violations).toHaveLength(2);
    expect(violations.map((v) => v.received).sort()).toEqual([
      '_ggui:a',
      '_ggui:b',
    ]);
  });
});

describe('checkNameInvariants (aggregate)', () => {
  it('returns no violations for a clean contract', () => {
    const contract: DataContract = {
      actionSpec: { submit: { label: 'Submit' } },
      contextSpec: { draft: { schema: stringSchema, default: '' } },
    };
    expect(checkNameInvariants(contract)).toEqual([]);
  });

  it('aggregates collisions and reserved names in stable order (collisions first)', () => {
    const contract: DataContract = {
      actionSpec: {
        x: { label: 'X' },
        '_ggui:bad': { label: 'reserved' },
      },
      contextSpec: { x: { schema: stringSchema, default: '' } },
    };
    const violations = checkNameInvariants(contract);
    expect(violations.map((v) => v.code)).toEqual([
      CTR_DUP_NAME,
      CTR_RESERVED_NAME,
    ]);
  });
});

describe('assertNameInvariants', () => {
  it('is a no-op on a clean contract', () => {
    expect(() =>
      assertNameInvariants({
        actionSpec: { submit: { label: 'Submit' } },
      }),
    ).not.toThrow();
  });

  it('throws NameInvariantError listing every violation', () => {
    const contract: DataContract = {
      actionSpec: { x: { label: 'X' }, '_ggui:bad': { label: 'reserved' } },
      contextSpec: { x: { schema: stringSchema, default: '' } },
    };
    let caught: unknown;
    try {
      assertNameInvariants(contract);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(NameInvariantError);
    const err = caught as NameInvariantError;
    expect(err.code).toBe('name_invariant_violation');
    expect(err.violations).toHaveLength(2);
    expect(err.message).toContain('CTR_DUP_NAME');
    expect(err.message).toContain('CTR_RESERVED_NAME');
  });
});
