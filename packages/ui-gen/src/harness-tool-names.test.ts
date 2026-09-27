import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { classifyAxes } from './classifier/index.js';
import { createHarness } from './create-harness.js';
import { DESIGN_MODES } from './design-mode.js';
import { HARNESS_CODING_TOOLS, HARNESS_SCOPED_TOOLS, harnessToolEntry, harnessToolNames } from './harness-tool-names.js';
import type { LLMToolDef } from './llm.js';

const contract: DataContract = {
  propsSpec: { properties: { title: { required: true, schema: { type: 'string' } } } },
  actionSpec: { save: { label: 'Save' } },
};
const prompt = 'a note editor with a save button';
const classification = classifyAxes({ contract, prompt });
const ENTRY = /^[a-z][a-z0-9_]*@[0-9a-f]{8}$/;
const digestOf = (def: LLMToolDef): string => createHash('sha256').update(JSON.stringify(def), 'utf8').digest('hex').slice(0, 8);

describe('harnessToolNames — the coding loop\'s tool set as `<name>@<definition digest>` entries, from the one list the harness is built from', () => {
  it('an entry is the tool\'s own name and the first 8 hex of sha256 over JSON.stringify of its definition', () => {
    for (const def of [...HARNESS_CODING_TOOLS, ...HARNESS_SCOPED_TOOLS]) {
      expect(harnessToolEntry(def)).toBe(`${def.name}@${digestOf(def)}`);
      expect(harnessToolEntry(def)).toMatch(ENTRY);
    }
  });

  it('equals the sorted, de-duplicated entries of the coding AND scoped tools createHarness actually declares, for every design mode — the scoped set runs on the duplicate-fingerprint escape, so it is part of what runs', () => {
    for (const designMode of DESIGN_MODES) {
      const harness = createHarness({ classification, contract, prompt, shellType: 'chat', screen: 'mobile', designMode });
      const declared = [...new Set([...harness.what.codingTools, ...(harness.what.scopedTools ?? [])].map(harnessToolEntry))].sort();
      expect(harnessToolNames(designMode), designMode).toEqual(declared);
      expect(harness.what.scopedTools?.length ?? 0, `${designMode} declares a scoped set`).toBeGreaterThan(0);
    }
  });

  it('two definitions that share a name are two entries — the scoped variant of a tool keeps its name and narrows its grammar', () => {
    const entries = harnessToolNames('constrained');
    const applyChanges = entries.filter((e) => e.startsWith('apply_changes@'));
    expect(applyChanges).toHaveLength(2);
    expect(new Set(applyChanges).size).toBe(2);
  });

  it('a change to a definition\'s schema OR description moves its entry — the description is prompt text, as output-changing as a template', () => {
    const [def] = HARNESS_CODING_TOOLS;
    if (def === undefined) throw new Error('no coding tool');
    expect(harnessToolEntry({ ...def, description: `${def.description} (reworded)` })).not.toBe(harnessToolEntry(def));
    expect(harnessToolEntry({ ...def, parameters: { ...def.parameters, required: [] } })).not.toBe(harnessToolEntry(def));
    expect(harnessToolEntry({ ...def })).toBe(harnessToolEntry(def));
  });

  it('is sorted, non-empty and a fresh array each call — callers cannot mutate the source', () => {
    for (const designMode of DESIGN_MODES) {
      const names = harnessToolNames(designMode);
      expect(names.length, designMode).toBeGreaterThan(0);
      expect([...names].sort(), designMode).toEqual([...names]);
      expect(names, designMode).not.toBe(harnessToolNames(designMode));
    }
  });
});
