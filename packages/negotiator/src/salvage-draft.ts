/**
 * `salvageConformingSubset` — the last-resort tier that replaces the
 * empty-contract fallback (ggui#523 item 3, "make `{}` impossible").
 *
 * When a draft cannot be made to conform any other way (no LLM bound,
 * provider down, repair budget exhausted), the negotiator used to hand
 * back the trivially-conforming `{}` with the findings attached — a
 * response the agent cannot tell apart from success: `action: create`,
 * a handshakeId, a `nextStep`, and a contract that declares NOTHING. The
 * paired render then paints a hollow shell, and the observed recovery
 * is a field-by-field bisect (No Silent Block, applied to contracts).
 *
 * This tier instead keeps what DOES conform. It deletes exactly the
 * entries the deterministic gate names — one offending property,
 * action, stream, context slot, or tool at a time (a bad sub-field
 * first, the whole entry only if that was not enough) — re-lints, and
 * repeats until the gate is green. The result is the agent's own draft
 * minus the parts the protocol refused, with every drop reported as a
 * finding, so the agent sees exactly what to fix in one read.
 *
 * It returns `null` — "nothing salvageable" — when what survives
 * declares no surface at all (no props, actions, streams, context
 * slots, or tools), or when an error is structural (the root is not an
 * object). `null` is the DECLINE signal: the caller answers
 * `action: 'declined'` with the findings, never a proposal. Between the
 * two, no path produces an empty contract on the agent's behalf.
 *
 * Deterministic and pure: no LLM, no mutation of the input, no throw.
 * Bounded: every iteration removes at least one key or returns.
 */
import {
  dataContractSchema,
  lintContract,
  type DataContract,
  type SuggestionFinding,
} from '@ggui-ai/protocol';

/** The six top-level spec keys the DataContract declares. */
const SPEC_KEYS = new Set([
  'propsSpec',
  'actionSpec',
  'streamSpec',
  'contextSpec',
  'agentCapabilities',
  'clientCapabilities',
]);

/** Spec maps whose direct children are the droppable entries. */
const ENTRY_MAP_SPECS = new Set(['actionSpec', 'streamSpec', 'contextSpec']);

/** Hard cap on gate iterations — every iteration deletes ≥1 key. */
const MAX_ROUNDS = 100;

export interface SalvageResult {
  /** A contract guaranteed to pass `lintContract` with zero errors, and to declare at least one surface. */
  readonly contract: DataContract;
  /**
   * What was removed to get there — one finding per deleted key, in
   * deletion order, carrying the gate's own code + message for that
   * path. Surfaced to the agent verbatim.
   */
  readonly dropped: readonly SuggestionFinding[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Does the contract declare at least one surface an agent could use? */
export function declaresAnySurface(contract: DataContract): boolean {
  const props = contract.propsSpec?.properties;
  if (props !== undefined && Object.keys(props).length > 0) return true;
  if (contract.actionSpec !== undefined && Object.keys(contract.actionSpec).length > 0) return true;
  if (contract.streamSpec !== undefined && Object.keys(contract.streamSpec).length > 0) return true;
  if (contract.contextSpec !== undefined && Object.keys(contract.contextSpec).length > 0) return true;
  const tools = contract.agentCapabilities?.tools;
  if (tools !== undefined && Object.keys(tools).length > 0) return true;
  return false;
}

/**
 * Where to cut for an offending path. Returns the key path to delete
 * (as segments) or `null` when the error is structural.
 *
 *   propsSpec.properties.<k>[.…]  → try the sub-field, then the property
 *   actionSpec|streamSpec|contextSpec.<k>[.…] → sub-field, then the entry
 *   agentCapabilities.tools.<k>[.…] → sub-field, then the tool
 *   <spec>[.other]               → the whole spec
 *   <unknown-top-level-key>[.…]  → that key (retired fields, typos)
 *   <root>                       → structural, null
 *
 * `leafFirst` picks the deeper cut when one exists; the caller retries
 * with `false` if that cut did not clear the entry.
 */
export function cutFor(path: string, leafFirst: boolean): readonly string[] | null {
  if (path === '' || path === '<root>') return null;
  const seg = path.split('.');
  const head = seg[0]!;

  if (head === 'propsSpec') {
    if (seg[1] === 'properties' && seg.length >= 3) {
      const entry = seg.slice(0, 3);
      return leafFirst && seg.length > 3 ? seg : entry;
    }
    return ['propsSpec'];
  }
  if (ENTRY_MAP_SPECS.has(head)) {
    if (seg.length >= 2) {
      const entry = seg.slice(0, 2);
      return leafFirst && seg.length > 2 ? seg : entry;
    }
    return [head];
  }
  if (head === 'agentCapabilities') {
    if (seg[1] === 'tools' && seg.length >= 3) {
      const entry = seg.slice(0, 3);
      return leafFirst && seg.length > 3 ? seg : entry;
    }
    return ['agentCapabilities'];
  }
  if (SPEC_KEYS.has(head)) return [head];
  // Unknown / retired top-level field — the whole key goes.
  return [head];
}

/** Delete `keyPath` from a structural copy of `root`; false if absent. */
function deleteAt(root: Record<string, unknown>, keyPath: readonly string[]): boolean {
  let node: Record<string, unknown> = root;
  for (let i = 0; i < keyPath.length - 1; i += 1) {
    const next = node[keyPath[i]!];
    if (!isRecord(next)) return false;
    // Copy-on-write down the path so the input is never mutated.
    const copy: Record<string, unknown> = { ...next };
    node[keyPath[i]!] = copy;
    node = copy;
  }
  const leaf = keyPath[keyPath.length - 1]!;
  if (!(leaf in node)) return false;
  delete node[leaf];
  // A dropped prop must leave `propsSpec.required` too — a stale name
  // there is its own gate error and would only cost another round.
  if (keyPath.length === 3 && keyPath[0] === 'propsSpec' && keyPath[1] === 'properties') {
    const ps = root['propsSpec'];
    if (isRecord(ps) && Array.isArray(ps['required'])) {
      root['propsSpec'] = {
        ...ps,
        required: ps['required'].filter((name) => name !== leaf),
      };
    }
  }
  return true;
}

/**
 * Keep the conforming subset of `draft` (already normalized by the
 * caller, ideally). See the module docstring for the contract.
 */
export function salvageConformingSubset(draft: unknown): SalvageResult | null {
  if (!isRecord(draft)) return null;
  let working: Record<string, unknown> = { ...draft };
  const dropped: SuggestionFinding[] = [];
  /** Cuts already tried at leaf depth for a path — the retry goes to the entry. */
  const leafTried = new Set<string>();

  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const lint = lintContract(working);
    if (lint.errors.length === 0) {
      // Shape passed ⇒ the strict parse cannot throw.
      const contract = dataContractSchema.parse(working);
      return declaresAnySurface(contract) ? { contract, dropped } : null;
    }
    let cutSomething = false;
    for (const issue of lint.errors) {
      const leafFirst = !leafTried.has(issue.path);
      const cut = cutFor(issue.path, leafFirst);
      if (cut === null) return null; // structural — nothing to keep
      const cutKey = cut.join('.');
      if (leafFirst && cutKey === issue.path) leafTried.add(issue.path);
      const next: Record<string, unknown> = { ...working };
      if (!deleteAt(next, cut)) {
        // The path names something that is not there (a reference
        // target, a computed check) — fall back to the entry cut once,
        // then give up on this issue for the round.
        if (leafFirst) {
          leafTried.add(issue.path);
          const entryCut = cutFor(issue.path, false);
          if (entryCut !== null && deleteAt(next, entryCut)) {
            working = next;
            dropped.push({ code: issue.code, severity: 'error', path: entryCut.join('.'), message: issue.message });
            cutSomething = true;
            break;
          }
        }
        continue;
      }
      working = next;
      dropped.push({ code: issue.code, severity: 'error', path: cutKey, message: issue.message });
      cutSomething = true;
      break; // one cut per round — re-lint before the next decision
    }
    if (!cutSomething) return null; // no cut could be applied — structural
  }
  return null;
}
