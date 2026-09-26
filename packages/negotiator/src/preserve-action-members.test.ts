/**
 * Action-entry member preservation (ggui#1421) — pure pins.
 *
 * The repair tool authors `{label, schema}` per action; every other
 * member of an action entry is the AGENT's declaration (oneShot above
 * all — the one-shot guard is declared, never inferred). These pins hold
 * the overlay that puts those declarations back on a repaired candidate,
 * and the two findings that name what could not be kept.
 */
import { describe, expect, it } from 'vitest';
import { actionEntrySchema, lintContract, type AgentToolEntry, type DataContract } from '@ggui-ai/protocol';
import {
  findDroppedActionEntries,
  isMemberDropOf,
  REPAIR_ENTRY_DROPPED,
  REPAIR_MEMBER_DROPPED,
  restoreDraftActionMembers,
} from './preserve-action-members.js';

const EMPTY_SCHEMA = { type: 'object', properties: {}, additionalProperties: false } as const;

const DRAFT = {
  propsSpec: { properties: { booking: { schema: { type: 'object' }, required: true } } },
  agentCapabilities: { tools: { booking_edit: { toolInfo: { inputSchema: { type: 'object' } } } } },
  actionSpec: {
    confirm: {
      label: 'Confirm booking',
      description: 'Places the reservation. Once-only.',
      example: { bookingId: 'bk_7f3a' },
      icon: 'check',
      confirm: true,
      oneShot: true,
      nextStep: 'booking_confirm', // dangling: no such tool declared
      schema: { type: 'object', properties: { bookingId: { type: 'string' } } },
    },
    edit: {
      label: 'Change details',
      description: 'Reopen the booking details for editing',
      nextStep: 'booking_edit', // valid in the draft
      schema: EMPTY_SCHEMA,
    },
  },
};

/** What the repair tool can author: label + schema only, toolbox gone. */
const CANDIDATE: DataContract = {
  propsSpec: { properties: { booking: { schema: { type: 'object' }, required: true } } },
  actionSpec: {
    confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA },
    edit: { label: 'Change details', schema: EMPTY_SCHEMA },
  },
};

describe('restoreDraftActionMembers', () => {
  it('restores every declared member the candidate lacks; the candidate keeps label and schema', () => {
    const { contract, dropped } = restoreDraftActionMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm.nextStep']));
    const confirm = contract.actionSpec?.['confirm'];
    expect(confirm).toMatchObject({
      label: 'Confirm booking',
      schema: EMPTY_SCHEMA, // the candidate's, not the draft's
      description: 'Places the reservation. Once-only.',
      example: { bookingId: 'bk_7f3a' },
      icon: 'check',
      confirm: true,
      oneShot: true,
    });
    // the member under repair is NOT restored, and its absence is the gate's own finding, not ours
    expect(confirm).not.toHaveProperty('nextStep');
    expect(dropped.filter((f) => f.path.startsWith('actionSpec.confirm'))).toEqual([]);
  });

  it('a restored member the gate refuses on the merged contract is un-restored and named REPAIR_MEMBER_DROPPED', () => {
    // edit.nextStep is valid on the DRAFT (booking_edit is declared there) but the
    // candidate carries no toolbox, so restoring it would dangle: drop it, name it.
    const { contract, dropped } = restoreDraftActionMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm.nextStep']));
    expect(contract.actionSpec?.['edit']).not.toHaveProperty('nextStep');
    expect(contract.actionSpec?.['edit']).toMatchObject({ description: 'Reopen the booking details for editing' });
    expect(dropped).toEqual([
      expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, severity: 'error', path: 'actionSpec.edit.nextStep' }),
    ]);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('the member list is the protocol schema minus the pair the repair authors (cannot drift)', () => {
    const declared = Object.keys(actionEntrySchema.shape).filter((k) => k !== 'label' && k !== 'schema');
    const draft = {
      actionSpec: { go: Object.fromEntries([['label', 'Go'], ...declared.map((k) => [k, k === 'nextStep' ? 't' : k === 'oneShot' || k === 'confirm' ? true : 'x'])]) },
      agentCapabilities: { tools: { t: { toolInfo: { inputSchema: { type: 'object' } } } } },
    };
    const candidate: DataContract = {
      actionSpec: { go: { label: 'Go', schema: EMPTY_SCHEMA } },
      agentCapabilities: { tools: { t: { toolInfo: { inputSchema: { type: 'object' } } } } },
    };
    const { contract, dropped } = restoreDraftActionMembers(draft, candidate, new Set());
    expect(Object.keys(contract.actionSpec?.['go'] ?? {}).sort()).toEqual([...declared, 'label', 'schema'].sort());
    expect(dropped).toEqual([]);
  });

  it('an entry the candidate renamed or removed gets nothing back here (entry-level loss is findDroppedActionEntries’s)', () => {
    const candidate: DataContract = { actionSpec: { confirmBooking: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftActionMembers(DRAFT, candidate, new Set());
    expect(contract).toEqual(candidate);
    expect(dropped).toEqual([]);
  });

  it('a draft without a record actionSpec, or a candidate without one, returns the candidate untouched', () => {
    expect(restoreDraftActionMembers('not a draft', CANDIDATE, new Set())).toEqual({ contract: CANDIDATE, dropped: [] });
    expect(restoreDraftActionMembers({ propsSpec: {} }, CANDIDATE, new Set())).toEqual({ contract: CANDIDATE, dropped: [] });
    const noActions: DataContract = { propsSpec: { properties: {} } };
    expect(restoreDraftActionMembers(DRAFT, noActions, new Set())).toEqual({ contract: noActions, dropped: [] });
  });
});

describe('findDroppedActionEntries', () => {
  it('names each draft action entry the candidate no longer carries, once, at its entry path', () => {
    const candidate: DataContract = { actionSpec: { confirmBooking: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    expect(findDroppedActionEntries(DRAFT, candidate, new Set())).toEqual([
      expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'actionSpec.confirm' }),
      expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'actionSpec.edit' }),
    ]);
  });

  it('is empty when every draft entry survives, and for drafts that declare no actions', () => {
    expect(findDroppedActionEntries(DRAFT, CANDIDATE, new Set())).toEqual([]);
    expect(findDroppedActionEntries({ propsSpec: {} }, CANDIDATE, new Set())).toEqual([]);
    expect(findDroppedActionEntries(undefined, CANDIDATE, new Set())).toEqual([]);
  });
});

describe('restoreDraftActionMembers — the review’s edge cases (ggui#1421 amend)', () => {
  const TOOL: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'] } } };

  it('never throws on a malformed candidate entry (no label): that entry is left un-overlaid for the loop’s own gate', () => {
    const candidate = { actionSpec: { confirm: { schema: EMPTY_SCHEMA } } } as unknown as DataContract;
    const { contract, dropped } = restoreDraftActionMembers(DRAFT, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).toEqual({ schema: EMPTY_SCHEMA });
    expect(dropped).toEqual([]);
  });

  it('a draft finding at the ENTRY path (CTR_DUP_NAME / CTR_RESERVED_NAME) does not withhold the entry’s members', () => {
    const { contract, dropped } = restoreDraftActionMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm', 'actionSpec.confirm.nextStep']));
    expect(contract.actionSpec?.['confirm']).toMatchObject({ oneShot: true, confirm: true, icon: 'check' });
    expect(dropped.filter((f) => f.path.startsWith('actionSpec.confirm'))).toEqual([]);
  });

  it('a restored nextStep that surfaces as CTR_SCHEMA_INCOMPAT at the sibling `.schema` is un-restored and named, and the contract lints clean', () => {
    const draft = {
      agentCapabilities: { tools: { booking_confirm: TOOL } },
      actionSpec: { confirm: { label: 'Confirm booking', oneShot: true, nextStep: 'booking_confirm' } },
    };
    // The repair re-declared the tool but re-authored an action schema that is not a subset of its input.
    const candidate: DataContract = {
      agentCapabilities: { tools: { booking_confirm: TOOL } },
      actionSpec: { confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA } },
    };
    expect(lintContract(candidate).errors).toEqual([]);
    const { contract, dropped } = restoreDraftActionMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, path: 'actionSpec.confirm.nextStep' })]);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('an action name containing a dot is still un-restored at its exact path', () => {
    const draft = { actionSpec: { 'a.b': { label: 'Dotted', oneShot: true, nextStep: 'missing_tool' } } };
    const candidate: DataContract = { actionSpec: { 'a.b': { label: 'Dotted', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftActionMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['a.b']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['a.b']).not.toHaveProperty('nextStep');
    expect(dropped.map((f) => f.path)).toEqual(['actionSpec.a.b.nextStep']);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('a restored nextStep the gate refuses is named at ITS OWN path, and the reason carries the gate’s code (a dangling reference the draft itself declared)', () => {
    const draft = { actionSpec: { confirm: { label: 'Confirm booking', oneShot: true, nextStep: 'booking_confirm' } } };
    const candidate: DataContract = { actionSpec: { confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftActionMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, severity: 'error', path: 'actionSpec.confirm.nextStep' })]);
    expect(dropped[0]?.message).toContain('CTR_REF_NEXT_STEP');
  });

  it('findDroppedActionEntries names a removed action whose name shadows Object.prototype', () => {
    const draft = { actionSpec: { toString: { label: 'Stringify', oneShot: true }, keep: { label: 'Keep' } } };
    const candidate: DataContract = { actionSpec: { keep: { label: 'Keep', schema: EMPTY_SCHEMA } } };
    expect(findDroppedActionEntries(draft, candidate, new Set()).map((f) => f.path)).toEqual(['actionSpec.toString']);
  });
});

describe('attribution at the entry and sibling paths (ggui#1421 amend 2)', () => {
  it('findDroppedActionEntries names an entry the gate refused by name and the repair removed or renamed — at its path, saying the name was refused, never “re-declare it”', () => {
    const draft = { contextSpec: { submit: { schema: { type: 'string' } } }, actionSpec: { submit: { label: 'Submit', oneShot: true }, keep: { label: 'Keep' } } };
    const candidate: DataContract = { contextSpec: { submit: { schema: { type: 'string' } } }, actionSpec: { keep: { label: 'Keep', schema: EMPTY_SCHEMA } } };
    const refused = findDroppedActionEntries(draft, candidate, new Set(['actionSpec.submit']));
    expect(refused.map((f) => [f.code, f.path])).toEqual([[REPAIR_ENTRY_DROPPED, 'actionSpec.submit']]);
    expect(refused[0]?.message).toMatch(/refused/);
    expect(refused[0]?.message).not.toMatch(/re-declare it via/);
    const dropped = findDroppedActionEntries(draft, candidate, new Set());
    expect(dropped[0]?.message).toMatch(/re-declare it via/);
  });

  it('a nextStep un-restored because the sibling `.schema` is incompatible — the draft’s own or the repair’s re-authoring — is named at the nextStep’s own path with the gate’s reason', () => {
    const TOOL: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'] } } };
    const draft = {
      agentCapabilities: { tools: { booking_confirm: TOOL } },
      actionSpec: { confirm: { label: 'Confirm booking', oneShot: true, nextStep: 'booking_confirm', schema: EMPTY_SCHEMA } },
    };
    const candidate: DataContract = {
      agentCapabilities: { tools: { booking_confirm: TOOL } },
      actionSpec: { confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA } }, // the model kept the draft's schema
    };
    const { contract, dropped } = restoreDraftActionMembers(draft, candidate, new Set(['actionSpec.confirm.schema']));
    expect(contract.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, path: 'actionSpec.confirm.nextStep' })]);
    expect(dropped[0]?.message).toContain('CTR_SCHEMA_INCOMPAT');
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('isMemberDropOf matches a member drop to its entry exactly, never by dotted prefix', () => {
    const drop = { code: REPAIR_MEMBER_DROPPED, severity: 'error' as const, path: 'actionSpec.a.b.nextStep', message: '' };
    expect(isMemberDropOf(drop, ['a.b'])).toBe(true);
    expect(isMemberDropOf(drop, ['a'])).toBe(false);
    expect(isMemberDropOf({ ...drop, path: 'actionSpec.a.nextStep' }, ['a'])).toBe(true);
  });
});
