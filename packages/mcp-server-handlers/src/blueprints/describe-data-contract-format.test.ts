/**
 * Drift pins for the DataContract format doc (ggui#523 item 4) — the
 * teaching an agent reads MUST say what the validators enforce. Each
 * pin names the drift it closed; a future divergence fails here, not
 * in an agent's bisect.
 */
import { describe, expect, it } from 'vitest';
import {
  RETIRED_CONTRACT_FIELDS,
  actionEntrySchema,
  lintContract,
} from '@ggui-ai/protocol';
import { createDescribeDataContractFormatHandler } from './describe-data-contract-format.js';

async function documentation(): Promise<string> {
  const out = await createDescribeDataContractFormatHandler().handler({}, { appId: 'a', requestId: 'r' });
  return out.documentation;
}

describe('ggui_protocol_describe_data_contract_format — teaching matches the gate', () => {
  it('documents actionSpec[*].label as REQUIRED, which is what the schema enforces', async () => {
    const doc = await documentation();
    expect(doc).toContain('label: string;');
    expect(doc).not.toContain('label?: string;');
    // The gate agrees: an action without a label fails the wrapper shape.
    expect(actionEntrySchema.safeParse({ schema: { type: 'object' } }).success).toBe(false);
    expect(actionEntrySchema.safeParse({ label: 'Go', schema: { type: 'object' } }).success).toBe(true);
  });

  it('documents propsSpec.properties[*].required as OPT-IN (required only when `true`), which is what the props gate applies', async () => {
    const doc = await documentation();
    expect(doc).toContain('required at the wire gate ONLY when `true`; omitted ⇒ optional');
    expect(doc).not.toContain('// default true');
    // The gate agrees: an omitted `required` does not make the prop required.
    const contract = {
      propsSpec: { properties: { title: { schema: { type: 'string' } } } },
    };
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('lists every retired top-level field from the protocol constant — derived, not retyped', async () => {
    const doc = await documentation();
    for (const [field, replacement] of Object.entries(RETIRED_CONTRACT_FIELDS)) {
      expect(doc).toContain(`- \`${field}\` → \`${replacement}\``);
    }
    expect(doc).toContain('Retired top-level fields (hard errors)');
    // And the gate really rejects one.
    expect(lintContract({ libraries: ['x'] }).errors.some((e) => e.code === 'CTR_RETIRED_FIELD')).toBe(true);
  });

  it('teaches the gate rules BEFORE render — wrapper shape, schema compile, references, schema compat, reserved channels', async () => {
    const doc = await documentation();
    expect(doc).toContain('What the contract gate checks (handshake AND render, same gate)');
    for (const rule of ['Wrapper shape', 'Inner schemas compile', 'References resolve', 'Schema compat', 'Reserved channels']) {
      expect(doc).toContain(`**${rule}**`);
    }
    expect(doc).toContain('`_ggui:` prefix');
  });
});
