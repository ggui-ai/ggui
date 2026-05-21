// packages/ui-gen/src/check/contract-validation.test.ts
//
// Unit tests for the data-contract conformance helpers
// (PropsSpec / StreamSpec / ActionSpec).
//
// Promoted from `core/src/tools/contract-validation.test.ts` as part
// of the OSS tier-0 migration. Original coverage kept verbatim — only
// the import source was updated to `./contract-validation.js`.

import { describe, it, expect } from "vitest";
import type { PropsSpec, StreamSpec, ActionSpec, DataContract } from "@ggui-ai/protocol";
import {
  extractPropsInterface,
  validatePropsAgainstSchema,
  validateStreamSpecConformance,
  validateActionSpecConformance,
  validateAllContracts,
  jsonSchemaTypeToTs,
  propsSpecToTypeScript,
  inferPropsSpecFromSampleData,
} from "./contract-validation.js";

// =============================================================================
// extractPropsInterface
// =============================================================================

describe('extractPropsInterface', () => {
  it('extracts fields from interface Props', () => {
    const code = `
interface Props {
  city: string;
  temperature: number;
  forecast: Array<{ day: string; high: number }>;
}`;
    const result = extractPropsInterface(code);
    expect(result).not.toBeNull();
    // Top-level fields should be present (regex may also capture nested fields)
    const names = result!.map((p) => p.name);
    expect(names).toContain('city');
    expect(names).toContain('temperature');
    expect(names).toContain('forecast');
    expect(result!.find((p) => p.name === 'city')).toEqual({ name: 'city', type: 'string', optional: false });
  });

  it('extracts optional fields', () => {
    const code = `
interface Props {
  city: string;
  unit?: string;
}`;
    const result = extractPropsInterface(code);
    expect(result).toHaveLength(2);
    expect(result![0].optional).toBe(false);
    expect(result![1].optional).toBe(true);
  });

  it('handles type Props = { ... }', () => {
    const code = `type Props = { name: string; age: number; }`;
    const result = extractPropsInterface(code);
    expect(result).not.toBeNull();
    expect(result!.find((p) => p.name === 'name')).toBeDefined();
  });

  it('handles destructured defaults', () => {
    const code = `
interface Props { city?: string; temp?: number; unit: string; }
export default function Component({ city = "Tokyo", temp = 28, unit }: Props) {}`;
    const result = extractPropsInterface(code);
    expect(result).not.toBeNull();
    expect(result!.find((p) => p.name === 'city')?.optional).toBe(true);
    expect(result!.find((p) => p.name === 'unit')?.optional).toBe(false);
  });

  it('returns null for code without Props', () => {
    const code = `export default function Component() { return <div/>; }`;
    expect(extractPropsInterface(code)).toBeNull();
  });
});

// =============================================================================
// validatePropsAgainstSchema
// =============================================================================

describe('validatePropsAgainstSchema', () => {
  const weatherSpec: PropsSpec = {
    properties: {
      city: { schema: { type: 'string' }, required: true },
      temperature: { schema: { type: 'number' }, required: true },
      unit: { schema: { type: 'string' }, required: false },
    },
  };

  it('passes when all required fields present', () => {
    const code = `interface Props { city: string; temperature: number; unit?: string; }`;
    const issues = validatePropsAgainstSchema(code, weatherSpec);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('errors on missing required field', () => {
    const code = `interface Props { unit: string; }`;
    const issues = validatePropsAgainstSchema(code, weatherSpec);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors.length).toBeGreaterThanOrEqual(2); // city + temperature missing
    expect(errors.some((e) => e.field === 'city')).toBe(true);
    expect(errors.some((e) => e.field === 'temperature')).toBe(true);
  });

  it('warns on missing optional field', () => {
    const code = `interface Props { city: string; temperature: number; }`;
    const issues = validatePropsAgainstSchema(code, weatherSpec);
    const warnings = issues.filter((i) => i.severity === 'warning');
    expect(warnings.some((w) => w.field === 'unit')).toBe(true);
  });

  it('warns on type mismatch', () => {
    const code = `interface Props { city: number; temperature: number; }`;
    const issues = validatePropsAgainstSchema(code, weatherSpec);
    expect(issues.some((i) => i.field === 'city' && i.severity === 'warning')).toBe(true);
  });

  it('allows extra fields not in schema', () => {
    const code = `interface Props { city: string; temperature: number; onRefresh: () => void; className: string; }`;
    const issues = validatePropsAgainstSchema(code, weatherSpec);
    const errors = issues.filter((i) => i.severity === 'error');
    expect(errors).toHaveLength(0);
  });

  it('returns empty for code without Props interface', () => {
    const code = `export default function X() { return <div/>; }`;
    expect(validatePropsAgainstSchema(code, weatherSpec)).toHaveLength(0);
  });
});

// =============================================================================
// validateStreamSpecConformance
// =============================================================================

describe('validateStreamSpecConformance', () => {
  const chatSpec: StreamSpec = {
    message: { description: 'New message', schema: { type: 'object' } },
    typing: { description: 'Typing indicator', schema: { type: 'object' } },
  };

  it('passes when useStream wire hooks and channels are present', () => {
    const code = `
      const message = useStream('message');
      const typing = useStream('typing');
      export default function Chat() { return <div/>; }`;
    const issues = validateStreamSpecConformance(code, chatSpec);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('errors when useStream not present', () => {
    const code = `export default function Chat() { return <div/>; }`;
    const issues = validateStreamSpecConformance(code, chatSpec);
    expect(issues.some((i) => i.severity === 'error')).toBe(true);
  });

  it('warns when event type not referenced', () => {
    const code = `
      const message = useStream('message');
      export default function Chat() { return <div/>; }`;
    const issues = validateStreamSpecConformance(code, chatSpec);
    expect(issues.some((i) => i.field === 'typing' && i.severity === 'warning')).toBe(true);
  });
});

// =============================================================================
// validateActionSpecConformance
// =============================================================================

describe('validateActionSpecConformance', () => {
  const spec: ActionSpec = {
    submit: { label: 'Submit', description: 'Submit form' },
    cancel: { label: 'Cancel' },
  };

  it('passes when actions are wired', () => {
    const code = `
      <Button onClick={props.onSubmit}>Submit</Button>
      <Button onClick={() => handleAction('cancel')}>Cancel</Button>`;
    const issues = validateActionSpecConformance(code, spec);
    expect(issues.filter((i) => i.severity === 'error')).toHaveLength(0);
  });

  it('errors when action not wired', () => {
    const code = `<Button onClick={props.onSubmit}>Submit</Button>`;
    const issues = validateActionSpecConformance(code, spec);
    expect(issues.some((i) => i.field === 'cancel' && i.severity === 'error')).toBe(true);
  });
});

// =============================================================================
// validateAllContracts
// =============================================================================

describe('validateAllContracts', () => {
  it('validates all three contract together', () => {
    const contract: DataContract = {
      propsSpec: {
        properties: {
          title: { schema: { type: 'string' }, required: true },
        },
      },
      streamSpec: {
        update: { schema: { type: 'object' } },
      },
      actionSpec: {
        save: { label: 'Save' },
      },
    };

    const code = `
interface Props { name: string; }
export default function C(props: Props) { return <div/>; }`;

    const issues = validateAllContracts(code, contract);
    // Should have errors from: missing 'title' prop, missing useStream, missing 'save' action
    expect(issues.filter((i) => i.severity === 'error').length).toBeGreaterThanOrEqual(3);
  });

  it('returns empty when no contract provided', () => {
    expect(validateAllContracts('code', {})).toHaveLength(0);
  });
});

// =============================================================================
// jsonSchemaTypeToTs
// =============================================================================

describe('jsonSchemaTypeToTs', () => {
  it('converts primitive types', () => {
    expect(jsonSchemaTypeToTs({ type: 'string' })).toBe('string');
    expect(jsonSchemaTypeToTs({ type: 'number' })).toBe('number');
    expect(jsonSchemaTypeToTs({ type: 'boolean' })).toBe('boolean');
  });

  it('converts string enums', () => {
    expect(jsonSchemaTypeToTs({ type: 'string', enum: ['C', 'F'] })).toBe("'C' | 'F'");
  });

  it('converts arrays', () => {
    expect(jsonSchemaTypeToTs({ type: 'array', items: { type: 'string' } })).toBe('string[]');
  });

  it('converts object arrays', () => {
    const result = jsonSchemaTypeToTs({
      type: 'array',
      items: {
        type: 'object',
        properties: { day: { type: 'string' }, high: { type: 'number' } },
        required: ['day', 'high'],
      },
    });
    expect(result).toContain('Array<');
    expect(result).toContain('day: string');
    expect(result).toContain('high: number');
  });

  it('converts nested objects', () => {
    const result = jsonSchemaTypeToTs({
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
    });
    expect(result).toContain('name: string');
  });
});

// =============================================================================
// propsSpecToTypeScript
// =============================================================================

describe('propsSpecToTypeScript', () => {
  it('generates TypeScript interface with required/optional', () => {
    const spec: PropsSpec = {
      properties: {
        city: { description: 'City name', schema: { type: 'string' }, required: true },
        unit: { description: 'Temp unit', schema: { type: 'string' }, default: 'C' },
      },
    };
    const result = propsSpecToTypeScript(spec);
    expect(result).toContain('city: string;');
    expect(result).toContain('unit?: string;');
    expect(result).toContain('/** City name */');
    expect(result).toContain('// default: "C"');
  });
});

// =============================================================================
// inferPropsSpecFromSampleData
// =============================================================================

describe('inferPropsSpecFromSampleData', () => {
  it('infers basic types', () => {
    const spec = inferPropsSpecFromSampleData({ name: 'Tokyo', temp: 28, active: true });
    expect(spec.properties.name.schema.type).toBe('string');
    expect(spec.properties.temp.schema.type).toBe('number');
    expect(spec.properties.active.schema.type).toBe('boolean');
  });

  it('infers array with object items', () => {
    const spec = inferPropsSpecFromSampleData({
      items: [{ id: 1, name: 'A' }],
    });
    expect(spec.properties.items.schema.type).toBe('array');
    expect(spec.properties.items.schema.items?.type).toBe('object');
    expect(spec.properties.items.schema.items?.properties?.id.type).toBe('number');
  });

  it('marks all fields as required', () => {
    const spec = inferPropsSpecFromSampleData({ a: 1, b: 'x' });
    expect(spec.properties.a.required).toBe(true);
    expect(spec.properties.b.required).toBe(true);
  });

  it('stores example values', () => {
    const spec = inferPropsSpecFromSampleData({ city: 'Tokyo' });
    expect(spec.properties.city.example).toBe('Tokyo');
  });
});
