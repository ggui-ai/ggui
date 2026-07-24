import { describe, it, expect } from 'vitest';
import {
  toPortableBlueprint,
  fromPortableBlueprint,
  PORTABLE_BLUEPRINT_SCHEMA_VERSION,
  PORTABLE_BLUEPRINT_V1_REJECTION,
  type PortableBlueprintSource,
} from './portable-blueprint.js';
import { blueprintKey, variantKey } from './blueprint-key.js';
import { PROTOCOL_VERSION } from '../version.js';
import type { DataContract } from '../types/data-contract.js';

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};

const src: PortableBlueprintSource = {
  contract,
  componentCode: 'export default function C(){return null}',
  variance: { persona: 'minimal' },
  source: { kind: 'llm', generator: 'ui-gen-default', model: 'test-model-1' },
};

describe('toPortableBlueprint', () => {
  it('computes canonical keys and stamps schemaVersion 2 + provenance', () => {
    const p = toPortableBlueprint(src);
    expect(p.schemaVersion).toBe(PORTABLE_BLUEPRINT_SCHEMA_VERSION);
    expect(p.schemaVersion).toBe(2);
    expect(p.contractHash).toBe(blueprintKey(contract));
    expect(p.variantKey).toBe(variantKey({ persona: 'minimal' }));
    expect(p.componentCode).toBe(src.componentCode);
    expect(p.source).toEqual({
      kind: 'llm',
      generator: 'ui-gen-default',
      model: 'test-model-1',
    });
    expect(p.generatorProtocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('is deterministic across calls (portable identity)', () => {
    expect(toPortableBlueprint(src).contractHash).toBe(
      toPortableBlueprint({ ...src, contract: { ...contract } }).contractHash,
    );
  });

  it('carries intent when the source has one, omits it when absent/empty', () => {
    expect(toPortableBlueprint({ ...src, intent: 'todo list with filters' }).intent).toBe(
      'todo list with filters',
    );
    expect('intent' in toPortableBlueprint(src)).toBe(false);
    expect('intent' in toPortableBlueprint({ ...src, intent: '' })).toBe(false);
  });
});

describe('fromPortableBlueprint', () => {
  it('round-trips an untampered record (ok, no mismatch)', () => {
    const result = fromPortableBlueprint(toPortableBlueprint(src));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyMismatch).toBe(false);
    expect(result.record.contract).toEqual(contract);
    expect(result.record.componentCode).toBe(src.componentCode);
    expect(result.record.source).toEqual(src.source);
    expect(result.record.generatorProtocolVersion).toBe(PROTOCOL_VERSION);
  });

  it('round-trips intent and rejects a malformed one', () => {
    const withIntent = fromPortableBlueprint(
      toPortableBlueprint({ ...src, intent: 'todo list with filters' }),
    );
    expect(withIntent.ok).toBe(true);
    if (withIntent.ok) {
      expect(withIntent.record.intent).toBe('todo list with filters');
    }
    // Absent intent stays absent through the canonical rebuild.
    const without = fromPortableBlueprint(toPortableBlueprint(src));
    expect(without.ok).toBe(true);
    if (without.ok) expect('intent' in without.record).toBe(false);
    // Present-but-empty (or non-string) is malformed, not tolerated.
    const empty = fromPortableBlueprint({ ...toPortableBlueprint(src), intent: '' });
    expect(empty.ok).toBe(false);
    const nonString = fromPortableBlueprint({ ...toPortableBlueprint(src), intent: 42 });
    expect(nonString.ok).toBe(false);
  });

  it('recomputes keys and flags shipped-key mismatch', () => {
    const tampered = { ...toPortableBlueprint(src), contractHash: 'deadbeefdeadbeef' };
    const result = fromPortableBlueprint(tampered);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.keyMismatch).toBe(true); // recompute wins, mismatch surfaced
  });

  it('rejects a schemaVersion-1 artifact with the re-export message', () => {
    const v1 = {
      schemaVersion: 1,
      contract,
      componentCode: src.componentCode,
      variance: src.variance,
      contractHash: blueprintKey(contract),
      variantKey: variantKey(src.variance),
      generatorProtocolVersion: PROTOCOL_VERSION,
    };
    const result = fromPortableBlueprint(v1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe(PORTABLE_BLUEPRINT_V1_REJECTION);
  });

  it('rejects unknown schema versions', () => {
    const result = fromPortableBlueprint({ ...toPortableBlueprint(src), schemaVersion: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('unsupported PortableBlueprint schemaVersion');
  });

  it('rejects a record missing source provenance', () => {
    const { source: _dropped, ...withoutSource } = toPortableBlueprint(src);
    const result = fromPortableBlueprint(withoutSource);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('source');
  });

  it('rejects an llm-sourced record missing generator/model', () => {
    const result = fromPortableBlueprint({
      ...toPortableBlueprint(src),
      source: { kind: 'llm', generator: 'ui-gen-default' },
    });
    expect(result.ok).toBe(false);
  });

  it('rejects a record missing generatorProtocolVersion', () => {
    const { generatorProtocolVersion: _dropped, ...withoutEra } = toPortableBlueprint(src);
    const result = fromPortableBlueprint(withoutEra);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toContain('generatorProtocolVersion');
  });

  it('rejects non-object input', () => {
    expect(fromPortableBlueprint('not a record').ok).toBe(false);
    expect(fromPortableBlueprint(null).ok).toBe(false);
    expect(fromPortableBlueprint([toPortableBlueprint(src)]).ok).toBe(false);
  });

  it('drops stray keys via canonical rebuild', () => {
    const result = fromPortableBlueprint({
      ...toPortableBlueprint(src),
      strayKey: 'should not survive',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.record).not.toHaveProperty('strayKey');
  });
});
