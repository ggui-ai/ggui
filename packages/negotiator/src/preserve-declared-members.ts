/**
 * Declared-member preservation: the deterministic backstop that keeps a
 * repair FAITHFUL to what the agent DECLARED (ggui#1421 for actions,
 * ggui#1430 for every spec).
 *
 * The repair tool authors only a few members per entry:
 *   - `label` / `schema` on an action;
 *   - `schema` / `required` on a prop;
 *   - `schema` / `default` on a context slot;
 *   - `schema` / `source` on a stream channel;
 *   - `toolInfo.inputSchema` / `toolInfo.outputSchema` / `usage` on a tool.
 * Every other member is the agent's declaration: an action's `oneShot` (the
 * one-shot line keys on it being ON THE SERVED CONTRACT, ggui#1108 →
 * ggui#1223), a stream's `mode` / `replay` / `complete`, a prop's
 * `default`, a tool's `toolInfo.description`. A repair that re-emits an entry
 * from the tool's answer alone drops them silently. So the overlay below puts
 * the draft's declarations back on the repaired candidate, under the SAME
 * KEY, and names whatever it cannot keep.
 *
 * The toolbox is the agent's too. A repair that drops a tool entry the draft
 * declared leaves every `nextStep` naming it dangling, so a draft tool the
 * candidate lacks is restored WHOLE. Only tools: a repair may legitimately
 * move or remove an action, prop, context or stream entry.
 *
 * Findings, each at its own path:
 *   - `REPAIR_MEMBER_DROPPED` at `<spec>.<name>.<member>`: a declared
 *     member the merged contract cannot carry (it fails its own schema, or
 *     the gate refuses it there or, for `nextStep`, as `CTR_SCHEMA_INCOMPAT`
 *     at the sibling `.schema`);
 *   - `REPAIR_ENTRY_DROPPED` at `<spec>.<name>`: a draft action, prop,
 *     context, stream or tool entry the proposal no longer carries under that
 *     key (renamed, moved or removed), named ONCE; its members are not owed
 *     one by one. A restored tool the gate refuses is named so, with the
 *     gate's reason;
 *   - `REPAIR_ENTRY_RESTORED` at `agentCapabilities.tools.<name>`
 *     (severity `warn`): a draft tool the repair dropped and the overlay put
 *     back, so a tool coming back is never silent.
 *
 * A member whose path a DRAFT finding already names is under repair: it is
 * not restored, and its absence is named by that finding. A draft tool with a
 * finding at or under its path is not restored. Paths follow the gate's
 * convention (`propsSpec.<name>`, not `propsSpec.properties.<name>`).
 * Model-independent: the overlay works whatever the repair LLM returns, and
 * it never makes the proposal fail the gate BECAUSE of what it put back.
 */

import {
  actionEntrySchema,
  agentToolEntrySchema,
  contextEntrySchema,
  CTR_SCHEMA_INCOMPAT,
  lintContract,
  propEntrySchema,
  streamChannelEntrySchema,
  type ActionEntry,
  type AgentToolEntry,
  type ContextEntry,
  type DataContract,
  type PropEntry,
  type StreamChannelEntry,
  type SuggestionFinding,
} from '@ggui-ai/protocol';

/** A declared member the repair could not keep; path `<spec>.<name>.<member>`. */
export const REPAIR_MEMBER_DROPPED = 'REPAIR_MEMBER_DROPPED' as const;
/** A draft entry the proposal no longer carries under its key; path `<spec>.<name>`. */
export const REPAIR_ENTRY_DROPPED = 'REPAIR_ENTRY_DROPPED' as const;
/** A draft tool the repair dropped and the overlay restored; path `agentCapabilities.tools.<name>`. */
export const REPAIR_ENTRY_RESTORED = 'REPAIR_ENTRY_RESTORED' as const;

/** One gate error, as `lintContract` reports it. */
type GateIssue = ReturnType<typeof lintContract>['errors'][number];

/**
 * What the overlay needs of an entry schema, structurally: the protocol's zod
 * schemas satisfy it, and this package takes no zod dependency of its own.
 */
interface Parser<T> {
  safeParse(
    value: unknown,
  ):
    | { readonly success: true; readonly data: T }
    | { readonly success: false; readonly error: { readonly issues: readonly { readonly message: string }[] } };
  parse(value: unknown): T;
}
interface ObjectParser<T> extends Parser<T> {
  readonly shape: Readonly<Record<string, Parser<unknown>>>;
}

/** One spec the overlay covers. `E` is the protocol's entry type. */
interface SpecDescriptor<E> {
  /** The gate's path prefix for this spec's entries. */
  readonly prefix: string;
  /** What an entry is called in a message. */
  readonly noun: string;
  readonly schema: ObjectParser<E>;
  /** Top-level members the repair authors: never restored. */
  readonly authored: ReadonlySet<string>;
  /** A nested object whose members are declared too, minus the ones the repair authors in it. */
  readonly nested?: { readonly member: string; readonly schema: ObjectParser<unknown>; readonly authored: ReadonlySet<string> };
  /** Whether a draft entry the candidate lacks is restored whole (the toolbox only). */
  readonly restoresEntries: boolean;
  /** For a member the gate reports at a SIBLING path: that path's last segment and the code it reports. */
  readonly sibling?: (member: string) => { readonly segment: string; readonly code: string } | undefined;
  draftEntries(draft: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> | undefined;
  /** The entry's members as a plain record (a spread at the concrete type). */
  asRecord(entry: E): Readonly<Record<string, unknown>>;
  entries(contract: DataContract): Readonly<Record<string, E>> | undefined;
  withEntries(contract: DataContract, entries: Readonly<Record<string, E>>): DataContract;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recordAt(value: Readonly<Record<string, unknown>> | undefined, key: string): Readonly<Record<string, unknown>> | undefined {
  if (value === undefined) return undefined;
  const at = value[key];
  return isRecord(at) ? at : undefined;
}

function memberDropped(prefix: string, name: string, member: string, reason: string): SuggestionFinding {
  return {
    code: REPAIR_MEMBER_DROPPED,
    severity: 'error',
    path: `${prefix}.${name}.${member}`,
    message: `the repair could not keep the declared \`${member}\` on '${name}' (${prefix}): ${reason}`,
  };
}

function gateReason(issue: GateIssue): string {
  return `refused by the gate as ${issue.code} at ${issue.path}: ${issue.message}`;
}

/** Per spec, what the overlay put back: members per entry key, and whole entries. */
interface RestoreState {
  readonly members: Map<string, Set<string>>;
  readonly entries: Set<string>;
}

/** The descriptor's behaviour behind one non-generic face, so the five specs sit in one list. */
interface SpecRunner {
  readonly prefix: string;
  overlay(
    draft: Readonly<Record<string, unknown>>,
    contract: DataContract,
    underRepair: ReadonlySet<string>,
  ): { readonly contract: DataContract; readonly state: RestoreState; readonly dropped: readonly SuggestionFinding[] };
  /** Un-restore the restored members the gate refuses at their own (or sibling) path. */
  unrestoreMembers(
    contract: DataContract,
    state: RestoreState,
    errors: readonly GateIssue[],
  ): { readonly contract: DataContract; readonly dropped: readonly SuggestionFinding[] };
  /** Un-restore ONE restored entry whose presence adds a gate error the tree does not have without it. */
  unrestoreOneEntry(
    contract: DataContract,
    state: RestoreState,
  ): { readonly contract: DataContract; readonly dropped: readonly SuggestionFinding[] } | undefined;
  /** The `REPAIR_ENTRY_RESTORED` findings for the entries still restored. */
  restoredFindings(state: RestoreState): readonly SuggestionFinding[];
  /** The draft's entry keys the contract no longer carries. */
  droppedKeys(draft: Readonly<Record<string, unknown>>, contract: DataContract): readonly string[];
  readonly noun: string;
  /** Whether `path` is this spec's entry path, or one of its member paths, for an entry `contract` carries. */
  onSurvivingEntry(path: string, contract: DataContract): boolean;
}

function specRunner<E>(d: SpecDescriptor<E>): SpecRunner {
  const topMembers = Object.keys(d.schema.shape).filter((k) => !d.authored.has(k) && k !== d.nested?.member);
  const nestedMembers = d.nested === undefined ? [] : Object.keys(d.nested.schema.shape).filter((k) => !(d.nested?.authored.has(k) ?? false));
  const nestedPrefix = d.nested?.member;
  /** Every member path a finding can carry on an entry, exactly. */
  const memberPaths = [
    ...Object.keys(d.schema.shape),
    ...(d.nested === undefined ? [] : Object.keys(d.nested.schema.shape).map((k) => `${d.nested?.member}.${k}`)),
  ];
  const entryPath = (name: string): string => `${d.prefix}.${name}`;

  /** `entry` without the member at `member` (`a` or `parent.a`), re-derived by the strict schema. */
  const withoutMember = (entry: E, member: string): E => {
    const dot = member.indexOf('.');
    if (dot === -1) return d.schema.parse(Object.fromEntries(Object.entries(d.asRecord(entry)).filter(([k]) => k !== member)));
    const parent = member.slice(0, dot);
    const leaf = member.slice(dot + 1);
    const copy: Record<string, unknown> = { ...d.asRecord(entry) };
    const inner = recordAt(copy, parent);
    if (inner !== undefined) copy[parent] = Object.fromEntries(Object.entries(inner).filter(([k]) => k !== leaf));
    return d.schema.parse(copy);
  };

  const withoutEntry = (contract: DataContract, name: string): DataContract => {
    const current = d.entries(contract) ?? {};
    return d.withEntries(contract, Object.fromEntries(Object.entries(current).filter(([k]) => k !== name)));
  };

  /** Under repair at or under an entry: the entry path, a member path, or a path inside a member. */
  const entryUnderRepair = (name: string, underRepair: ReadonlySet<string>): boolean => {
    const base = entryPath(name);
    if (underRepair.has(base)) return true;
    for (const p of underRepair) {
      for (const m of memberPaths) if (p === `${base}.${m}` || p.startsWith(`${base}.${m}.`)) return true;
    }
    return false;
  };

  const sameIssue = (a: GateIssue, b: GateIssue): boolean => a.code === b.code && a.path === b.path;

  return {
    prefix: d.prefix,
    noun: d.noun,

    overlay(draft, contract, underRepair) {
      const state: RestoreState = { members: new Map(), entries: new Set() };
      const dropped: SuggestionFinding[] = [];
      const draftEntries = d.draftEntries(draft);
      if (draftEntries === undefined) return { contract, state, dropped };
      const current = d.entries(contract) ?? {};
      const merged: Record<string, E> = { ...current };

      for (const [name, entry] of Object.entries(current)) {
        const draftEntry = recordAt(draftEntries, name);
        if (draftEntry === undefined) continue;
        const next: Record<string, unknown> = { ...d.asRecord(entry) };
        const put = new Set<string>();
        for (const member of topMembers) {
          const value = draftEntry[member];
          if (value === undefined || next[member] !== undefined || underRepair.has(`${entryPath(name)}.${member}`)) continue;
          const parsed = d.schema.shape[member]?.safeParse(value);
          if (parsed === undefined) continue;
          if (!parsed.success) {
            dropped.push(memberDropped(d.prefix, name, member, parsed.error.issues[0]?.message ?? 'invalid'));
            continue;
          }
          next[member] = parsed.data;
          put.add(member);
        }
        if (d.nested !== undefined && nestedPrefix !== undefined) {
          const draftInner = recordAt(draftEntry, nestedPrefix);
          const inner = recordAt(next, nestedPrefix);
          if (draftInner !== undefined && inner !== undefined) {
            const nextInner: Record<string, unknown> = { ...inner };
            for (const member of nestedMembers) {
              const path = `${nestedPrefix}.${member}`;
              const value = draftInner[member];
              if (value === undefined || nextInner[member] !== undefined || underRepair.has(`${entryPath(name)}.${path}`)) continue;
              const parsed = d.nested.schema.shape[member]?.safeParse(value);
              if (parsed === undefined) continue;
              if (!parsed.success) {
                dropped.push(memberDropped(d.prefix, name, path, parsed.error.issues[0]?.message ?? 'invalid'));
                continue;
              }
              nextInner[member] = parsed.data;
              put.add(path);
            }
            next[nestedPrefix] = nextInner;
          }
        }
        if (put.size === 0) continue;
        const reparsed = d.schema.safeParse(next);
        // The CANDIDATE's own authored members are not an entry yet: the loop's gate retries that.
        if (!reparsed.success) continue;
        merged[name] = reparsed.data;
        state.members.set(name, put);
      }

      if (d.restoresEntries) {
        // Sorted, so the outcome depends on the draft's content, never on its key order.
        for (const name of Object.keys(draftEntries).sort()) {
          if (Object.hasOwn(current, name) || entryUnderRepair(name, underRepair)) continue;
          const parsed = d.schema.safeParse(draftEntries[name]);
          if (!parsed.success) continue;
          merged[name] = parsed.data;
          state.entries.add(name);
        }
      }

      if (state.members.size === 0 && state.entries.size === 0) return { contract, state, dropped };
      return { contract: d.withEntries(contract, merged), state, dropped };
    },

    unrestoreMembers(contract, state, errors) {
      const dropped: SuggestionFinding[] = [];
      let next = contract;
      for (const [name, members] of state.members) {
        for (const member of [...members]) {
          const sib = d.sibling?.(member);
          const refusal =
            errors.find((issue) => issue.path === `${entryPath(name)}.${member}`) ??
            (sib !== undefined ? errors.find((issue) => issue.code === sib.code && issue.path === `${entryPath(name)}.${sib.segment}`) : undefined);
          if (refusal === undefined) continue;
          const entry = d.entries(next)?.[name];
          if (entry === undefined) continue;
          next = d.withEntries(next, { ...(d.entries(next) ?? {}), [name]: withoutMember(entry, member) });
          members.delete(member);
          dropped.push(memberDropped(d.prefix, name, member, gateReason(refusal)));
        }
        if (members.size === 0) state.members.delete(name);
      }
      return { contract: next, dropped };
    },

    unrestoreOneEntry(contract, state) {
      if (state.entries.size === 0) return undefined;
      const withAll = lintContract(contract).errors;
      // Sorted: when two restored tools fail only together, which one comes back out
      // depends on their names, never on the draft's key order.
      for (const name of [...state.entries].sort()) {
        const without = withoutEntry(contract, name);
        const base = lintContract(without).errors;
        const added = withAll.find((issue) => !base.some((b) => sameIssue(b, issue)));
        if (added === undefined) continue;
        state.entries.delete(name);
        return {
          contract: without,
          dropped: [
            {
              code: REPAIR_ENTRY_DROPPED,
              severity: 'error',
              path: entryPath(name),
              message: `the repair dropped the ${d.noun} '${name}' you declared, and restoring it from your draft would fail the gate (${gateReason(added)}); declare it again in a form the gate accepts, via ggui_render override or a corrected re-handshake`,
            },
          ],
        };
      }
      return undefined;
    },

    restoredFindings(state) {
      return [...state.entries].sort().map((name): SuggestionFinding => ({
        code: REPAIR_ENTRY_RESTORED,
        severity: 'warn',
        path: entryPath(name),
        message: `the repair dropped the ${d.noun} '${name}' you declared; it is restored from your draft, because the toolbox is yours to declare`,
      }));
    },

    droppedKeys(draft, contract) {
      const draftEntries = d.draftEntries(draft);
      if (draftEntries === undefined) return [];
      const kept = d.entries(contract) ?? {};
      return Object.keys(draftEntries).filter((name) => !Object.hasOwn(kept, name));
    },

    onSurvivingEntry(path, contract) {
      const kept = d.entries(contract);
      if (kept === undefined) return false;
      return Object.keys(kept).some((name) => {
        const base = entryPath(name);
        return path === base || memberPaths.some((m) => path === `${base}.${m}`);
      });
    },
  };
}

/** The five specs, in the order a finding list names them. */
const RUNNERS: readonly SpecRunner[] = [
  specRunner<ActionEntry>({
    prefix: 'actionSpec',
    noun: 'action',
    schema: actionEntrySchema,
    authored: new Set(['label', 'schema']),
    restoresEntries: false,
    sibling: (member) => (member === 'nextStep' ? { segment: 'schema', code: CTR_SCHEMA_INCOMPAT } : undefined),
    draftEntries: (draft) => recordAt(draft, 'actionSpec'),
    asRecord: (entry) => ({ ...entry }),
    entries: (contract) => contract.actionSpec,
    withEntries: (contract, entries) => ({ ...contract, actionSpec: entries }),
  }),
  specRunner<PropEntry>({
    prefix: 'propsSpec',
    noun: 'prop',
    schema: propEntrySchema,
    authored: new Set(['schema', 'required']),
    restoresEntries: false,
    draftEntries: (draft) => recordAt(recordAt(draft, 'propsSpec'), 'properties'),
    asRecord: (entry) => ({ ...entry }),
    entries: (contract) => contract.propsSpec?.properties,
    withEntries: (contract, entries) => ({ ...contract, propsSpec: { ...contract.propsSpec, properties: entries } }),
  }),
  specRunner<ContextEntry>({
    prefix: 'contextSpec',
    noun: 'context slot',
    schema: contextEntrySchema,
    authored: new Set(['schema', 'default']),
    restoresEntries: false,
    draftEntries: (draft) => recordAt(draft, 'contextSpec'),
    asRecord: (entry) => ({ ...entry }),
    entries: (contract) => contract.contextSpec,
    withEntries: (contract, entries) => ({ ...contract, contextSpec: entries }),
  }),
  specRunner<StreamChannelEntry>({
    prefix: 'streamSpec',
    noun: 'stream channel',
    schema: streamChannelEntrySchema,
    authored: new Set(['schema', 'source']),
    restoresEntries: false,
    draftEntries: (draft) => recordAt(draft, 'streamSpec'),
    asRecord: (entry) => ({ ...entry }),
    entries: (contract) => contract.streamSpec,
    withEntries: (contract, entries) => ({ ...contract, streamSpec: entries }),
  }),
  specRunner<AgentToolEntry>({
    prefix: 'agentCapabilities.tools',
    noun: 'tool',
    schema: agentToolEntrySchema,
    authored: new Set(['toolInfo', 'usage']),
    nested: { member: 'toolInfo', schema: agentToolEntrySchema.shape.toolInfo, authored: new Set(['inputSchema', 'outputSchema']) },
    restoresEntries: true,
    draftEntries: (draft) => recordAt(recordAt(draft, 'agentCapabilities'), 'tools'),
    asRecord: (entry) => ({ ...entry }),
    entries: (contract) => contract.agentCapabilities?.tools,
    withEntries: (contract, entries) => ({ ...contract, agentCapabilities: { ...contract.agentCapabilities, tools: entries } }),
  }),
];

/**
 * Overlay the draft's declarations onto the candidate: every declared member
 * of every entry the candidate carries under the same key (keeping what the
 * repair authors), and every draft tool the candidate dropped, whole. A
 * member or tool whose path a draft finding names is under repair and stays
 * out. Then lint the merged contract and un-restore, until the tree is
 * stable, every restored member the gate refuses (at its own path, or for
 * `nextStep` as `CTR_SCHEMA_INCOMPAT` at the sibling `.schema`) and every
 * restored tool whose presence adds a gate error, naming each one, so the
 * returned contract never fails the gate BECAUSE of the overlay. A malformed
 * candidate entry is left un-overlaid for the loop's own gate to retry;
 * nothing here throws on the model's answer. Entries the candidate moved or
 * removed (other than tools) get nothing back here: see
 * {@link findDroppedEntries}.
 */
export function restoreDraftDeclaredMembers(
  draft: unknown,
  candidate: DataContract,
  underRepair: ReadonlySet<string>,
): { readonly contract: DataContract; readonly dropped: readonly SuggestionFinding[] } {
  if (!isRecord(draft)) return { contract: candidate, dropped: [] };
  let contract = candidate;
  const dropped: SuggestionFinding[] = [];
  const states: RestoreState[] = [];
  for (const runner of RUNNERS) {
    const result = runner.overlay(draft, contract, underRepair);
    contract = result.contract;
    dropped.push(...result.dropped);
    states.push(result.state);
  }
  const restoredCount = (): number => states.reduce((n, s) => n + s.entries.size + [...s.members.values()].reduce((m, set) => m + set.size, 0), 0);
  if (restoredCount() === 0) return { contract, dropped };

  // Cross-reference and compatibility errors exist only on the MERGED tree.
  // Each pass un-restores at least one member or entry, or stops, so the
  // loop is bounded by what was restored.
  for (let pass = 0, budget = restoredCount() + 1; pass < budget; pass += 1) {
    const errors = lintContract(contract).errors;
    let changed = false;
    RUNNERS.forEach((runner, i) => {
      const state = states[i];
      if (state === undefined) return;
      const result = runner.unrestoreMembers(contract, state, errors);
      if (result.dropped.length > 0) changed = true;
      contract = result.contract;
      dropped.push(...result.dropped);
    });
    if (!changed) {
      for (const [i, runner] of RUNNERS.entries()) {
        const state = states[i];
        if (state === undefined) continue;
        const result = runner.unrestoreOneEntry(contract, state);
        if (result === undefined) continue;
        contract = result.contract;
        dropped.push(...result.dropped);
        changed = true;
        break;
      }
    }
    if (!changed || restoredCount() === 0) break;
  }
  RUNNERS.forEach((runner, i) => {
    const state = states[i];
    if (state !== undefined) dropped.push(...runner.restoredFindings(state));
  });
  return { contract, dropped };
}

/**
 * Whether `finding` sits on an entry `contract` still carries: at its exact
 * entry path or one of its member paths, never by dotted prefix (an action
 * named `a` is not a prefix of `a.b`). Used to keep a repair's member and
 * restore findings only for entries the final proposal carries.
 */
export function isOnSurvivingEntry(finding: SuggestionFinding, contract: DataContract): boolean {
  return RUNNERS.some((runner) => runner.onSurvivingEntry(finding.path, contract));
}

/**
 * One `REPAIR_ENTRY_DROPPED` per draft entry, on every spec, that the
 * candidate no longer carries under its key: renamed, moved or removed by the
 * repair, or pruned by the loop's own placement pass. Its members are not
 * owed one by one. When the gate refused the NAME itself (`CTR_DUP_NAME` /
 * `CTR_RESERVED_NAME` at `<spec>.<name>`, so the path is under repair) the
 * message says so and does not send the agent back to a name the gate will
 * refuse again. Empty when every draft entry survived.
 */
export function findDroppedEntries(
  draft: unknown,
  candidate: DataContract,
  underRepair: ReadonlySet<string>,
): readonly SuggestionFinding[] {
  if (!isRecord(draft)) return [];
  return RUNNERS.flatMap((runner) =>
    runner.droppedKeys(draft, candidate).map((name): SuggestionFinding => {
      const path = `${runner.prefix}.${name}`;
      const message = underRepair.has(path)
        ? `the gate refused the ${runner.noun} name '${name}' (see the finding at this path) and the repair removed or renamed it; every member it carried went with it — declare those members again under a name the gate accepts, via ggui_render override or a corrected re-handshake`
        : runner.prefix === 'actionSpec'
          ? `the repair no longer carries the action '${name}' you declared (renamed or removed); every member it carried, oneShot included, went with it — re-declare it via ggui_render override or a corrected re-handshake`
          : `the repair no longer carries the ${runner.noun} '${name}' you declared under that key (renamed, moved or removed); every member it carried went with it — re-declare it via ggui_render override or a corrected re-handshake`;
      return { code: REPAIR_ENTRY_DROPPED, severity: 'error', path, message };
    }),
  );
}
