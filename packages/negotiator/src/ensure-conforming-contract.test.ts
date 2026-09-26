/**
 * `ensureConformingContract` — the forgiving-handshake core, pinned on
 * the booking-confirm draft ggui#1421 was found on (R&D's dev read on tag
 * 12: with a dangling `nextStep` the repaired card lost `confirm.oneShot`
 * and rendered with a local guard instead of the declared one).
 *
 * The bar: a repair keeps every action-entry member the draft declared
 * and changes only what the findings name; a member or entry it cannot
 * keep is dropped explicitly and NAMED in `findings`
 * (`REPAIR_MEMBER_DROPPED` / `REPAIR_ENTRY_DROPPED`). No LLM here — a
 * canned `LLMCaller` answers the repair tool with what the tool schema
 * can carry (`{label, schema}` per action), which is exactly the shape
 * that used to erase the declarations.
 */
import { describe, expect, it } from 'vitest';
import { lintContract } from '@ggui-ai/protocol';
import type { LLMCaller } from './llm-caller.js';
import { ensureConformingContract } from './ensure-conforming-contract.js';
import { REPAIR_ENTRY_DROPPED, REPAIR_MEMBER_DROPPED } from './preserve-action-members.js';

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

/** reliability/013's declared fixture, verbatim (the row's draft). */
const BOOKING = {
  propsSpec: {
    properties: {
      bookingId: { schema: { type: 'string' }, required: true, description: 'The reservation being confirmed' },
      restaurant: { schema: { type: 'string' }, required: true, description: 'Restaurant name' },
      neighbourhood: { schema: { type: 'string' }, required: false, description: 'Where the restaurant is' },
      date: { schema: { type: 'string' }, required: true, description: 'Booking date, already formatted for display' },
      time: { schema: { type: 'string' }, required: true, description: 'Booking time, already formatted for display' },
      partySize: { schema: { type: 'number' }, required: true, description: 'Number of guests' },
      table: { schema: { type: 'string' }, required: false, description: 'Table or area, e.g. "Window table"' },
      note: { schema: { type: 'string' }, required: false, description: 'A note the visitor left for the restaurant' },
      cancellation: { schema: { type: 'string' }, required: true, description: 'The cancellation terms, one line' },
    },
  },
  actionSpec: {
    confirm: {
      label: 'Confirm booking',
      description: 'Places the reservation. Once-only: a second confirm would place a second reservation.',
      oneShot: true,
      nextStep: 'booking_confirm',
      example: { bookingId: 'bk_7f3a' },
    },
    edit: {
      label: 'Change details',
      description: 'Reopen the booking details for editing; may be pressed any number of times',
      nextStep: 'booking_edit',
      example: { bookingId: 'bk_7f3a' },
    },
  },
};

const INTENT = 'Build a table-booking confirmation card for a restaurant.';

/** The repair tool's answer: the draft's props, and per action only what the tool schema carries. */
const REPAIRED_TOOL_INPUT = {
  propsSpec: {
    properties: Object.fromEntries(
      Object.entries(BOOKING.propsSpec.properties).map(([k, v]) => [k, { schema: v.schema, required: v.required }]),
    ),
  },
  actionSpec: {
    confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA },
    edit: { label: 'Change details', schema: EMPTY_SCHEMA },
  },
  reason: 'dropped the dangling nextStep hints',
};

function llmAnswering(answer: unknown | (() => unknown), calls: number[] = []): LLMCaller {
  return {
    async call() {
      throw new Error('text mode is not used by the repair');
    },
    async callStructured() {
      calls.push(1);
      return typeof answer === 'function' ? (answer as () => unknown)() : answer;
    },
  };
}

function llmThatMustNotBeCalled(): LLMCaller {
  return {
    async call() {
      throw new Error('LLM must not be called');
    },
    async callStructured() {
      throw new Error('LLM must not be called');
    },
  };
}

describe('ensureConformingContract — a repair keeps the draft’s action-entry members (ggui#1421)', () => {
  it('llm-repair on the dangling-nextStep draft: origin synth, confirm.oneShot kept, the only finding is the gate’s CTR_REF_NEXT_STEP', async () => {
    const calls: number[] = [];
    const result = await ensureConformingContract(
      { llm: llmAnswering(REPAIRED_TOOL_INPUT, calls) },
      { draft: BOOKING, intent: INTENT },
    );
    expect(result.contract).not.toBeNull();
    expect(result.origin).toBe('synth');
    expect(result.method).toBe('llm-repair');
    expect(calls).toHaveLength(1);
    const confirm = result.contract?.actionSpec?.['confirm'];
    expect(confirm).toMatchObject({
      label: 'Confirm booking',
      oneShot: true,
      description: 'Places the reservation. Once-only: a second confirm would place a second reservation.',
      example: { bookingId: 'bk_7f3a' },
    });
    expect(confirm).not.toHaveProperty('nextStep'); // under repair: the gate refused it on the draft
    expect(result.contract?.actionSpec?.['edit']).toMatchObject({ label: 'Change details', example: { bookingId: 'bk_7f3a' } });
    expect(result.contract?.actionSpec?.['edit']).not.toHaveProperty('oneShot');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_REF_NEXT_STEP', 'actionSpec.confirm.nextStep'],
      ['CTR_REF_NEXT_STEP', 'actionSpec.edit.nextStep'],
    ]);
    expect(lintContract(result.contract).errors).toEqual([]);
  });

  it('normalized (no LLM): a mechanical error beside a declared oneShot is fixed without losing the declaration', async () => {
    const draft = {
      ...BOOKING,
      propsSpec: { ...BOOKING.propsSpec, required: ['bookingId'] }, // stray wrapper key (the R1 class)
      actionSpec: {
        confirm: { label: 'Confirm booking', oneShot: true, description: 'Once-only.' },
        edit: { label: 'Change details' },
      },
    };
    const result = await ensureConformingContract({ llm: llmThatMustNotBeCalled() }, { draft, intent: INTENT });
    expect(result.method).toBe('normalized');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true, description: 'Once-only.' });
    expect(result.findings.map((f) => f.code)).toEqual(['CTR_SHAPE_UNRECOGNIZED_KEYS']);
  });

  it('llm-repair: a VALID nextStep the repair de-wired (toolbox not re-emitted) is dropped and named REPAIR_MEMBER_DROPPED', async () => {
    const draft = {
      ...BOOKING,
      agentCapabilities: { tools: { booking_edit: { toolInfo: { inputSchema: { type: 'object' } } } } },
    }; // confirm.nextStep still dangles; edit.nextStep is valid on the draft
    const result = await ensureConformingContract({ llm: llmAnswering(REPAIRED_TOOL_INPUT) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(result.contract?.actionSpec?.['edit']).not.toHaveProperty('nextStep');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_REF_NEXT_STEP', 'actionSpec.confirm.nextStep'],
      [REPAIR_MEMBER_DROPPED, 'actionSpec.edit.nextStep'],
    ]);
    expect(lintContract(result.contract).errors).toEqual([]);
  });

  it('llm-repair: an entry the repair renamed is named REPAIR_ENTRY_DROPPED, and the survivor keeps its members', async () => {
    const renamed = {
      ...REPAIRED_TOOL_INPUT,
      actionSpec: {
        confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA },
        changeDetails: { label: 'Change details', schema: EMPTY_SCHEMA },
      },
    };
    const result = await ensureConformingContract({ llm: llmAnswering(renamed) }, { draft: BOOKING, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(result.contract?.actionSpec?.['changeDetails']).toEqual({ label: 'Change details', schema: EMPTY_SCHEMA });
    expect(result.findings).toContainEqual(
      expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'actionSpec.edit' }),
    );
    expect(result.reasoning).toContain('dropped 1 declared action member/entry the repair could not keep (actionSpec.edit)');
  });

  it('salvaged-subset (LLM down): the conforming subset of the draft keeps confirm.oneShot', async () => {
    const result = await ensureConformingContract(
      { llm: llmAnswering(() => { throw new Error('provider down'); }) },
      { draft: BOOKING, intent: INTENT },
    );
    expect(result.method).toBe('salvaged-subset');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true, label: 'Confirm booking' });
    expect(result.contract?.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(result.findings.some((f) => f.path === 'actionSpec.confirm.nextStep')).toBe(true);
    expect(result.findings.some((f) => f.code === REPAIR_MEMBER_DROPPED)).toBe(false);
  });
});

describe('ensureConformingContract — the review’s edge cases (ggui#1421 amend)', () => {
  it('a draft with a mechanical shape error AND dangling nextSteps: every path the gate refused on either tree is in findings', async () => {
    const draft = { ...BOOKING, propsSpec: { ...BOOKING.propsSpec, required: ['bookingId'] } };
    const result = await ensureConformingContract({ llm: llmAnswering(REPAIRED_TOOL_INPUT) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(result.contract?.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_SHAPE_UNRECOGNIZED_KEYS', 'propsSpec'],
      ['CTR_REF_NEXT_STEP', 'actionSpec.confirm.nextStep'],
      ['CTR_REF_NEXT_STEP', 'actionSpec.edit.nextStep'],
    ]);
  });

  it('a member the loop’s own placement pass pruned with its entry is named once, as the entry, never as an orphan member', async () => {
    const draft = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      agentCapabilities: { tools: { bump: { toolInfo: { inputSchema: { type: 'object' } } } } },
      actionSpec: {
        increment: { label: 'Increment', nextStep: 'bump', oneShot: true, schema: EMPTY_SCHEMA },
        other: { label: 'Other', nextStep: 'missing_tool' },
      },
    };
    const answer = {
      contextSpec: { count: { schema: { type: 'number' }, default: 0 } },
      actionSpec: { increment: { label: 'Increment', schema: EMPTY_SCHEMA }, other: { label: 'Other', schema: EMPTY_SCHEMA } },
      reason: 'dropped the dangling hint',
    };
    const result = await ensureConformingContract({ llm: llmAnswering(answer) }, { draft, intent: 'A counter with an increment control' });
    expect(result.method).toBe('llm-repair');
    const paths = result.findings.map((f) => [f.code, f.path]);
    if (result.contract?.actionSpec?.['increment'] === undefined) {
      expect(paths).toContainEqual([REPAIR_ENTRY_DROPPED, 'actionSpec.increment']);
      expect(paths).not.toContainEqual([REPAIR_MEMBER_DROPPED, 'actionSpec.increment.nextStep']);
    } else {
      expect(paths).not.toContainEqual([REPAIR_ENTRY_DROPPED, 'actionSpec.increment']);
    }
  });

});

describe('ensureConformingContract — findings are attributed and never duplicated (ggui#1421 amend 2)', () => {
  it('an action the DRAFT’s own CTR_DUP_NAME refused and the repair removed: the gate names the collision, the repair names the removal — two findings, one path each', async () => {
    const draft = {
      propsSpec: BOOKING.propsSpec,
      contextSpec: { submit: { schema: { type: 'string' } } },
      actionSpec: { submit: { label: 'Submit', oneShot: true }, edit: { label: 'Change details' } },
    };
    const answer = {
      propsSpec: REPAIRED_TOOL_INPUT.propsSpec,
      contextSpec: { submit: { schema: { type: 'string' } } },
      actionSpec: { edit: { label: 'Change details', schema: EMPTY_SCHEMA } },
      reason: 'removed the colliding action',
    };
    const result = await ensureConformingContract({ llm: llmAnswering(answer) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_DUP_NAME', 'actionSpec.submit'],
      [REPAIR_ENTRY_DROPPED, 'actionSpec.submit'],
    ]);
    expect(result.findings[1]?.message).not.toMatch(/re-declare it via/);
    expect(result.reasoning).toMatch(/dropped 1 declared/);
  });

  it('salvaged-subset (LLM down): no (code, path) finding appears twice', async () => {
    const result = await ensureConformingContract(
      { llm: llmAnswering(() => { throw new Error('provider down'); }) },
      { draft: { ...BOOKING, propsSpec: { ...BOOKING.propsSpec, required: ['bookingId'] } }, intent: INTENT },
    );
    expect(result.method).toBe('salvaged-subset');
    const keys = result.findings.map((f) => `${f.code}@${f.path}`);
    expect(new Set(keys).size).toBe(keys.length);
    expect(keys).toContain('CTR_REF_NEXT_STEP@actionSpec.confirm.nextStep');
  });

  it('a draft-own dangling nextStep beside an in-entry shape error: the shape error keeps its gate code, the un-restored nextStep is named at its own path with the gate’s reason', async () => {
    const draft = {
      ...BOOKING,
      actionSpec: {
        confirm: { label: 'Confirm booking', oneShot: 'yes', nextStep: 'booking_confirm', schema: EMPTY_SCHEMA },
        edit: { label: 'Change details' },
      },
    };
    const result = await ensureConformingContract({ llm: llmAnswering(REPAIRED_TOOL_INPUT) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_SHAPE_INVALID_TYPE', 'actionSpec.confirm.oneShot'],
      [REPAIR_MEMBER_DROPPED, 'actionSpec.confirm.nextStep'],
    ]);
    expect(result.findings[1]?.message).toContain('CTR_REF_NEXT_STEP');
    expect(result.reasoning).toMatch(/dropped 1 declared/);
  });

  it('a draft whose `.schema` the gate refused and the repair RE-AUTHORED (still incompatible with its nextStep tool): the un-restored nextStep is named at its own path', async () => {
    const tool = { toolInfo: { inputSchema: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'], additionalProperties: false } } };
    const draft = {
      propsSpec: BOOKING.propsSpec,
      agentCapabilities: { tools: { booking_confirm: tool } },
      actionSpec: { confirm: { label: 'Confirm booking', oneShot: true, nextStep: 'booking_confirm', schema: { type: 'object', properties: { seat: { type: 'string' } } } } },
    };
    const answer = {
      propsSpec: REPAIRED_TOOL_INPUT.propsSpec,
      agentCapabilities: { tools: { booking_confirm: { inputSchema: tool.toolInfo.inputSchema } } },
      actionSpec: { confirm: { label: 'Confirm booking', schema: { type: 'object', properties: { note: { type: 'string' } } } } },
      reason: 're-authored the schema',
    };
    const result = await ensureConformingContract({ llm: llmAnswering(answer) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.contract?.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(result.contract?.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(result.findings.map((f) => [f.code, f.path])).toContainEqual([REPAIR_MEMBER_DROPPED, 'actionSpec.confirm.nextStep']);
  });

  it('an action the gate refused by name (CTR_DUP_NAME) that the repair RENAMED: the removed name is named REPAIR_ENTRY_DROPPED, so the oneShot it carried is never lost silently', async () => {
    const draft = {
      propsSpec: BOOKING.propsSpec,
      contextSpec: { submit: { schema: { type: 'string' } } },
      actionSpec: { submit: { label: 'Submit', oneShot: true, description: 'Once-only.' }, edit: { label: 'Change details' } },
    };
    const answer = {
      propsSpec: REPAIRED_TOOL_INPUT.propsSpec,
      contextSpec: { submit: { schema: { type: 'string' } } },
      actionSpec: { submitForm: { label: 'Submit', schema: EMPTY_SCHEMA }, edit: { label: 'Change details', schema: EMPTY_SCHEMA } },
      reason: 'renamed the colliding action',
    };
    const result = await ensureConformingContract({ llm: llmAnswering(answer) }, { draft, intent: INTENT });
    expect(result.method).toBe('llm-repair');
    expect(result.findings.map((f) => [f.code, f.path])).toEqual([
      ['CTR_DUP_NAME', 'actionSpec.submit'],
      [REPAIR_ENTRY_DROPPED, 'actionSpec.submit'],
    ]);
  });
});
