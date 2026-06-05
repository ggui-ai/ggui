/**
 * Programmatic safety validators for `DataContract` shapes.
 *
 * Two detectors live here:
 *
 *   - {@link validateContractStructure} — pure structural heuristics that
 *     flag over-specified contracts without any runtime dependency. The
 *     load-bearing finding is `redundant-action`: an empty-payload
 *     `actionSpec` entry whose name parses as a mutator of an existing
 *     `contextSpec` slot. Real example that motivated this module: a
 *     synthesizer emitted both `actionSpec.increment` (empty payload)
 *     and `contextSpec.count` for a counter widget. The generator wired
 *     the increment button to `useAction("increment")`, dispatching to
 *     the agent instead of locally bumping the count slot — a button
 *     that looks right but does nothing. The structural fix is to
 *     declare `actionSpec[X]` IFF X is a discrete event the agent must
 *     witness; mutators of context slots use the slot setter.
 *
 *   - {@link validateContractNovelty} — embeds the contract via the
 *     shared `summarizeContract` helper and computes cosine distance to
 *     the nearest registered blueprint. Distance above the threshold
 *     yields a `novel-shape` finding so operators can review before the
 *     contract pollutes the registry's neighborhood.
 *
 * Both validators return a `ContractValidationResult` carrying readonly
 * findings — callers (synthesizer, registerBlueprint) decide how to act
 * on warnings vs errors. Findings are deterministic; no LLM judgment.
 */

import type { DataContract, JsonSchema } from '@ggui-ai/protocol';
import { summarizeContract } from '@ggui-ai/protocol';
import type {
  EmbeddingProvider,
  VectorStore,
} from '@ggui-ai/mcp-server-core';

// =============================================================================
// Public types
// =============================================================================

/**
 * Discriminated finding kinds. Each kind documents a distinct
 * structural signal — consumers MAY render them differently
 * (`redundant-action` is a code smell on the synthesizer side;
 * `novel-shape` is an operator-review prompt).
 *
 * Open-ended for forward compat: future detectors (e.g.,
 * `unreachable-stream-channel`, `payload-collision`) add to the union
 * without breaking consumers that switch with a default arm.
 */
export type ContractValidationFindingKind =
  | 'redundant-action'
  | 'novel-shape'
  | 'actions-vs-context-name-collision'
  | 'action-name-looks-state-y'
  | 'context-name-looks-action-y'
  | 'incoherent-no-data-surface'
  | 'context-props-name-collision'
  | (string & {});

/**
 * One observation about a contract. `severity` is `'warn'` for
 * heuristics that may produce false positives — current default for
 * the structural detector. `'error'` is reserved for unambiguous
 * contract bugs once we have evidence the heuristic doesn't false-
 * positive at production volume.
 */
export interface ContractValidationFinding {
  readonly kind: ContractValidationFindingKind;
  readonly severity: 'warn' | 'error';
  readonly actionName?: string;
  readonly slotName?: string;
  readonly cosine?: number;
  readonly hint: string;
}

export interface ContractValidationResult {
  readonly findings: readonly ContractValidationFinding[];
}

/**
 * Dependencies the novelty detector needs. Embedding provider + vector
 * store are the same seams the negotiator's RAG path uses, so the
 * novelty check operates over the production index without any extra
 * infrastructure.
 */
export interface ContractValidationNoveltyDeps {
  readonly embedding: EmbeddingProvider;
  readonly vectorStore: VectorStore;
  /** Tenant / partition the nearest-neighbor query runs against. Same
   * semantics as `RagSearchInput.scope`. */
  readonly scope: string;
}

export interface ContractValidationNoveltyOptions {
  /**
   * Cosine distance threshold above which the contract is flagged as
   * novel. Distance is `1 - cosine_similarity`. Default `0.8` —
   * matches the negotiator's `RETRIEVAL_MIN_SCORE = 0.15` (=cosine
   * similarity 0.15, distance 0.85) one-tail boundary, with a small
   * buffer so contracts that hover near retrieval but slightly above
   * still flag for review.
   */
  readonly thresholdCosine?: number;
}

// =============================================================================
// Mutator verb dictionary
// =============================================================================

/**
 * Verbs whose presence at the START of an action name signals "this
 * action mutates state the agent observes" — i.e., a candidate slot
 * setter masquerading as an action.
 *
 * Scope decisions (in vs out):
 *
 *   IN: verbs that almost always mutate observable state in
 *   counter/list/form/UI patterns we've seen in benchmark traces.
 *
 *   OUT: verbs that often LOOK like mutators but legitimately want
 *   the agent in the loop:
 *     - `submit`  — submit IS the discrete event; the agent must
 *                   witness "user pressed submit" beyond the form's
 *                   draft slot. Form pattern is `actionSpec.submit` +
 *                   `contextSpec.formData` (legitimate pairing).
 *     - `save`    — save typically triggers a wired tool (write to
 *                   storage). Same pattern as submit.
 *     - `cancel`  — discrete user gesture, not a slot mutation.
 *     - `confirm` — discrete user gesture.
 *     - `select`  — selection often IS the slot value (e.g., select
 *                   reduces to setting `selectedId`), but it's also
 *                   used as a discrete event ("user picked X, fetch
 *                   detail"). Out by default; false-negatives here
 *                   are cheaper than false-positives.
 *     - `open`/`close` — often dialog gestures, not slot mutations.
 *
 * Authors who want a tighter or looser policy override the list at
 * call site (option for future expansion — not exposed yet to keep
 * the API minimal).
 */
const MUTATOR_VERBS: readonly string[] = [
  'increment',
  'decrement',
  'reset',
  'set',
  'add',
  'remove',
  'delete',
  'update',
  'change',
  'toggle',
  'flip',
  'clear',
  'append',
  'prepend',
  'insert',
];

/**
 * Returns the mutator verb that prefixes `actionName`, or `null` when
 * none does. Matches case-insensitively and only at the START — `set`
 * matches `setCount` but not `unsetCount`; `reset` is its own verb (not
 * `set` + `Count` with a leading `re`).
 *
 * Strict longest-match: when multiple verbs are valid prefixes (e.g.
 * `reset` is also matched by `set`-with-`re`-prefix only via different
 * boundary, but we don't allow that), we walk verbs longest-first so
 * `reset*` is parsed as `reset|*` not `re|set*`.
 */
function stripMutatorVerb(actionName: string): {
  verb: string;
  remainder: string;
} | null {
  if (actionName.length === 0) return null;
  const lower = actionName.toLowerCase();
  // Longest-prefix-first to disambiguate `reset` vs (hypothetical) `re`.
  const sorted = [...MUTATOR_VERBS].sort((a, b) => b.length - a.length);
  for (const verb of sorted) {
    if (!lower.startsWith(verb)) continue;
    const tail = actionName.slice(verb.length);
    // Boundary: either the verb consumed the whole name, or the
    // character after the verb is a word boundary (uppercase letter,
    // digit, or underscore — typical camelCase / snake_case break).
    if (tail.length === 0) {
      return { verb, remainder: '' };
    }
    const next = tail.charAt(0);
    const isBoundary =
      (next >= 'A' && next <= 'Z') ||
      (next >= '0' && next <= '9') ||
      next === '_';
    if (!isBoundary) continue;
    return { verb, remainder: tail };
  }
  return null;
}

/**
 * Decide whether an action name with a mutator-verb prefix targets the
 * given context slot.
 *
 * Algorithm:
 *
 *   1. Strip the verb prefix → remainder.
 *   2. Empty remainder (action is just the verb, e.g., "increment")
 *      AND the contract has exactly one context slot ⇒ flag.
 *   3. Non-empty remainder ⇒ flag iff remainder contains slotName OR
 *      slotName contains remainder, case-insensitively. This catches
 *      `incrementCount` ↔ `count`, `setUserName` ↔ `userName`,
 *      `addItem` ↔ `items`, etc., without false-positiving on
 *      `setTheme` ↔ `count`.
 *
 * The single-slot case is the load-bearing one for the counter bug:
 * `increment` (no remainder) + the only slot being `count` is the
 * exact pattern.
 */
function nameImpliesMutation(args: {
  actionName: string;
  slotName: string;
  totalSlots: number;
}): boolean {
  const { actionName, slotName, totalSlots } = args;
  const stripped = stripMutatorVerb(actionName);
  if (!stripped) return false;
  if (stripped.remainder.length === 0) {
    return totalSlots === 1;
  }
  const a = stripped.remainder.toLowerCase();
  const b = slotName.toLowerCase();
  return a.includes(b) || b.includes(a);
}

// =============================================================================
// Empty-payload detection
// =============================================================================

/**
 * True when an action's schema is "empty payload" — either omitted
 * entirely or the canonical `{type:'object', properties:{},
 * additionalProperties:false}` shape the synthesizer emits when the LLM
 * declines to declare fields. Actions with declared payload fields
 * (e.g., `{chipText: string}`) are NOT empty — those legitimately
 * carry data the agent needs.
 */
function isEmptyPayloadSchema(schema: JsonSchema | undefined): boolean {
  if (schema === undefined) return true;
  if (schema.type !== 'object') return false;
  if (schema.properties === undefined) return true;
  return Object.keys(schema.properties).length === 0;
}

// =============================================================================
// Structural validator (synchronous, dependency-free)
// =============================================================================

/**
 * Run the synchronous structural detectors against `contract`.
 *
 * Currently:
 *   - `redundant-action`: empty-payload action whose name parses as a
 *     mutator of an existing context slot.
 *
 * Returns an empty findings array for contracts that don't trip any
 * heuristic.
 */
export function validateContractStructure(
  contract: DataContract,
): ContractValidationResult {
  const findings: ContractValidationFinding[] = [];
  const actionSpec = contract.actionSpec;
  const contextSpec = contract.contextSpec;
  if (!actionSpec || !contextSpec) {
    return { findings };
  }
  const slotNames = Object.keys(contextSpec);
  if (slotNames.length === 0) {
    return { findings };
  }
  for (const [actionName, entry] of Object.entries(actionSpec)) {
    if (!isEmptyPayloadSchema(entry.schema)) continue;
    for (const slotName of slotNames) {
      if (
        !nameImpliesMutation({
          actionName,
          slotName,
          totalSlots: slotNames.length,
        })
      ) {
        continue;
      }
      findings.push({
        kind: 'redundant-action',
        severity: 'warn',
        actionName,
        slotName,
        hint: `Action "${actionName}" has empty payload and looks like a mutator of context slot "${slotName}". Prefer setting the slot directly from the component instead of declaring an action — the agent observes slot changes without a discrete event.`,
      });
      break;
    }
  }
  return { findings };
}

// =============================================================================
// Actions-vs-context placement validator (synchronous, loose / advisory)
// =============================================================================
//
// Loose self-check: every finding is `severity: 'warn'`. Synth's
// pipeline can log warnings to telemetry without blocking output. The
// rule being checked: actions drive agent turns, context observes
// state, and there is no third category.
//
// Three checks, each scoped narrowly to avoid false positives:
//
//   1. Name collision across specs — same key in both actionSpec and
//      contextSpec. Structurally a category error: synth couldn't
//      decide which bucket. High-confidence rule.
//
//   2. State-y name in actionSpec — names matching common state-mirror
//      patterns (autosave, draft, typing, change, focus, blur, …).
//      These usually represent continuous state, not turn-driving
//      events. Warning, not error — false positives possible (a real
//      "submitDraft" action is legitimate).
//
//   3. Action-y name in contextSpec — names matching common terminal
//      verbs (submit, send, confirm, cancel, next, done, apply, …).
//      These usually represent discrete events, not state. Warning,
//      not error — false positives possible (a "submitTime" timestamp
//      slot is legitimate state).
//
// All three checks are intentionally LOOSE. They surface candidates;
// consumers (synth, operator dashboards) decide to act on them.

const STATE_LIKE_NAME_PATTERN =
  /^(auto|on)?(save|draft|change|update|sync|saved|typing|scroll|hover|focus|blur|input)/i;

const ACTION_LIKE_NAME_PATTERN =
  /^(submit|send|confirm|cancel|next|back|done|apply|delete|create|approve|reject)$/i;

/**
 * Validate the actions-vs-context placement rule: actions drive agent
 * turns, context observes state. Findings 1-3 are advisory `warn`;
 * finding 4 (`context-props-name-collision`) is `error` — it is a
 * SPEC §2.10 MUST. Synth pipelines use it as a self-check over their
 * own output.
 *
 * Four findings:
 *
 *   - `actions-vs-context-name-collision` — same key appears in both
 *     `actionSpec` AND `contextSpec`. Synth couldn't decide which
 *     bucket. Pick one.
 *
 *   - `action-name-looks-state-y` — `actionSpec` entry name matches a
 *     state-mirror pattern (autosave, draft, typing, change, …). The
 *     thing might be observable state (continuous) rather than a
 *     turn-driving event. Consider `contextSpec`.
 *
 *   - `context-name-looks-action-y` — `contextSpec` entry name matches
 *     a discrete-event pattern (submit, send, confirm, …). The thing
 *     might be a one-shot event the agent reacts to. Consider
 *     `actionSpec`.
 *
 *   - `context-props-name-collision` (ERROR) — a `contextSpec` slot key
 *     equals a `propsSpec` property name. SPEC §2.10 MUST: the
 *     generated boilerplate would shadow the prop binding.
 *
 * Pure / synchronous / no dependencies. Safe to call on every synth
 * output without measurable cost.
 */
export function validateActionsVsContext(
  contract: DataContract,
): ContractValidationResult {
  const findings: ContractValidationFinding[] = [];
  const actionKeys = Object.keys(contract.actionSpec ?? {});
  const contextKeys = Object.keys(contract.contextSpec ?? {});

  // 1. Same key in both specs — category collision.
  for (const k of actionKeys) {
    if (contextKeys.includes(k)) {
      findings.push({
        kind: 'actions-vs-context-name-collision',
        severity: 'warn',
        actionName: k,
        slotName: k,
        hint: `"${k}" appears in both actionSpec and contextSpec. Pick one — actions drive agent turns; contextSpec is observed state.`,
      });
    }
  }

  // 2. State-y name in actionSpec.
  for (const k of actionKeys) {
    if (STATE_LIKE_NAME_PATTERN.test(k)) {
      findings.push({
        kind: 'action-name-looks-state-y',
        severity: 'warn',
        actionName: k,
        hint: `actionSpec entry "${k}" sounds like state (autosave/draft/change/etc.). If it doesn't drive an agent turn, consider contextSpec instead.`,
      });
    }
  }

  // 3. Action-y name in contextSpec.
  for (const k of contextKeys) {
    if (ACTION_LIKE_NAME_PATTERN.test(k)) {
      findings.push({
        kind: 'context-name-looks-action-y',
        severity: 'warn',
        slotName: k,
        hint: `contextSpec entry "${k}" sounds like a discrete event (submit/send/confirm/etc.). If it drives an agent turn, consider actionSpec instead.`,
      });
    }
  }

  // 4. contextSpec slot key collides with a propsSpec property name.
  // SPEC §2.10 MUST — the generated boilerplate binds both into the
  // same scope, so a collision would shadow the prop. The protocol's
  // `CTR_DUP_NAME` only covers action/stream/context collisions, NOT
  // props↔context — so this is the one cross-spec collision the synth
  // gate would otherwise miss. `error` severity → the synth's repair
  // loop fixes it.
  const propKeys = Object.keys(contract.propsSpec?.properties ?? {});
  for (const k of contextKeys) {
    if (propKeys.includes(k)) {
      findings.push({
        kind: 'context-props-name-collision',
        severity: 'error',
        slotName: k,
        hint: `contextSpec slot "${k}" collides with propsSpec.properties.${k} — the generated boilerplate would shadow the prop binding. Rename one of them.`,
      });
    }
  }

  return { findings };
}

// =============================================================================
// Coherence validator (synchronous, intent-aware — the one validator
// that reads the intent, not just the contract)
// =============================================================================
//
// Catches the "degenerate contract" flake: the synthesizer occasionally
// emits a contract that is JUST an actionSpec with no data surface at
// all — no contextSpec, no propsSpec, no streamSpec, no
// clientCapabilities. The agent then receives a contentless event it
// cannot act on (a `finish` for a checkout it has no data for; a
// `share` for an article it was never given).
//
// `{actionSpec: {confirm, cancel}}` with no data surface is the ONE
// legitimate no-surface shape (a pure-decision modal) — so the rule is
// gated on the intent: it fires only when the intent describes a UI
// that demonstrably displays or collects data (a flow / form / article
// / profile / …). A pure-decision modal intent matches none of those,
// so it is never flagged.

/**
 * Intent signal for "this UI displays or collects data, so the
 * contract MUST declare a data surface." Deliberately narrow — every
 * keyword is an intent that genuinely cannot work as actionSpec-only.
 */
// `card` and `flow` are deliberately EXCLUDED — too common in English
// ("a card to confirm this flow" is a legit pure-decision modal). The
// flow-* corpus intents still match via `wizard` / `checkout` /
// `onboard` / `multi-step`, so coverage is unchanged.
const DATA_SURFACE_INTENT_PATTERN =
  /\bwizard\b|multi-?step|\d+-step|\bcheckout\b|\bonboard|\barticle\b|\bdocument\b|\bprofile\b|\bdashboard\b|\bform\b|\breport\b|\beditor\b/i;

/**
 * Validate that a contract is coherent with its intent. The only
 * intent-aware validator: it reads the natural-language intent
 * alongside the contract.
 *
 * One rule — `incoherent-no-data-surface`: the intent describes a
 * data-bearing UI but the contract declares only EMPTY-payload
 * actions, with no contextSpec / propsSpec / streamSpec /
 * clientCapabilities. That contract is structurally degenerate — the
 * agent gets a contentless event with nothing behind it. Emitted at
 * `severity: 'error'` so the synth's repair loop retries (the
 * contract is protocol-valid, so nothing else flags it).
 *
 * The empty-payload condition matters: an action that DOES carry a
 * payload (e.g. an `autosave` action whose schema includes the draft
 * text) gives the agent data through the payload — that is not
 * degenerate and is NOT flagged.
 *
 * Pure / synchronous. The rule fires ONLY on the degenerate output —
 * a correct contract for any data-bearing intent always has a
 * surface, so it never false-positives on good output.
 */
export function validateContractCoherence(
  contract: DataContract,
  intent: string,
): ContractValidationResult {
  const findings: ContractValidationFinding[] = [];
  const actions = contract.actionSpec ?? {};
  const hasAction = Object.keys(actions).length > 0;
  const allActionsEmptyPayload = Object.values(actions).every((a) =>
    isEmptyPayloadSchema(a.schema),
  );
  const hasContext =
    contract.contextSpec !== undefined &&
    Object.keys(contract.contextSpec).length > 0;
  const hasProps =
    contract.propsSpec?.properties !== undefined &&
    Object.keys(contract.propsSpec.properties).length > 0;
  const hasStream =
    contract.streamSpec !== undefined &&
    Object.keys(contract.streamSpec).length > 0;
  const hasGadgets =
    contract.clientCapabilities?.gadgets !== undefined &&
    Object.keys(contract.clientCapabilities.gadgets).length > 0;

  if (
    hasAction &&
    allActionsEmptyPayload &&
    !hasContext &&
    !hasProps &&
    !hasStream &&
    !hasGadgets &&
    DATA_SURFACE_INTENT_PATTERN.test(intent)
  ) {
    findings.push({
      kind: 'incoherent-no-data-surface',
      severity: 'error',
      hint: 'The intent describes a UI that displays or collects data, but the contract declares only an actionSpec — no contextSpec, propsSpec, or streamSpec. The agent would receive an event with nothing behind it. Declare the data surface: contextSpec for state the user enters / the UI tracks (a wizard\'s step + form fields), or propsSpec for content the agent supplies at render (an article, a profile).',
    });
  }
  return { findings };
}

// =============================================================================
// Novelty validator (async, depends on embedding + vector store)
// =============================================================================

const DEFAULT_NOVELTY_THRESHOLD_COSINE = 0.8;

/**
 * Run the cosine-distance novelty detector. Embeds the contract via
 * `summarizeContract` and queries the vector store for the nearest
 * neighbor in `scope`. Distance above `thresholdCosine` yields a
 * `novel-shape` finding so operators see "this contract is far from
 * anything we've registered — review encouraged" before it ships.
 *
 * Defaults to `severity: 'warn'`. Distance is computed as
 * `1 - cosineSimilarity`; `VectorStore.query` returns
 * cosine-similarity scores in `[0, 1]` per the seam contract.
 *
 * Empty index (no nearest neighbor in scope) ⇒ flag with
 * `cosine: undefined` because a fresh registry will register
 * everything as novel; operators learn that the registry is empty.
 */
export async function validateContractNovelty(
  contract: DataContract,
  deps: ContractValidationNoveltyDeps,
  options: ContractValidationNoveltyOptions = {},
): Promise<ContractValidationResult> {
  const threshold = options.thresholdCosine ?? DEFAULT_NOVELTY_THRESHOLD_COSINE;
  const summary = summarizeContract(contract);
  const queryEmbedding = await deps.embedding.embed(summary);
  const results = await deps.vectorStore.query(deps.scope, queryEmbedding, 1);
  if (results.length === 0) {
    return {
      findings: [
        {
          kind: 'novel-shape',
          severity: 'warn',
          hint: `No registered blueprints in scope "${deps.scope}" — this contract has no neighbors. Review encouraged before it becomes the seed for the registry.`,
        },
      ],
    };
  }
  const nearest = results[0];
  if (!nearest) {
    return { findings: [] };
  }
  const distance = 1 - nearest.score;
  if (distance < threshold) {
    return { findings: [] };
  }
  return {
    findings: [
      {
        kind: 'novel-shape',
        severity: 'warn',
        cosine: nearest.score,
        hint: `Cosine distance ${distance.toFixed(3)} from nearest registered blueprint exceeds threshold ${threshold.toFixed(3)} — review encouraged before the contract pollutes the registry's neighborhood.`,
      },
    ],
  };
}

/**
 * GguiSession a findings array as a single human-readable line for use in
 * synthesizer `reason` strings, cache trace events, and operator logs.
 * Empty findings → empty string so callers can append unconditionally.
 */
export function formatValidationFindings(
  result: ContractValidationResult,
): string {
  if (result.findings.length === 0) return '';
  return result.findings
    .map((f) => `[${f.severity}:${f.kind}] ${f.hint}`)
    .join(' | ');
}
