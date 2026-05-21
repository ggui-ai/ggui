import { describe, it, expect } from 'vitest';
import type { DataContract } from '../types/data-contract';
import {
  CTR_SCHEMA_INCOMPAT,
  SchemaCompatInvariantError,
  assertSchemaCompat,
  checkActionSchemaCompat,
  checkSchemaCompat,
  checkStreamSchemaCompat,
} from './schema-compat-invariants';

describe('checkActionSchemaCompat', () => {
  it('returns no violations when actionSpec is empty', () => {
    expect(checkActionSchemaCompat(undefined, undefined)).toEqual([]);
  });

  it('skips entries without nextStep', () => {
    const violations = checkActionSchemaCompat(
      {
        tellMore: { label: 'Tell me more' },
      },
      { tools: {} },
    );
    expect(violations).toEqual([]);
  });

  it('skips entries when the referenced tool has no inputSchema', () => {
    const violations = checkActionSchemaCompat(
      {
        save: {
          label: 'Save',
          schema: { type: 'object', properties: {}, additionalProperties: false },
          nextStep: 'save_tool',
        },
      },
      { tools: { save_tool: {} } },
    );
    expect(violations).toEqual([]);
  });

  it('skips entries when the referenced tool does not exist (covered by CTR_REF_NEXT_STEP)', () => {
    const violations = checkActionSchemaCompat(
      {
        save: { label: 'Save', nextStep: 'missing' },
      },
      { tools: {} },
    );
    expect(violations).toEqual([]);
  });

  it('passes when action.schema is a subset of tool.inputSchema', () => {
    const violations = checkActionSchemaCompat(
      {
        save: {
          label: 'Save',
          schema: {
            type: 'object',
            properties: { id: { type: 'string' } },
            required: ['id'],
            additionalProperties: false,
          },
          nextStep: 'save_tool',
        },
      },
      {
        tools: {
          save_tool: {
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' }, force: { type: 'boolean' } },
              required: ['id'],
            },
          },
        },
      },
    );
    expect(violations).toEqual([]);
  });

  it('emits CTR_SCHEMA_INCOMPAT when action.schema is not a subset', () => {
    const violations = checkActionSchemaCompat(
      {
        save: {
          label: 'Save',
          schema: {
            type: 'object',
            properties: { wrongField: { type: 'number' } },
            required: ['wrongField'],
            additionalProperties: false,
          },
          nextStep: 'save_tool',
        },
      },
      {
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
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_SCHEMA_INCOMPAT);
    expect(violations[0].side).toBe('action');
    expect(violations[0].specName).toBe('save');
    expect(violations[0].toolName).toBe('save_tool');
    expect(violations[0].field).toBe('actionSpec.save.schema');
  });

  it('treats void payload (no schema) as empty-object schema', () => {
    // Tool requires `id: string`; void action sends nothing → violation.
    const violations = checkActionSchemaCompat(
      {
        ping: { label: 'Ping', nextStep: 'ping_tool' },
      },
      {
        tools: {
          ping_tool: {
            inputSchema: {
              type: 'object',
              properties: { id: { type: 'string' } },
              required: ['id'],
            },
          },
        },
      },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_SCHEMA_INCOMPAT);
  });
});

describe('checkStreamSchemaCompat', () => {
  it('returns no violations on empty streamSpec', () => {
    expect(checkStreamSchemaCompat(undefined, { tools: {} })).toEqual([]);
  });

  it('skips channels without source', () => {
    const violations = checkStreamSchemaCompat(
      { messages: { schema: { type: 'string' } } },
      { tools: {} },
    );
    expect(violations).toEqual([]);
  });

  it('skips channels when the referenced tool has no outputSchema', () => {
    const violations = checkStreamSchemaCompat(
      {
        feed: {
          schema: { type: 'object' },
          source: { tool: 'feed_tool' },
        },
      },
      { tools: { feed_tool: {} } },
    );
    expect(violations).toEqual([]);
  });

  it('passes when channel.schema accepts every tool.outputSchema value', () => {
    const violations = checkStreamSchemaCompat(
      {
        feed: {
          schema: {
            type: 'object',
            properties: {
              kind: { type: 'string' },
              body: { type: 'string' },
            },
            // Channel is permissive: required is a subset of what the
            // tool always produces; channel accepts more shapes.
          },
          source: { tool: 'feed_tool' },
        },
      },
      {
        tools: {
          feed_tool: {
            outputSchema: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                body: { type: 'string' },
              },
              required: ['kind', 'body'],
            },
          },
        },
      },
    );
    expect(violations).toEqual([]);
  });

  it('emits CTR_SCHEMA_INCOMPAT when channel.schema rejects valid tool outputs', () => {
    const violations = checkStreamSchemaCompat(
      {
        feed: {
          schema: {
            type: 'object',
            properties: { kind: { type: 'string' } },
            required: ['kind'],
            additionalProperties: false,
          },
          source: { tool: 'feed_tool' },
        },
      },
      {
        tools: {
          feed_tool: {
            outputSchema: {
              type: 'object',
              properties: {
                kind: { type: 'string' },
                extra: { type: 'string' },
              },
              required: ['kind', 'extra'],
            },
          },
        },
      },
    );
    expect(violations).toHaveLength(1);
    expect(violations[0].code).toBe(CTR_SCHEMA_INCOMPAT);
    expect(violations[0].side).toBe('stream');
    expect(violations[0].specName).toBe('feed');
    expect(violations[0].toolName).toBe('feed_tool');
  });
});

describe('checkSchemaCompat (aggregate)', () => {
  it('returns no violations for an empty contract', () => {
    expect(checkSchemaCompat({})).toEqual([]);
  });

  it('aggregates action + stream violations in stable order (action first)', () => {
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
      streamSpec: {
        feed: {
          schema: {
            type: 'object',
            properties: { kind: { type: 'string' } },
            required: ['kind'],
            additionalProperties: false,
          },
          source: { tool: 'feed_tool' },
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
          feed_tool: {
            outputSchema: {
              type: 'object',
              properties: { kind: { type: 'string' }, extra: { type: 'string' } },
              required: ['kind', 'extra'],
            },
          },
        },
      },
    };
    const violations = checkSchemaCompat(contract);
    expect(violations.map((v) => v.side)).toEqual(['action', 'stream']);
  });
});

describe('assertSchemaCompat', () => {
  it('is a no-op when schemas align', () => {
    expect(() =>
      assertSchemaCompat({
        actionSpec: {
          ping: { label: 'Ping', nextStep: 'ping_tool' },
        },
        agentCapabilities: { tools: { ping_tool: {} } },
      }),
    ).not.toThrow();
  });

  it('throws SchemaCompatInvariantError listing every violation', () => {
    const contract: DataContract = {
      actionSpec: {
        save: {
          label: 'Save',
          schema: {
            type: 'object',
            properties: {},
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
            },
          },
        },
      },
    };
    let caught: unknown;
    try {
      assertSchemaCompat(contract);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SchemaCompatInvariantError);
    const err = caught as SchemaCompatInvariantError;
    expect(err.code).toBe('schema_compat_incompat');
    expect(err.violations).toHaveLength(1);
    expect(err.message).toContain('CTR_SCHEMA_INCOMPAT');
  });
});
