/**
 * ggui#1156 — the judge's half of "a cell arrived with a props-bearing draft and no
 * sampleProps", pinned where the report is WRITTEN (this file is the `report.json`
 * writer the serving runtime's bootstrap bar reads; that bar is the other end of the seam).
 *
 * Part 1: no sampleProps but the contract author declared examples → the judges render
 * the EXAMPLES. `propsSource` stays 'empty' (option 2 — no enum change on any reader);
 * the PRESENCE of `exampleFields` is the fact the bar derives `"empty+example"` from.
 * An example is not a synthesis: it is what the author said the data looks like.
 *
 * Part 2: no sampleProps AND no examples AND the contract renders props → nothing
 * could be rendered; `judgeable: false` is stamped and the bar's `draft_invalid` arm
 * reads it BEFORE any score meets the floor. The empty-state score is a reading about
 * the request, not the card. Invariant (a) — `judgeable === false ⇒ no judgeBelowBar`
 * — is enforced where that verdict is EMITTED (the serving runtime's bootstrap bar), not here:
 * this file emits no verdict, so a `describe` asserting it here would assert nothing.
 *
 * A props-LESS contract judged empty is judged CORRECTLY and must never read as
 * not-judgeable; a cell that carried its own sampleProps never carries exampleFields.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataContract } from '@ggui-ai/protocol';
import { readCellInputs, examplesFrom, contractRendersProps, type BootstrapJudgeInput } from './eval-cell';

const MINT = { cellId: 'c1', runId: 'r1', arm: 'B', model: 'openai/gpt-6-astra', codeHash: 'abc', latencyMs: 1234, generationTimeMs: 1200, turnsUsed: 2, passesUsed: 1, tokens: { input: 1000, output: 500 }, designMode: 'free', canvas: 'xs-chat-card', requested: { designMode: 'free', canvas: 'xs-chat-card' } };

/** A BOOTSTRAP cell (commitRef null) — prompt and optional sampleProps come from judge-input.json, exactly as the mint exports them. */
function bootstrapCell(contract: DataContract, judgeInput: BootstrapJudgeInput): string {
  const dir = mkdtempSync(join(tmpdir(), 'exp008-judgeable-'));
  writeFileSync(join(dir, 'compiled.js'), 'export default function C(){return null}');
  writeFileSync(join(dir, 'source.tsx'), 'export default function C(props){ return <div>{props.heading}</div> }');
  writeFileSync(join(dir, 'contract.json'), JSON.stringify({ contract, contractKey: 'k1', commitRef: null }));
  writeFileSync(join(dir, 'mint.json'), JSON.stringify(MINT));
  writeFileSync(join(dir, 'judge-input.json'), JSON.stringify(judgeInput));
  return dir;
}

/** The rep-fleet welcome shape WITH examples — the contract the ruling's part 1 reaches. */
const WITH_EXAMPLES: DataContract = {
  propsSpec: {
    properties: {
      heading: { schema: { type: 'string' }, required: true, example: 'Welcome to Northwind' },
      message: { schema: { type: 'string' }, required: true, example: 'Books kept current.' },
      quickReplies: { schema: { type: 'array', items: { type: 'object' } }, required: true, example: [{ id: 'a', label: 'Show invoices' }] },
    },
  },
  actionSpec: { chooseReply: { label: 'Choose' } },
};

/** The rep-fleet shape as it actually ships — the same props, NO examples (the fifteen that failed 15/15). */
const WITHOUT_EXAMPLES: DataContract = {
  propsSpec: {
    properties: {
      heading: { schema: { type: 'string' }, required: true, description: 'The heading' },
      message: { schema: { type: 'string' }, required: true, description: 'One line' },
      quickReplies: { schema: { type: 'array', items: { type: 'object' } }, required: true, description: 'Three replies' },
    },
  },
  actionSpec: { chooseReply: { label: 'Choose' } },
};

/** A card that renders no props at all — a pure action surface. */
const NO_PROPS: DataContract = { actionSpec: { save: { label: 'Save' } } };

describe('examplesFrom / contractRendersProps (the two derivations the writer rests on)', () => {
  it('collects exactly the properties that carry an example, in declaration order, as the props to render with', () => {
    const ex = examplesFrom(WITH_EXAMPLES);
    expect(ex?.fields).toEqual(['heading', 'message', 'quickReplies']);
    expect(ex?.props).toEqual({ heading: 'Welcome to Northwind', message: 'Books kept current.', quickReplies: [{ id: 'a', label: 'Show invoices' }] });
  });
  it('returns undefined when no property carries an example — never an empty object that would read as "props"', () => {
    expect(examplesFrom(WITHOUT_EXAMPLES)).toBeUndefined();
    expect(examplesFrom(NO_PROPS)).toBeUndefined();
  });
  it('a contract renders props iff its propsSpec declares any', () => {
    expect(contractRendersProps(WITH_EXAMPLES)).toBe(true);
    expect(contractRendersProps(WITHOUT_EXAMPLES)).toBe(true);
    expect(contractRendersProps(NO_PROPS)).toBe(false);
  });
});

describe('readCellInputs — part 1: no sampleProps, examples present ⇒ judged on the examples', () => {
  const inputs = readCellInputs(bootstrapCell(WITH_EXAMPLES, { prompt: 'a welcome card' }));
  it("propsSource STAYS 'empty' (no reader's enum changes) and the presence of exampleFields is the fact", () => {
    expect(inputs.propsSource).toBe('empty');
    expect(inputs.exampleFields).toEqual(['heading', 'message', 'quickReplies']);
    expect(inputs.judgeable).toBe(true);
  });
  it('the judges render the author\'s examples as sampleProps', () => {
    expect(inputs.sampleProps).toEqual({ heading: 'Welcome to Northwind', message: 'Books kept current.', quickReplies: [{ id: 'a', label: 'Show invoices' }] });
  });
  it('INVARIANT (b): every exampleFields entry has an `example` on the contract — the receipt cannot name a field the author never exemplified', () => {
    for (const f of inputs.exampleFields ?? []) {
      expect(WITH_EXAMPLES.propsSpec?.properties[f]?.example, f).toBeDefined();
    }
  });
});

describe('readCellInputs — part 2: no sampleProps, no examples, a props-bearing contract ⇒ NOT judgeable', () => {
  const inputs = readCellInputs(bootstrapCell(WITHOUT_EXAMPLES, { prompt: 'a welcome card' }));
  it('judgeable is false, nothing is rendered, and no exampleFields are claimed', () => {
    expect(inputs.judgeable).toBe(false);
    expect(inputs.propsSource).toBe('empty');
    expect(inputs.sampleProps).toBeUndefined();
    expect(inputs.exampleFields).toBeUndefined();
  });
});

describe('readCellInputs — the two cases that must NOT read as not-judgeable', () => {
  it('a props-LESS contract judged empty is judged correctly', () => {
    const inputs = readCellInputs(bootstrapCell(NO_PROPS, { prompt: 'a save button' }));
    expect(inputs.propsSource).toBe('empty');
    expect(inputs.judgeable).toBe(true);
    expect(inputs.exampleFields).toBeUndefined();
  });
  it("a cell that carried its own sampleProps is 'cell' and never carries exampleFields, even when the contract has examples too", () => {
    const inputs = readCellInputs(bootstrapCell(WITH_EXAMPLES, { prompt: 'a welcome card', sampleProps: { heading: 'Hi', message: 'Live copy', quickReplies: [] } }));
    expect(inputs.propsSource).toBe('cell');
    expect(inputs.sampleProps).toEqual({ heading: 'Hi', message: 'Live copy', quickReplies: [] });
    expect(inputs.exampleFields).toBeUndefined();
    expect(inputs.judgeable).toBe(true);
  });
});
