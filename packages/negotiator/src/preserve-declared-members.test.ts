/**
 * Declared-member preservation (ggui#1421 for actions, ggui#1430 for every
 * spec) — pure pins.
 *
 * The repair tool authors a few members per entry (`label`/`schema` on an
 * action, `schema`/`required` on a prop, `schema`/`default` on a context
 * slot, `schema`/`source` on a stream channel, `toolInfo.inputSchema` /
 * `toolInfo.outputSchema` / `usage` on a tool); every other member is the
 * AGENT's declaration. These pins hold the overlay that puts those
 * declarations back on a repaired candidate, the toolbox restore that puts
 * back the agent's tool entries the repair dropped, and the findings that
 * name what could not be kept, or what came back.
 */
import { describe, expect, it } from 'vitest';
import {
  actionEntrySchema,
  agentToolEntrySchema,
  contextEntrySchema,
  lintContract,
  propEntrySchema,
  streamChannelEntrySchema,
  type AgentToolEntry,
  type DataContract,
} from '@ggui-ai/protocol';
import {
  findDroppedEntries,
  isOnSurvivingEntry,
  REPAIR_ENTRY_DROPPED,
  REPAIR_ENTRY_RESTORED,
  REPAIR_MEMBER_DROPPED,
  restoreDraftDeclaredMembers,
} from './preserve-declared-members.js';

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

describe('restoreDraftDeclaredMembers — actions (ggui#1421)', () => {
  it('restores every declared member the candidate lacks; the candidate keeps label and schema', () => {
    const { contract, dropped } = restoreDraftDeclaredMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm.nextStep']));
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

  it('a valid nextStep survives: the tool it names, which the repair dropped, is restored from the draft and named REPAIR_ENTRY_RESTORED (ggui#1430)', () => {
    const { contract, dropped } = restoreDraftDeclaredMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm.nextStep']));
    expect(contract.actionSpec?.['edit']).toMatchObject({ nextStep: 'booking_edit', description: 'Reopen the booking details for editing' });
    expect(contract.agentCapabilities?.tools['booking_edit']).toEqual(DRAFT.agentCapabilities.tools.booking_edit);
    expect(dropped).toEqual([
      expect.objectContaining({ code: REPAIR_ENTRY_RESTORED, severity: 'warn', path: 'agentCapabilities.tools.booking_edit' }),
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
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(Object.keys(contract.actionSpec?.['go'] ?? {}).sort()).toEqual([...declared, 'label', 'schema'].sort());
    expect(dropped).toEqual([]);
  });

  it('an action the candidate renamed or removed gets nothing back here (entry-level loss is findDroppedEntries’s)', () => {
    const candidate: DataContract = { actionSpec: { confirmBooking: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    const draft = { actionSpec: DRAFT.actionSpec };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract).toEqual(candidate);
    expect(dropped).toEqual([]);
  });

  it('a draft that is not a record, or declares nothing the candidate carries, returns the candidate untouched', () => {
    expect(restoreDraftDeclaredMembers('not a draft', CANDIDATE, new Set())).toEqual({ contract: CANDIDATE, dropped: [] });
    expect(restoreDraftDeclaredMembers({ propsSpec: {} }, CANDIDATE, new Set())).toEqual({ contract: CANDIDATE, dropped: [] });
    const noActions: DataContract = { propsSpec: { properties: {} } };
    expect(restoreDraftDeclaredMembers({ actionSpec: DRAFT.actionSpec }, noActions, new Set())).toEqual({ contract: noActions, dropped: [] });
  });
});

describe('findDroppedEntries', () => {
  it('names each draft action entry the candidate no longer carries, once, at its entry path', () => {
    const candidate: DataContract = { actionSpec: { confirmBooking: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    const draft = { actionSpec: DRAFT.actionSpec };
    expect(findDroppedEntries(draft, candidate, new Set())).toEqual([
      expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'actionSpec.confirm' }),
      expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'actionSpec.edit' }),
    ]);
  });

  it('is empty when every draft entry survives, and for drafts that declare nothing', () => {
    const restored = restoreDraftDeclaredMembers(DRAFT, CANDIDATE, new Set()).contract;
    expect(findDroppedEntries(DRAFT, restored, new Set())).toEqual([]);
    expect(findDroppedEntries({ propsSpec: {} }, CANDIDATE, new Set())).toEqual([]);
    expect(findDroppedEntries(undefined, CANDIDATE, new Set())).toEqual([]);
  });
});

describe('restoreDraftDeclaredMembers — the review’s edge cases (ggui#1421 amend)', () => {
  const TOOL: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object', properties: { bookingId: { type: 'string' } }, required: ['bookingId'] } } };

  it('never throws on a malformed candidate entry (no label): that entry is left un-overlaid for the loop’s own gate', () => {
    const candidate = { actionSpec: { confirm: { schema: EMPTY_SCHEMA } } } as unknown as DataContract;
    const { contract, dropped } = restoreDraftDeclaredMembers({ actionSpec: DRAFT.actionSpec }, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).toEqual({ schema: EMPTY_SCHEMA });
    expect(dropped).toEqual([]);
  });

  it('a draft finding at the ENTRY path (CTR_DUP_NAME / CTR_RESERVED_NAME) does not withhold the entry’s members', () => {
    const { contract, dropped } = restoreDraftDeclaredMembers(DRAFT, CANDIDATE, new Set(['actionSpec.confirm', 'actionSpec.confirm.nextStep']));
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
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, path: 'actionSpec.confirm.nextStep' })]);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('an action name containing a dot is still un-restored at its exact path', () => {
    const draft = { actionSpec: { 'a.b': { label: 'Dotted', oneShot: true, nextStep: 'missing_tool' } } };
    const candidate: DataContract = { actionSpec: { 'a.b': { label: 'Dotted', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['a.b']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['a.b']).not.toHaveProperty('nextStep');
    expect(dropped.map((f) => f.path)).toEqual(['actionSpec.a.b.nextStep']);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('a restored nextStep the gate refuses is named at ITS OWN path, and the reason carries the gate’s code (a dangling reference the draft itself declared)', () => {
    const draft = { actionSpec: { confirm: { label: 'Confirm booking', oneShot: true, nextStep: 'booking_confirm' } } };
    const candidate: DataContract = { actionSpec: { confirm: { label: 'Confirm booking', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, severity: 'error', path: 'actionSpec.confirm.nextStep' })]);
    expect(dropped[0]?.message).toContain('CTR_REF_NEXT_STEP');
  });

  it('findDroppedEntries names a removed action whose name shadows Object.prototype', () => {
    const draft = { actionSpec: { toString: { label: 'Stringify', oneShot: true }, keep: { label: 'Keep' } } };
    const candidate: DataContract = { actionSpec: { keep: { label: 'Keep', schema: EMPTY_SCHEMA } } };
    expect(findDroppedEntries(draft, candidate, new Set()).map((f) => f.path)).toEqual(['actionSpec.toString']);
  });
});

describe('attribution at the entry and sibling paths (ggui#1421 amend 2)', () => {
  it('findDroppedEntries names an entry the gate refused by name and the repair removed or renamed — at its path, saying the name was refused, never “re-declare it”', () => {
    const draft = { contextSpec: { submit: { schema: { type: 'string' } } }, actionSpec: { submit: { label: 'Submit', oneShot: true }, keep: { label: 'Keep' } } };
    const candidate: DataContract = { contextSpec: { submit: { schema: { type: 'string' } } }, actionSpec: { keep: { label: 'Keep', schema: EMPTY_SCHEMA } } };
    const refused = findDroppedEntries(draft, candidate, new Set(['actionSpec.submit']));
    expect(refused.map((f) => [f.code, f.path])).toEqual([[REPAIR_ENTRY_DROPPED, 'actionSpec.submit']]);
    expect(refused[0]?.message).toMatch(/refused/);
    expect(refused[0]?.message).not.toMatch(/re-declare it via/);
    const dropped = findDroppedEntries(draft, candidate, new Set());
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
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set(['actionSpec.confirm.schema']));
    expect(contract.actionSpec?.['confirm']).toMatchObject({ oneShot: true });
    expect(contract.actionSpec?.['confirm']).not.toHaveProperty('nextStep');
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, path: 'actionSpec.confirm.nextStep' })]);
    expect(dropped[0]?.message).toContain('CTR_SCHEMA_INCOMPAT');
    expect(lintContract(contract).errors).toEqual([]);
  });
});

/** Every member an entry schema declares, minus the ones the repair authors. */
const declaredOf = (shape: Readonly<Record<string, unknown>>, authored: readonly string[]): string[] =>
  Object.keys(shape).filter((k) => !authored.includes(k));

describe('every spec keeps what the agent declared (ggui#1430)', () => {
  it('streamSpec: mode, replay, complete, example and description come back; the candidate keeps schema and source', () => {
    const draft = {
      streamSpec: {
        ticker: { description: 'Live prices', schema: { type: 'number' }, example: 1, mode: 'replace', replay: 'latest', complete: true },
      },
    };
    const candidate: DataContract = { streamSpec: { ticker: { schema: { type: 'number', minimum: 0 } } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.streamSpec?.['ticker']).toEqual({
      schema: { type: 'number', minimum: 0 }, // the candidate's
      description: 'Live prices',
      example: 1,
      mode: 'replace',
      replay: 'latest',
      complete: true,
    });
    expect(dropped).toEqual([]);
    expect(lintContract(contract).errors).toEqual([]);
  });

  it('propsSpec: description, default, example and sourceTool come back; the candidate keeps schema and required', () => {
    const draft = {
      propsSpec: { properties: { title: { description: 'Card title', schema: { type: 'string' }, default: 'Hello', example: 'Weather' } } },
    };
    const candidate: DataContract = { propsSpec: { properties: { title: { schema: { type: 'string' }, required: true } } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.propsSpec?.properties['title']).toEqual({
      schema: { type: 'string' },
      required: true,
      description: 'Card title',
      default: 'Hello',
      example: 'Weather',
    });
    expect(dropped).toEqual([]);
  });

  it('contextSpec: description, debounceMs and example come back; the candidate keeps schema and default', () => {
    const draft = { contextSpec: { query: { description: 'Search box', schema: { type: 'string' }, default: 'x', debounceMs: 250, example: 'pizza' } } };
    const candidate: DataContract = { contextSpec: { query: { schema: { type: 'string' }, default: '' } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.contextSpec?.['query']).toEqual({
      schema: { type: 'string' },
      default: '', // the candidate's
      description: 'Search box',
      debounceMs: 250,
      example: 'pizza',
    });
    expect(dropped).toEqual([]);
  });

  it('agentCapabilities.tools: serverInfo, example and the nested toolInfo.description come back; the candidate keeps toolInfo’s schemas and usage', () => {
    const draft = {
      streamSpec: { feed: { schema: { type: 'object' }, source: { tool: 'fetch_feed' } } },
      agentCapabilities: {
        tools: {
          fetch_feed: {
            serverInfo: { name: 'feeds', version: '1.0.0' },
            toolInfo: { inputSchema: { type: 'object' }, description: 'Fetch the latest feed page' },
            usage: 'Call once per refresh',
            example: { input: {}, output: { items: [] } },
          },
        },
      },
    };
    const candidate: DataContract = {
      streamSpec: { feed: { schema: { type: 'object' }, source: { tool: 'fetch_feed' } } },
      agentCapabilities: { tools: { fetch_feed: { toolInfo: { inputSchema: { type: 'object', properties: {} } }, usage: 'Poll it' } } },
    };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.agentCapabilities?.tools['fetch_feed']).toEqual({
      serverInfo: { name: 'feeds', version: '1.0.0' },
      toolInfo: { inputSchema: { type: 'object', properties: {} }, description: 'Fetch the latest feed page' },
      usage: 'Poll it', // the candidate's
      example: { input: {}, output: { items: [] } },
    });
    expect(dropped).toEqual([]);
  });

  it('the restorable set per spec is derived from its entry schema (a member added later is covered with no code change)', () => {
    expect(declaredOf(streamChannelEntrySchema.shape, ['schema', 'source']).sort()).toEqual(['complete', 'description', 'example', 'mode', 'replay']);
    expect(declaredOf(propEntrySchema.shape, ['schema', 'required']).sort()).toEqual(['default', 'description', 'example', 'sourceTool']);
    expect(declaredOf(contextEntrySchema.shape, ['schema', 'default']).sort()).toEqual(['debounceMs', 'description', 'example']);
    expect(declaredOf(agentToolEntrySchema.shape, ['toolInfo', 'usage']).sort()).toEqual(['example', 'serverInfo']);
  });

  it('a member under repair is not restored, and a member that fails its own schema is named REPAIR_MEMBER_DROPPED at its path', () => {
    const draft = { contextSpec: { query: { schema: { type: 'string' }, debounceMs: -5, description: 'Search box', example: 'pizza' } } };
    const candidate: DataContract = { contextSpec: { query: { schema: { type: 'string' } } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set(['contextSpec.query.example']));
    expect(contract.contextSpec?.['query']).toEqual({ schema: { type: 'string' }, description: 'Search box' });
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, severity: 'error', path: 'contextSpec.query.debounceMs' })]);
  });

  it('member fidelity is owed under the same key only: an entry the repair moved is named once, at its old key, and its members are not owed one by one', () => {
    const draft = { streamSpec: { ticker: { schema: { type: 'number' }, mode: 'replace', replay: 'latest' } } };
    const candidate: DataContract = { streamSpec: { prices: { schema: { type: 'number' } } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract).toEqual(candidate);
    expect(dropped).toEqual([]);
    const entries = findDroppedEntries(draft, contract, new Set());
    expect(entries).toEqual([expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, severity: 'error', path: 'streamSpec.ticker' })]);
    expect(entries[0]?.message).toMatch(/moved|renamed/);
  });
});

describe('the toolbox is the agent’s: a tool entry the repair dropped is restored whole (ggui#1430)', () => {
  const TOOL: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object' }, description: 'Edit the booking' }, usage: 'After Change details' };

  it('a tool under repair (a draft finding at or under its path) is not restored, and is named REPAIR_ENTRY_DROPPED at entry level', () => {
    const draft = { agentCapabilities: { tools: { booking_edit: TOOL } }, actionSpec: { edit: { label: 'Edit', nextStep: 'booking_edit' } } };
    const candidate: DataContract = { actionSpec: { edit: { label: 'Edit', schema: EMPTY_SCHEMA } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set(['agentCapabilities.tools.booking_edit.example']));
    expect(contract.agentCapabilities).toBeUndefined();
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_MEMBER_DROPPED, path: 'actionSpec.edit.nextStep' })]);
    expect(findDroppedEntries(draft, contract, new Set()).map((f) => f.path)).toEqual(['agentCapabilities.tools.booking_edit']);
  });

  it('a draft tool that fails its entry schema is not restored', () => {
    const draft = { agentCapabilities: { tools: { broken: { toolInfo: { description: 'no inputSchema' } } } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, {}, new Set());
    expect(contract.agentCapabilities).toBeUndefined();
    expect(dropped).toEqual([]);
  });

  it('a restored tool the gate refuses on the merged contract is un-restored and named REPAIR_ENTRY_DROPPED with the gate’s reason', () => {
    // A stream channel already sources a tool by this name with an incompatible output.
    const FEED: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object' }, outputSchema: { type: 'string' } } };
    const draft = { agentCapabilities: { tools: { feed: FEED } } };
    const candidate: DataContract = { streamSpec: { feed_ch: { schema: { type: 'number' }, source: { tool: 'feed' } } } };
    const merged: DataContract = { ...candidate, agentCapabilities: { tools: { feed: FEED } } };
    const gate = lintContract(merged).errors;
    expect(gate.length).toBeGreaterThan(0); // the control: the merged tree does fail the gate
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, candidate, new Set());
    expect(contract.agentCapabilities?.tools['feed']).toBeUndefined();
    expect(dropped).toEqual([expect.objectContaining({ code: REPAIR_ENTRY_DROPPED, path: 'agentCapabilities.tools.feed' })]);
    expect(dropped[0]?.message).toContain(gate[0]?.code ?? '');
    expect(lintContract(contract).errors).toEqual(lintContract(candidate).errors);
  });

  it('the outcome is canonical: two drafts that differ only in tool key order serve the same proposal and the same findings, byte for byte', () => {
    const A: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object' }, description: 'A' } };
    const B: AgentToolEntry = { toolInfo: { inputSchema: { type: 'object' }, description: 'B' } };
    const actionSpec = { a: { label: 'A', nextStep: 'tool_a' }, b: { label: 'B', nextStep: 'tool_b' } };
    const candidate: DataContract = { actionSpec: { a: { label: 'A', schema: EMPTY_SCHEMA }, b: { label: 'B', schema: EMPTY_SCHEMA } } };
    const one = restoreDraftDeclaredMembers({ actionSpec, agentCapabilities: { tools: { tool_a: A, tool_b: B } } }, candidate, new Set());
    const two = restoreDraftDeclaredMembers({ actionSpec, agentCapabilities: { tools: { tool_b: B, tool_a: A } } }, candidate, new Set());
    expect(JSON.stringify(two)).toBe(JSON.stringify(one));
    expect(one.dropped.map((f) => f.path)).toEqual(['agentCapabilities.tools.tool_a', 'agentCapabilities.tools.tool_b']);
  });

  it('actions, props, context and streams get no entry-level restore: a repair may move or remove them', () => {
    const draft = { contextSpec: { q: { schema: { type: 'string' } } }, actionSpec: { go: { label: 'Go' } } };
    const { contract, dropped } = restoreDraftDeclaredMembers(draft, {}, new Set());
    expect(contract).toEqual({});
    expect(dropped).toEqual([]);
  });
});

describe('isOnSurvivingEntry', () => {
  const drop = { code: REPAIR_MEMBER_DROPPED, severity: 'error' as const, path: 'actionSpec.a.b.nextStep', message: '' };

  it('matches a member finding to its entry exactly, never by dotted prefix', () => {
    expect(isOnSurvivingEntry(drop, { actionSpec: { 'a.b': { label: 'x', schema: EMPTY_SCHEMA } } })).toBe(true);
    expect(isOnSurvivingEntry(drop, { actionSpec: { a: { label: 'x', schema: EMPTY_SCHEMA } } })).toBe(false);
    expect(isOnSurvivingEntry({ ...drop, path: 'actionSpec.a.nextStep' }, { actionSpec: { a: { label: 'x', schema: EMPTY_SCHEMA } } })).toBe(true);
  });

  it('matches a nested member and an entry-level finding on every spec', () => {
    const contract: DataContract = { agentCapabilities: { tools: { t: { toolInfo: { inputSchema: { type: 'object' } } } } } };
    expect(isOnSurvivingEntry({ ...drop, path: 'agentCapabilities.tools.t.toolInfo.description' }, contract)).toBe(true);
    expect(isOnSurvivingEntry({ ...drop, code: REPAIR_ENTRY_RESTORED, severity: 'warn', path: 'agentCapabilities.tools.t' }, contract)).toBe(true);
    expect(isOnSurvivingEntry({ ...drop, path: 'agentCapabilities.tools.u' }, contract)).toBe(false);
  });
});
