import { describe, it, expect } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { PROTOCOL_VERSION } from '@ggui-ai/protocol';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { gateImportedBlueprint, type GateInput, type ImportGateCtx } from './import-gate.js';

const contract: DataContract = {
  propsSpec: { properties: { title: { schema: { type: 'string' } } } },
};

const ctx: ImportGateCtx = { protocolVersion: PROTOCOL_VERSION, catalog: {} };

describe('gateImportedBlueprint', () => {
  it('(a) accepts a matching generator era + empty catalog', () => {
    const input: GateInput = { contract, generatorProtocolVersion: PROTOCOL_VERSION };
    const result = gateImportedBlueprint(input, ctx);
    expect(result.ok).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it('(b) rejects a generator-era mismatch', () => {
    const input: GateInput = { contract, generatorProtocolVersion: 'draft-1900-01-01' };
    const result = gateImportedBlueprint(input, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/generator/);
  });

  it('(c) rejects a contract carrying a retired field', () => {
    const retired = {
      ...contract,
      wiredTools: { foo: { name: 'foo' } },
    } as unknown as DataContract;
    const input: GateInput = { contract: retired, generatorProtocolVersion: PROTOCOL_VERSION };
    const result = gateImportedBlueprint(input, ctx);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/retired/);
  });

  it('(d) accepts an unstamped CATALOG hash with a warning (the era stamp itself is required upstream)', () => {
    // The old "unstamped generatorProtocolVersion → warn" arm is gone:
    // fromPortableBlueprint hard-rejects unstamped records, so GateInput
    // requires the stamp. The only remaining unstamped-with-warning case
    // is the catalog hash (offline export cannot compute one).
    const input: GateInput = { contract, generatorProtocolVersion: PROTOCOL_VERSION };
    const result = gateImportedBlueprint(input, ctx);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /unstamped catalog hash/.test(w))).toBe(true);
  });

  it('(e) rejects a shipped catalog hash that diverges AND a contractHash that does not match the recompute', () => {
    // Catalog whose hash will NOT equal the artifact's shipped hash, and a
    // shipped contractHash that does NOT equal the recomputed key → the
    // tool-identity divergence would silently mis-key, so it is rejected.
    const populatedCtx: ImportGateCtx = {
      protocolVersion: PROTOCOL_VERSION,
      catalog: { my_tool: { name: '@org/my-server' } },
    };
    const input: GateInput = {
      contract,
      contractHash: 'not-the-real-key',
      generatorProtocolVersion: PROTOCOL_VERSION,
      toolIdentityCatalogHash: 'a-shipped-hash-that-differs',
    };
    const result = gateImportedBlueprint(input, populatedCtx);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/catalog/);
  });

  it('(e-pass) accepts when the catalog hash differs but the recomputed key still matches the shipped contractHash', () => {
    // Empty catalog → canonicalize is a no-op → recomputed key == blueprintKey(contract).
    // Ship that exact contractHash but a divergent catalog hash → accepted (warning).
    const input: GateInput = {
      contract,
      contractHash: blueprintKey(contract),
      generatorProtocolVersion: PROTOCOL_VERSION,
      toolIdentityCatalogHash: 'a-shipped-hash-that-differs',
    };
    const result = gateImportedBlueprint(input, ctx);
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => /catalog hash differs/.test(w))).toBe(true);
  });
});
