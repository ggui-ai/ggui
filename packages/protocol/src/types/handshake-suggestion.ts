/**
 * Handshake-suggestion shapes (2026-05-12).
 *
 * The three-step handshake protocol replaces the older `match` + `plan`
 * framing on the handshake output.
 *
 * Step 1 — the agent posts a `BlueprintDraft` (its idea: contract +
 * optional variance + optional generator hint).
 *
 * Step 2 — the server runs `BlueprintSearch` + contract validation in
 * parallel and returns a {@link HandshakeSuggestion}. The suggestion's
 * `origin` enum routes the agent's next decision:
 *
 *   - `cache`  — search-score crossed the per-app threshold; cached
 *                code wins. `blueprintMeta.codeHash` is present.
 *   - `agent`  — search missed but validation passed; gen pending
 *                against the agent's draft. Provisional blueprintId.
 *   - `synth`  — search missed AND validation failed; synth amended
 *                the contract. Provisional blueprintId; `amendments`
 *                carries the diff vs the agent's draft.
 *
 * Step 3 — the agent posts a `PushDecision` (accept the suggestion or
 * override with a fresh draft). Accept reuses the provisional
 * `blueprintId`; override mints a fresh one.
 *
 * Locked decisions:
 *
 *   - `blueprintMeta` is ALWAYS present on a successful handshake
 *     (Option B from §D5). `codeHash` is the only field that's absent
 *     on non-cache origins.
 *   - `amendments` is populated only on `origin: 'synth'`. On `cache`
 *     and `agent` origins it MUST be omitted.
 *   - `validationFindings` is populated only when validators ran AND
 *     produced findings — on cache hits these surface as a soft
 *     warning ("your draft would've had X issue — using cached
 *     blueprint instead"); on agent/synth they're carried for
 *     telemetry only (synth's amendment already addressed them).
 */
import type { Blueprint, BlueprintVariance } from './blueprint.js';
import type { DataContract, JsonValue } from './data-contract.js';

/**
 * Where the handshake's `blueprintMeta` came from. Routes the agent's
 * cognitive model:
 *
 *   - `cache`  — an existing blueprint matched at or above the per-app
 *                threshold. `blueprintMeta.codeHash` is present; the
 *                paired `ggui_render({decision: {kind: 'accept'}})`
 *                short-circuits to cache delivery.
 *   - `agent`  — no cache hit, but the agent's draft validated cleanly.
 *                `codeHash` absent; gen runs on push against the
 *                agent's draft contract verbatim.
 *   - `synth`  — no cache hit AND validation failed. The synth
 *                amender produced a new contract; the diff vs the
 *                agent's draft is in `amendments.contractDiff`.
 */
export type SuggestionOrigin = 'cache' | 'agent' | 'synth';

/**
 * Agent's draft on the handshake input — what the agent wants to
 * build. The contract is required; variance + generator are optional
 * hints. The server combines this with its own session/app context
 * (cached blueprints, validator outcomes, operator pins) to produce
 * a {@link HandshakeSuggestion}.
 */
export interface BlueprintDraft {
  /**
   * Agent-authored DataContract. Drives both the blueprint-search
   * embed/structural axes and the contract validators. The agent is
   * the contract authority; synth amends only when validation fails.
   */
  readonly contract: DataContract;
  /**
   * Optional variance tags. Carried through to the suggestion's
   * `blueprintMeta.variance` field; if `decision: 'accept'` lands on a
   * fresh-gen path (origin === 'agent' or 'synth'), the persisted
   * Blueprint row inherits these tags.
   */
  readonly variance?: {
    /** Free-form persona tag (e.g. 'minimalist', 'data-dense'). */
    readonly persona?: string;
    /** Aesthetic tag — promoted to first-class in a future slice. */
    readonly aesthetic?: string;
    /** Small structured signal — JSON-safe. */
    readonly context?: { readonly [key: string]: JsonValue | undefined };
    /** Raw style hint / seed prompt. */
    readonly seedPrompt?: string;
  };
  /**
   * Generator slug hint (e.g. `'ui-gen-advanced-opus-4-7'`). The
   * server resolves the effective generator as:
   *
   *   1. Operator app-pin (`App.pinnedGenerator`) — wins if set.
   *   2. This hint — if registered in the GeneratorRegistry.
   *   3. Registry default (`ui-gen-default-haiku-4-5`).
   *
   * Hint-only; unknown slugs fall through to the registry default.
   */
  readonly generator?: string;
}

/**
 * Blueprint metadata projected onto the handshake response. The agent
 * uses this to decide whether to accept (reuse the provisional id) or
 * override (mint a fresh id with its own new draft).
 *
 * `blueprintId` is PROVISIONAL — it becomes durable iff the paired
 * push sends `decision: 'accept'`. An override discards it.
 */
export interface BlueprintMeta {
  /**
   * Provisional blueprint id. Server-minted at handshake-time.
   * Becomes durable when push accepts; discarded on push override.
   */
  readonly blueprintId: string;
  /** Canonical RFC 8785 (JCS) hash of the suggestion's contract. */
  readonly contractHash: string;
  /**
   * Content hash of the cached code body. Present iff `origin ===
   * 'cache'`. Absent for `agent` / `synth` (gen pending).
   */
  readonly codeHash?: string;
  /** Slug of the generator that produced (or will produce) the code. */
  readonly generator: string;
  /** Variance tags carried through from the suggestion. */
  readonly variance: BlueprintVariance;
  /**
   * Optional matcher telemetry — why this blueprint was selected.
   * Operator-readable; LLM-readable. E.g. `'contract-hash, persona →
   * score 0.92'`.
   */
  readonly selectedReason?: string;
}

/**
 * Validator finding surfaced on the suggestion. Mirrors
 * `@ggui-ai/protocol/validation/lint-contract`'s `ContractIssue` shape
 * loosely — kept structural here so the suggestion contract doesn't
 * import from the linter module and create a tight cycle.
 *
 * Each finding has a stable `code`, a severity, the dotted-path
 * location, and a human-readable `message`.
 */
export interface SuggestionFinding {
  /** Stable error code (e.g. `'CTR_REF_NEXT_STEP'`, `'CTR_DUP_NAME'`). */
  readonly code: string;
  readonly severity: 'error' | 'warn';
  /** Dotted JS-style path into the contract. */
  readonly path: string;
  /** Human-readable violation prose. */
  readonly message: string;
}

/**
 * Synth's amendment — the diff vs the agent's draft. Populated only on
 * `origin: 'synth'`.
 *
 * `contractDiff` is an RFC 6902 JSON-Patch-style array; the diff
 * applied to the agent's draft yields the suggestion's contract.
 * Helpers in `@ggui-ai/protocol/validation/contract-diff` produce and
 * apply the diff.
 *
 * `reasoning` is the synth model's natural-language explanation —
 * "added required `submit` action so the form completion is
 * observable", etc.
 */
export interface SuggestionAmendments {
  readonly contractDiff: JsonPatch;
  readonly reasoning: string;
}

/**
 * Minimal RFC 6902 JSON-Patch shape carried in handshake-suggestion
 * amendments. The protocol re-exports this so consumers can apply /
 * inspect patches without an external dependency.
 *
 * Subset support — every emitter MUST honor `add` / `remove` /
 * `replace`; `move` / `copy` / `test` are reserved for future use
 * (consumers MAY reject unrecognized ops).
 */
export type JsonPatch = readonly JsonPatchOp[];

export type JsonPatchOp =
  | { readonly op: 'add'; readonly path: string; readonly value: JsonValue }
  | { readonly op: 'remove'; readonly path: string }
  | { readonly op: 'replace'; readonly path: string; readonly value: JsonValue };

/**
 * The full handshake suggestion. Produced by the server in step-2 of
 * the three-step handshake; the agent reads this in the response and
 * branches its push decision on `origin` (accept vs override).
 */
export interface HandshakeSuggestion {
  /** Routing discriminator — see {@link SuggestionOrigin}. */
  readonly origin: SuggestionOrigin;
  /** Operator-readable + LLM-readable rationale ("contract-hash → score 0.92"). */
  readonly rationale: string;
  /** Provisional blueprint metadata — see {@link BlueprintMeta}. */
  readonly blueprintMeta: BlueprintMeta;
  /**
   * Populated iff `origin === 'synth'`. Carries the JSON-Patch diff
   * vs the agent's draft and the synth model's reasoning.
   */
  readonly amendments?: SuggestionAmendments;
  /**
   * Populated iff validators ran AND produced findings. On `origin:
   * 'cache'` these surface as a soft warning (the agent's draft
   * WOULD have had issues, but the cached blueprint is being served);
   * on `agent` / `synth` they're absent (agent path's validators
   * passed; synth path's amendments already addressed them).
   */
  readonly validationFindings?: readonly SuggestionFinding[];
}

/**
 * Decision discriminator on the push input. Replaces the old
 * `{contract? | contractHash?}` triad with a clearer accept-vs-
 * override branch.
 *
 *   - `accept`   — use the handshake's `blueprintMeta` verbatim.
 *                  If `codeHash` is present (origin === 'cache'),
 *                  delivery is a fast cache fetch. Otherwise gen
 *                  runs against the suggestion's stored contract.
 *   - `override` — mint a fresh blueprintId and run gen against the
 *                  agent's NEW draft. The provisional id from the
 *                  handshake is discarded.
 */
export type PushDecision =
  | { readonly kind: 'accept' }
  | { readonly kind: 'override'; readonly blueprintDraft: BlueprintDraft };

/**
 * Build a minimal JSON-Patch RFC 6902 diff between two contracts.
 *
 * Algorithm: shallow walk over the union of top-level keys; for each
 * key, recurse into nested objects, otherwise emit `add` / `remove` /
 * `replace` at the appropriate path. Arrays are diffed as whole values
 * (no LCS) — sufficient for the synth-amendment use case where the
 * synth model rewrites slot/action maps wholesale rather than
 * splicing single array elements.
 *
 * Output is a {@link JsonPatch}; applying it to `before` produces
 * `after` (modulo array-element identity).
 *
 * Pure / deterministic. Exposed so synth implementations don't need
 * to ship their own diff helper.
 */
export function jsonPatch(before: unknown, after: unknown): JsonPatch {
  const ops: JsonPatchOp[] = [];
  buildPatchOps(before, after, '', ops);
  return Object.freeze(ops);
}

function buildPatchOps(
  before: unknown,
  after: unknown,
  path: string,
  ops: JsonPatchOp[],
): void {
  if (before === after) return;
  // null / primitive replacements
  if (
    before === null ||
    after === null ||
    typeof before !== 'object' ||
    typeof after !== 'object'
  ) {
    ops.push({ op: 'replace', path, value: after as JsonValue });
    return;
  }
  const beforeArr = Array.isArray(before);
  const afterArr = Array.isArray(after);
  if (beforeArr !== afterArr) {
    // Whole-value replace when the kind flips (object ↔ array).
    ops.push({ op: 'replace', path, value: after as JsonValue });
    return;
  }
  if (beforeArr && afterArr) {
    // Whole-array replace — sufficient for amendment diffs.
    ops.push({ op: 'replace', path, value: after as JsonValue });
    return;
  }
  // Both are plain objects.
  const beforeObj = before as { readonly [k: string]: unknown };
  const afterObj = after as { readonly [k: string]: unknown };
  const keys = new Set<string>([...Object.keys(beforeObj), ...Object.keys(afterObj)]);
  for (const key of keys) {
    const childPath = `${path}/${encodeJsonPointerSegment(key)}`;
    const inBefore = Object.prototype.hasOwnProperty.call(beforeObj, key);
    const inAfter = Object.prototype.hasOwnProperty.call(afterObj, key);
    if (!inAfter) {
      ops.push({ op: 'remove', path: childPath });
      continue;
    }
    if (!inBefore) {
      ops.push({ op: 'add', path: childPath, value: afterObj[key] as JsonValue });
      continue;
    }
    buildPatchOps(beforeObj[key], afterObj[key], childPath, ops);
  }
}

/**
 * Encode a single JSON-Pointer segment per RFC 6901 §4: `~` → `~0`,
 * `/` → `~1`. Other characters pass through unchanged.
 */
function encodeJsonPointerSegment(seg: string): string {
  return seg.replace(/~/g, '~0').replace(/\//g, '~1');
}

/**
 * Top-N alternative blueprints surfaced on the handshake response.
 * Agents can override into one of these (push with `decision:
 * 'override'`) — the alternatives are full {@link Blueprint} rows so
 * the agent inspects everything it needs to decide.
 *
 * Sorted by descending match score; the suggestion's primary
 * `blueprintMeta` is NOT duplicated here (the alternatives are
 * what the search returned EXCLUDING the top result that became the
 * primary).
 */
export type SuggestionAlternatives = readonly Blueprint[];
