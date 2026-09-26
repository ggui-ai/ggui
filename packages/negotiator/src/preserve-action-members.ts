/**
 * Action-entry member preservation — the deterministic backstop that
 * keeps a repair FAITHFUL to what the agent DECLARED on its actions
 * (ggui#1421).
 *
 * The repair tool authors exactly two members per action, `label` and
 * `schema` (`SYNTHESIZE_TOOL`); every other member of an
 * {@link ActionEntry} — `description`, `example`, `icon`, `confirm`,
 * `oneShot`, `nextStep` — is the agent's declaration, and the whole
 * one-shot line (ggui#1108 → ggui#1223: the runtime's second-dispatch
 * guard, the server's spend record, ui-gen's `useActionSpent` binding)
 * keys on `oneShot === true` being ON THE SERVED CONTRACT. A repair that
 * re-emits an entry from the tool's answer alone serves a card with no
 * guard, silently. So the overlay below puts the draft's declarations
 * back on the repaired candidate, deterministically, and NAMES whatever
 * it cannot keep:
 *
 *   - `REPAIR_MEMBER_DROPPED` at `actionSpec.<name>.<member>` — a
 *     declared member the merged contract cannot carry (the gate refuses
 *     it there, e.g. a `nextStep` whose tool the repair did not
 *     re-declare, or a member that fails its own schema);
 *   - `REPAIR_ENTRY_DROPPED` at `actionSpec.<name>` — a draft action the
 *     candidate no longer carries under that name (renamed or removed),
 *     which takes every member with it.
 *
 * A member whose path a DRAFT finding already names is under repair: it
 * is not restored, and its absence is named by that finding, at the same
 * path. Every other loss is named HERE, at the member's or the entry's
 * own path, with the gate's reason in the message — so the invariant an
 * agent can rely on is one sentence: a declared member or action missing
 * from the served proposal always has a finding at its own path. The
 * `CTR_*` codes say what the gate refused; the `REPAIR_*` codes say what
 * the served proposal does not carry of the declaration, and why. The
 * codes are handshake-decision codes like `COVERAGE_GAP` — declared where
 * they are emitted, read by the agent as strings in `validationFindings`.
 * Model-independent: the overlay works whatever the repair LLM returns.
 */

import {
  actionEntrySchema,
  CTR_SCHEMA_INCOMPAT,
  lintContract,
  type DataContract,
  type SuggestionFinding,
} from '@ggui-ai/protocol';

/** A declared action-entry member the repair could not keep; path `actionSpec.<name>.<member>`. */
export const REPAIR_MEMBER_DROPPED = 'REPAIR_MEMBER_DROPPED' as const;
/** A draft action entry the repair no longer carries under its name; path `actionSpec.<name>`. */
export const REPAIR_ENTRY_DROPPED = 'REPAIR_ENTRY_DROPPED' as const;

type ActionEntry = NonNullable<DataContract['actionSpec']>[string];
type ActionMember = Exclude<keyof typeof actionEntrySchema.shape, 'label' | 'schema'>;

/**
 * The members the agent declares — the protocol's action-entry schema
 * minus the pair the repair tool authors. Derived, never listed, so a
 * new schema member is preserved the day it lands.
 */
const DECLARED_MEMBERS: readonly ActionMember[] = (
  Object.keys(actionEntrySchema.shape) as (keyof typeof actionEntrySchema.shape)[]
).filter((k): k is ActionMember => k !== 'label' && k !== 'schema');

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The draft's `actionSpec` map when it is one; `undefined` otherwise (the draft is untrusted). */
function draftActionSpec(draft: unknown): Record<string, unknown> | undefined {
  if (!isRecord(draft)) return undefined;
  const actionSpec = draft['actionSpec'];
  return isRecord(actionSpec) ? actionSpec : undefined;
}

/**
 * `entry` without `member`. Removing an optional member from a parsed
 * entry leaves a parsed entry, so the strict re-parse re-derives the
 * typed shape without a cast.
 */
function withoutMember(entry: ActionEntry, member: ActionMember): ActionEntry {
  return actionEntrySchema.parse(
    Object.fromEntries(Object.entries(entry).filter(([key]) => key !== member)),
  );
}

function memberDropped(name: string, member: ActionMember, reason: string): SuggestionFinding {
  return {
    code: REPAIR_MEMBER_DROPPED,
    severity: 'error',
    path: `actionSpec.${name}.${member}`,
    message: `the repair could not keep the declared \`${member}\` on action '${name}': ${reason}`,
  };
}

/**
 * Whether `finding` is a member drop on one of `entryNames` — matched by
 * the exact `actionSpec.<name>.<member>` path per declared member, never
 * by a dotted prefix (an action named `a` is not a prefix of `a.b`).
 */
export function isMemberDropOf(finding: SuggestionFinding, entryNames: readonly string[]): boolean {
  return entryNames.some((name) => DECLARED_MEMBERS.some((member) => finding.path === `actionSpec.${name}.${member}`));
}

/**
 * Overlay the draft's declared members onto the candidate's action
 * entries (same name), keeping the candidate's `label` and `schema`. A
 * member whose exact path a draft finding names is under repair and
 * stays out. Then lint the merged contract and un-restore, until the
 * tree is stable, every restored member the gate refuses — at its own
 * path, or (for `nextStep`) as `CTR_SCHEMA_INCOMPAT` at the sibling
 * `.schema`, the path the compatibility check reports on — naming each
 * one, so the returned contract never fails the gate BECAUSE of the
 * overlay. A malformed candidate entry (no `label`) is left un-overlaid
 * for the loop's own gate to retry; nothing here throws on the model's
 * answer. Entries the candidate does not carry get nothing back here —
 * see {@link findDroppedActionEntries}.
 */
export function restoreDraftActionMembers(
  draft: unknown,
  candidate: DataContract,
  underRepair: ReadonlySet<string>,
): { readonly contract: DataContract; readonly dropped: readonly SuggestionFinding[] } {
  const draftActions = draftActionSpec(draft);
  if (draftActions === undefined || candidate.actionSpec === undefined) {
    return { contract: candidate, dropped: [] };
  }
  const dropped: SuggestionFinding[] = [];
  /** Per entry, the members the overlay put back. */
  const restored = new Map<string, Set<ActionMember>>();
  const merged: Record<string, ActionEntry> = {};
  for (const [name, entry] of Object.entries(candidate.actionSpec)) {
    const draftEntry = Object.hasOwn(draftActions, name) ? draftActions[name] : undefined;
    if (!isRecord(draftEntry)) {
      merged[name] = entry;
      continue;
    }
    const next: Record<string, unknown> = { ...entry };
    const put = new Set<ActionMember>();
    for (const member of DECLARED_MEMBERS) {
      const value = draftEntry[member];
      if (value === undefined || entry[member] !== undefined || underRepair.has(`actionSpec.${name}.${member}`)) continue;
      const parsed = actionEntrySchema.shape[member].safeParse(value);
      if (!parsed.success) {
        dropped.push(memberDropped(name, member, parsed.error.issues[0]?.message ?? 'invalid'));
        continue;
      }
      next[member] = parsed.data;
      put.add(member);
    }
    const reparsed = actionEntrySchema.safeParse(next);
    if (put.size === 0 || !reparsed.success) {
      // Nothing to put back, or the CANDIDATE's own label/schema are not
      // an entry yet — the loop's gate retries that; not this overlay's.
      merged[name] = entry;
      continue;
    }
    merged[name] = reparsed.data;
    restored.set(name, put);
  }
  let actionSpec: Record<string, ActionEntry> = merged;
  if (restored.size === 0) return { contract: { ...candidate, actionSpec }, dropped };

  // Cross-reference and compatibility errors only exist on the MERGED
  // tree. Un-restore exactly the members the gate names — at their own
  // path, or a `nextStep` as `CTR_SCHEMA_INCOMPAT` at the sibling
  // `.schema`, the path the compatibility check reports on — naming each
  // at ITS OWN path with the gate's reason; re-lint, and stop when a pass
  // changes nothing. Every pass removes at least one member, so the loop
  // is bounded by what was restored.
  for (let pass = 0; pass < DECLARED_MEMBERS.length * restored.size + 1; pass += 1) {
    const errors = lintContract({ ...candidate, actionSpec }).errors;
    let changed = false;
    for (const [name, members] of restored) {
      for (const member of [...members]) {
        const refusal =
          errors.find((issue) => issue.path === `actionSpec.${name}.${member}`) ??
          (member === 'nextStep'
            ? errors.find((issue) => issue.code === CTR_SCHEMA_INCOMPAT && issue.path === `actionSpec.${name}.schema`)
            : undefined);
        if (refusal === undefined) continue;
        const entry = actionSpec[name];
        if (entry === undefined) continue;
        actionSpec = { ...actionSpec, [name]: withoutMember(entry, member) };
        members.delete(member);
        dropped.push(memberDropped(name, member, `refused by the gate as ${refusal.code} at ${refusal.path}: ${refusal.message}`));
        changed = true;
      }
      if (members.size === 0) restored.delete(name);
    }
    if (!changed || restored.size === 0) break;
  }
  return { contract: { ...candidate, actionSpec }, dropped };
}

/**
 * One `REPAIR_ENTRY_DROPPED` per draft action entry the candidate no
 * longer carries under that name — renamed or removed by the repair (or
 * pruned by the loop's own placement pass) — always, because the members
 * it carried (`oneShot` above all) went with it and nothing else names
 * that. When the gate refused the NAME itself (`CTR_DUP_NAME` /
 * `CTR_RESERVED_NAME` at `actionSpec.<name>`, so the path is under
 * repair) the message says so and does not send the agent back to a
 * name the gate will refuse again. Empty when every draft entry survived,
 * and for drafts that declare no actions.
 */
export function findDroppedActionEntries(
  draft: unknown,
  candidate: DataContract,
  underRepair: ReadonlySet<string>,
): readonly SuggestionFinding[] {
  const draftActions = draftActionSpec(draft);
  if (draftActions === undefined) return [];
  const kept = candidate.actionSpec ?? {};
  return Object.keys(draftActions)
    .filter((name) => !Object.hasOwn(kept, name))
    .map((name) => ({
      code: REPAIR_ENTRY_DROPPED,
      severity: 'error',
      path: `actionSpec.${name}`,
      message: underRepair.has(`actionSpec.${name}`)
        ? `the gate refused the action name '${name}' (see the finding at this path) and the repair removed or renamed it; every member it carried, oneShot included, went with it — declare those members again under a name the gate accepts, via ggui_render override or a corrected re-handshake`
        : `the repair no longer carries the action '${name}' you declared (renamed or removed); every member it carried, oneShot included, went with it — re-declare it via ggui_render override or a corrected re-handshake`,
    }));
}
