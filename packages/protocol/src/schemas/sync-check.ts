#!/usr/bin/env tsx
/* eslint-disable no-console */
/**
 * Schema Sync Check
 *
 * Verifies that Zod schemas and TypeScript types define the same fields.
 * Run: pnpm --filter @ggui-ai/protocol sync-check
 *
 * Exits with code 1 if any fields are out of sync.
 */

import { blueprintDraftObjectSchema } from './handshake-suggestion';

// Extract Zod field names from schema .shape
function zodKeys(schema: { shape: Record<string, unknown> }): string[] {
  return Object.keys(schema.shape).sort();
}

// Expected TypeScript type fields (manually listed — single maintenance point)
// If you add a field to the TypeScript type, add it here too.

// BlueprintDraft fields — agent's draft on the handshake input.
const BLUEPRINT_DRAFT_KEYS = [
  'contract',
  'variance',
  'generator',
].sort();

function diff(zodFields: string[], tsFields: string[]): { inZodOnly: string[]; inTsOnly: string[] } {
  const zodSet = new Set(zodFields);
  const tsSet = new Set(tsFields);
  return {
    inZodOnly: zodFields.filter((k) => !tsSet.has(k)),
    inTsOnly: tsFields.filter((k) => !zodSet.has(k)),
  };
}

let failed = false;

function check(name: string, schema: { shape: Record<string, unknown> }, tsKeys: string[]) {
  const zKeys = zodKeys(schema);
  const { inZodOnly, inTsOnly } = diff(zKeys, tsKeys);

  if (inZodOnly.length === 0 && inTsOnly.length === 0) {
    console.log(`  ✓ ${name}: ${zKeys.length} fields in sync`);
  } else {
    console.log(`  ✗ ${name}: OUT OF SYNC`);
    if (inZodOnly.length > 0) console.log(`    In Zod but not TypeScript: ${inZodOnly.join(', ')}`);
    if (inTsOnly.length > 0) console.log(`    In TypeScript but not Zod: ${inTsOnly.join(', ')}`);
    failed = true;
  }
}

// handshakeInputSchema / renderInputSchema are flat top-level shapes — z.infer
// derives the TS type directly so they stay in sync structurally without a
// keylist double-bookkeeping. Sub-schemas (blueprintDraft) are checked here.
console.log('\nSchema Sync Check\n');
// `BlueprintDraft` lives at the inner `.shape` of the zod object wrapper.
check('BlueprintDraft', blueprintDraftObjectSchema, BLUEPRINT_DRAFT_KEYS);
console.log('');

if (failed) {
  console.log('Fix: update both packages/protocol/src/schemas/handshake-suggestion.ts AND packages/protocol/src/types/handshake-suggestion.ts\n');
  console.log('');
}

if (failed) process.exit(1);
