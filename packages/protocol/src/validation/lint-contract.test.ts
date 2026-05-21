import { describe, it, expect } from 'vitest';
import type { DataContract } from '../types/data-contract';
import {
  ContractValidationError,
  lintContract,
  validateContract,
} from './lint-contract';

const objectSchema = {
  type: 'object' as const,
  properties: {},
  additionalProperties: false,
};

describe('validateContract — strict, throws on first failing phase', () => {
  it('passes on an empty contract', () => {
    expect(() => validateContract({})).not.toThrow();
  });

  it('passes on a fully-valid contract', () => {
    const contract: DataContract = {
      actionSpec: {
        archive: {
          label: 'Archive',
          schema: objectSchema,
          nextStep: 'archive_email',
        },
      },
      agentCapabilities: {
        tools: { archive_email: { inputSchema: objectSchema } },
      },
    };
    expect(() => validateContract(contract)).not.toThrow();
  });

  it('throws ContractValidationError at phase `references` when nextStep is unresolved', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'Archive', nextStep: 'missing' } },
    };
    let caught: unknown;
    try {
      validateContract(contract);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContractValidationError);
    const err = caught as ContractValidationError;
    expect(err.phase).toBe('references');
    expect(err.issues).toHaveLength(1);
    expect(err.issues[0].code).toBe('CTR_REF_NEXT_STEP');
  });

  it('throws at phase `references` for name collisions before schema-compat', () => {
    const contract: DataContract = {
      actionSpec: { foo: { label: 'F' } },
      contextSpec: {
        foo: { schema: { type: 'string' }, default: '' },
      },
    };
    let caught: unknown;
    try {
      validateContract(contract);
    } catch (err) {
      caught = err;
    }
    const err = caught as ContractValidationError;
    expect(err.phase).toBe('references');
    expect(err.issues[0].code).toBe('CTR_DUP_NAME');
  });

  it('throws at phase `schema-compat` when references resolve but schemas mismatch', () => {
    const contract: DataContract = {
      actionSpec: {
        save: {
          label: 'Save',
          schema: {
            type: 'object',
            properties: { wrong: { type: 'number' } },
            required: ['wrong'],
            additionalProperties: false,
          },
          nextStep: 'save_tool',
        },
      },
      agentCapabilities: {
        tools: {
          save_tool: {
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
      },
    };
    let caught: unknown;
    try {
      validateContract(contract);
    } catch (err) {
      caught = err;
    }
    const err = caught as ContractValidationError;
    expect(err.phase).toBe('schema-compat');
    expect(err.issues[0].code).toBe('CTR_SCHEMA_INCOMPAT');
  });

  it('phase ordering: references fires before schema-compat even when both would fail', () => {
    // Action references a missing tool (phase 2) AND its schema would
    // otherwise mismatch (phase 3). Strict mode short-circuits at
    // phase 2.
    const contract: DataContract = {
      actionSpec: {
        save: {
          label: 'Save',
          schema: objectSchema,
          nextStep: 'unknown_tool',
        },
      },
      agentCapabilities: { tools: {} },
    };
    let caught: unknown;
    try {
      validateContract(contract);
    } catch (err) {
      caught = err;
    }
    const err = caught as ContractValidationError;
    expect(err.phase).toBe('references');
  });
});

describe('lintContract — graded, returns errors + warnings', () => {
  it('returns empty arrays for a fully-clean contract (no warnings either)', () => {
    const result = lintContract({
      actionSpec: { archive: { label: 'Archive', nextStep: 'tool' } },
      agentCapabilities: {
        tools: {
          tool: {
            inputSchema: objectSchema,
            usage: 'archives the email',
            example: { input: {}, output: 'ok' },
          },
        },
      },
    });
    expect(result.errors).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it('surfaces errors from BOTH references and schema-compat phases in one run', () => {
    // Unresolved ref on one action + schema mismatch on another.
    const contract: DataContract = {
      actionSpec: {
        a: { label: 'A', nextStep: 'missing' },
        b: {
          label: 'B',
          schema: {
            type: 'object',
            properties: { wrong: { type: 'number' } },
            required: ['wrong'],
            additionalProperties: false,
          },
          nextStep: 'b_tool',
        },
      },
      agentCapabilities: {
        tools: {
          b_tool: {
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
              additionalProperties: false,
            },
          },
        },
      },
    };
    const result = lintContract(contract);
    const codes = result.errors.map((e) => e.code);
    expect(codes).toContain('CTR_REF_NEXT_STEP');
    expect(codes).toContain('CTR_SCHEMA_INCOMPAT');
  });

  it('issues carry phase + severity + path for downstream routing', () => {
    const contract: DataContract = {
      actionSpec: { archive: { label: 'Archive', nextStep: 'missing' } },
    };
    const result = lintContract(contract);
    expect(result.errors).toHaveLength(1);
    const issue = result.errors[0];
    expect(issue.severity).toBe('error');
    expect(issue.phase).toBe('references');
    expect(issue.path).toBe('actionSpec.archive.nextStep');
    expect(issue.code).toBe('CTR_REF_NEXT_STEP');
  });

  it('surfaces phase-4 hygiene warnings (orphan agent tool, missing usage, missing example)', () => {
    const result = lintContract({
      agentCapabilities: { tools: { unused_tool: { inputSchema: objectSchema } } },
    });
    expect(result.errors).toEqual([]);
    const codes = result.warnings.map((w) => w.code).sort();
    expect(codes).toContain('LINT_ORPHAN_AGENT_TOOL');
    expect(codes).toContain('LINT_MISSING_USAGE');
    expect(codes).toContain('LINT_MISSING_EXAMPLE');
    for (const w of result.warnings) {
      expect(w.severity).toBe('warn');
      expect(w.phase).toBe('hygiene');
    }
  });

  it('shape-phase errors short-circuit downstream phases inside graded mode (avoids type cast on malformed input)', () => {
    const malformed = { actionSpec: 'not-an-object' } as unknown as DataContract;
    const result = lintContract(malformed);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].phase).toBe('shape');
    // No reference-phase errors despite missing agentCapabilities — short-
    // circuited because the shape didn't parse.
    expect(
      result.errors.some((e) => e.code === 'CTR_REF_NEXT_STEP'),
    ).toBe(false);
  });
});
