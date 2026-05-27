import { describe, expect, it } from 'vitest';
import {
  assertContractSchemasValid,
  ContractSchemaMetaError,
} from './schema-meta-validation';
import type { DataContract, JsonSchema } from '../types/data-contract';

describe('assertContractSchemasValid', () => {
  it('passes on a well-formed contract (no schemas)', () => {
    const contract: DataContract = {};
    expect(() => assertContractSchemasValid(contract)).not.toThrow();
  });

  it('passes on well-formed propsSpec / actionSpec / streamSpec / contextSpec / agentCapabilities', () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          title: { schema: { type: 'string' } },
          counts: {
            schema: {
              type: 'object',
              properties: { items: { type: 'array', items: { type: 'string' } } },
            },
          },
        },
      },
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
      streamSpec: {
        tick: {
          schema: { type: 'object', properties: { n: { type: 'number' } } },
        },
      },
      contextSpec: {
        currentTab: { schema: { type: 'string' } },
      },
      agentCapabilities: {
        tools: {
          fetch: {
            inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
            outputSchema: { type: 'object', properties: { ok: { type: 'boolean' } } },
          },
        },
      },
    };
    expect(() => assertContractSchemasValid(contract)).not.toThrow();
  });

  it('rejects a malformed propsSpec schema (items is a string, not a schema)', () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          broken: {
            schema: {
              type: 'array',
              items: 'not-a-schema',
            } as unknown as JsonSchema,
          },
        },
      },
    };
    let error: ContractSchemaMetaError | undefined;
    try {
      assertContractSchemasValid(contract);
    } catch (e) {
      error = e as ContractSchemaMetaError;
    }
    expect(error).toBeInstanceOf(ContractSchemaMetaError);
    expect(error?.violations).toHaveLength(1);
    expect(error?.violations[0].field).toBe('propsSpec.properties.broken.schema');
  });

  it('rejects an actionSpec schema with a malformed property (value is not a schema)', () => {
    const contract: DataContract = {
      actionSpec: {
        submit: {
          label: 'Submit',
          schema: {
            type: 'object',
            properties: { x: 'not-a-schema' },
          } as unknown as JsonSchema,
        },
      },
    };
    let error: ContractSchemaMetaError | undefined;
    try {
      assertContractSchemasValid(contract);
    } catch (e) {
      error = e as ContractSchemaMetaError;
    }
    expect(error?.violations[0].field).toBe('actionSpec.submit.schema');
  });

  it('collects ALL malformed schemas before throwing (one round of feedback)', () => {
    const bad: JsonSchema = {
      type: 'array',
      items: 'not-a-schema',
    } as unknown as JsonSchema;
    const contract: DataContract = {
      propsSpec: {
        properties: {
          bad1: { schema: bad },
        },
      },
      streamSpec: {
        bad2: { schema: bad },
      },
      contextSpec: {
        bad3: { schema: bad },
      },
    };
    let error: ContractSchemaMetaError | undefined;
    try {
      assertContractSchemasValid(contract);
    } catch (e) {
      error = e as ContractSchemaMetaError;
    }
    expect(error?.violations).toHaveLength(3);
    const fields = error?.violations.map(v => v.field).sort();
    expect(fields).toEqual([
      'contextSpec.bad3.schema',
      'propsSpec.properties.bad1.schema',
      'streamSpec.bad2.schema',
    ]);
  });

  it('skips actionSpec entries without a schema (void-payload actions)', () => {
    const contract: DataContract = {
      actionSpec: {
        archive: { label: 'Archive', nextStep: 'archive' },
      },
    };
    expect(() => assertContractSchemasValid(contract)).not.toThrow();
  });

  it('walks agentCapabilities.tools[*].inputSchema + outputSchema independently', () => {
    const contract: DataContract = {
      agentCapabilities: {
        tools: {
          fetch: {
            inputSchema: { type: 'string' },
            outputSchema: {
              type: 'array',
              items: 'not-a-schema',
            } as unknown as JsonSchema,
          },
        },
      },
    };
    let error: ContractSchemaMetaError | undefined;
    try {
      assertContractSchemasValid(contract);
    } catch (e) {
      error = e as ContractSchemaMetaError;
    }
    expect(error?.violations).toHaveLength(1);
    expect(error?.violations[0].field).toBe(
      'agentCapabilities.tools.fetch.outputSchema',
    );
  });

  it('exposes a recovery hint on the thrown error', () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          broken: {
            schema: {
              type: 'array',
              items: 'not-a-schema',
            } as unknown as JsonSchema,
          },
        },
      },
    };
    let error: ContractSchemaMetaError | undefined;
    try {
      assertContractSchemasValid(contract);
    } catch (e) {
      error = e as ContractSchemaMetaError;
    }
    expect(error?.code).toBe('contract_schema_invalid');
    expect(error?.hint).toContain('Fix the JSON Schema');
    expect(error?.hint).toContain('ggui_render');
  });
});
