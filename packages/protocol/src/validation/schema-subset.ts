/**
 * Schema-subset algorithm — answers "can every value the `subset`
 * schema accepts also pass the `superset` schema?".
 *
 * **Why this lives in the protocol package.** The schema-alignment
 * contract is enforced at push-time + blueprint-registration; the
 * canonical failure is {@link ContractErrorCode}
 * `'SCHEMA_MISMATCH_ERROR'` — same envelope shape + channel as every
 * other named contract violation. See the schema-compat docstrings
 * on {@link ActionEntry.schema} and {@link StreamChannelEntry.schema}
 * for the author-invariant the check enforces.
 *
 * **Check points.**
 *
 *   - Pre-commit of a `Render` with `actionSpec` / `streamSpec`
 *     entries that reference tools: each action's declared schema
 *     MUST be a subset of the tool's inputSchema (what the action
 *     payload is allowed to send ⊆ what the tool accepts). Each
 *     stream channel's declared schema MUST be a subset of the
 *     tool's return schema (what the channel emits ⊆ what the tool
 *     returns — inverted because the DIRECTION reverses).
 *   - Policy via {@link CreateGguiServerOptions.schemaCompatCheck}:
 *     `'reject'` (default) / `'warn'` / `'off'`.
 *
 * **Algorithm scope (P0).**
 *
 *   - `type` match — primitive types must agree; only `undefined`
 *     on the superset side is a wildcard.
 *   - `required` — subset's required set MUST be a subset of
 *     superset's required set (tighter required on the subset side
 *     = strictly fewer values accepted ⇒ OK; tighter on the
 *     superset side would accept FEWER values than the subset ⇒
 *     violation).
 *   - `properties` — recursion: every subset property MUST be a
 *     subset of the matching superset property.
 *   - `additionalProperties` — semantics:
 *
 *       - superset `true` (default when omitted) → subset is
 *         unconstrained on extra keys — OK.
 *       - superset `false` → subset MUST also be `false` (anything
 *         else widens).
 *       - superset JsonSchema → subset's additionalProperties MUST
 *         be a subset of the superset's (recurse), OR `false`
 *         (never emits extras, always fits).
 *   - `items` — arrays: subset's `items` MUST be a subset of
 *     superset's `items`. When either side omits `items`, the check
 *     is permissive in that direction.
 *
 * **P1 scope (deferred).**
 *
 *   - `oneOf` / `anyOf` covering — subset union members must each
 *     be covered by at least one superset member.
 *   - `enum` — subset's enum values must all be in the superset's
 *     enum (or superset has no enum constraint).
 *   - `const` — subset's const must equal superset's const (or
 *     superset has no const constraint).
 *
 * **P2 scope (deferred — known limitations documented for
 * third-party authors).**
 *
 *   - `$ref` — no local or remote resolution; schemas with `$ref`
 *     are flagged as {@link SubsetViolationReason.unsupported}.
 *   - `allOf` — not merged before comparison.
 *   - String / number constraints — `minimum` / `maximum` /
 *     `minLength` / `maxLength` / `pattern` / `format` are NOT
 *     compared. A superset's narrower bound is not detected as a
 *     violation.
 *   - Tuple items (`items: JsonSchema[]`) — not in the current
 *     {@link JsonSchema} type, so not supported here.
 *
 * **Determinism contract.** No randomness, no IO, no thrown
 * exceptions for normal violations. Every incompatibility is
 * reported as a {@link SubsetViolation} with enough field-path
 * context for the emitted `SCHEMA_MISMATCH_ERROR` to name the
 * mismatch cleanly. Thrown errors are reserved for programmer-
 * bug conditions (a caller passes `null` where a JsonSchema is
 * expected).
 *
 * @see ./schema-compat-invariants.ts — the protocol-level invariants
 *      that call this algorithm at push-time.
 */
import type { JsonSchema, JsonValue } from '../types/data-contract.js';

/**
 * Category of subset violation. Narrow enough that a downstream
 * consumer can pattern-match on it if it wants to render a
 * specialized message; wide enough to admit future P1/P2 reasons
 * without a protocol-level bump.
 */
export type SubsetViolationReason =
  | 'type-mismatch'
  /** Subset declares a property the superset does not allow (via
   *  `properties` or `additionalProperties: false`). */
  | 'extra-property'
  /** Subset marks a property required that is not required on the
   *  superset — accepted, but only when the superset also allows the
   *  property at all. The combined check produces this reason only
   *  when the superset REJECTS the property entirely (missing from
   *  properties AND additionalProperties: false). */
  | 'required-widens'
  /** Superset marks a property required that the subset does not
   *  require. The subset may omit a value the superset would reject. */
  | 'missing-required'
  /** Array items schema mismatch. */
  | 'items-mismatch'
  /** `additionalProperties: false` on superset, non-false on subset. */
  | 'additional-properties-widens'
  /** Schema uses a construct this P0 implementation does not support
   *  (e.g. `$ref`, `allOf`, `oneOf`/`anyOf`, `enum`, `const`). The
   *  pair is flagged instead of silently passing. */
  | 'unsupported';

/**
 * A single point of incompatibility between `superset` and `subset`.
 * Carries enough context for the caller to render a message that
 * names the field path + both sides.
 */
export interface SubsetViolation {
  /**
   * Dotted field path from the root of the compared schemas.
   * `''` (empty) means the root schemas themselves mismatched.
   * `'properties.foo.items'` means the `items` of the `foo` property
   * mismatched. Uses `.items` for array element descent and `.<key>`
   * for object property descent. No escaping — property names
   * containing `.` will produce ambiguous paths but are valid JSON.
   */
  readonly path: string;
  /** Category of violation. */
  readonly reason: SubsetViolationReason;
  /** The superset side's value at `path`, as a short JSON string
   *  (stringified, truncated at 120 chars). `undefined` when the
   *  superset has no explicit value at the path. */
  readonly superset?: string;
  /** The subset side's value at `path`, same formatting rules as
   *  {@link SubsetViolation.superset}. */
  readonly subset?: string;
  /** Human-readable summary suitable for inclusion in a
   *  `SCHEMA_MISMATCH_ERROR` envelope. Producers MAY ignore this
   *  and render their own message from `path` + `reason` if they
   *  prefer a consistent localized format. */
  readonly message: string;
}

/**
 * Result of {@link isSchemaSubset}. Wraps `compatible` with the
 * violation list so callers that only need the boolean can check
 * `result.compatible`, and callers that emit envelopes can project
 * the violations into the error details.
 */
export interface SchemaSubsetResult {
  readonly compatible: boolean;
  readonly violations: readonly SubsetViolation[];
}

/**
 * Compare two JSON Schemas under the "subset acceptance" relation:
 * returns `compatible: true` iff every JSON value that `subset`
 * accepts would also be accepted by `superset` (under the P0 scope
 * documented at the top of this file).
 *
 * Neither argument is mutated. Order matters: `isSchemaSubset(a, b)`
 * checks "is b a subset of a", NOT "is a a subset of b".
 *
 * `null` / non-object inputs throw — they are programmer errors,
 * not schema violations. Every legitimate incompatibility is
 * reported via the returned {@link SubsetViolation} list.
 */
export function isSchemaSubset(
  superset: JsonSchema,
  subset: JsonSchema,
): SchemaSubsetResult {
  if (superset === null || typeof superset !== 'object') {
    throw new TypeError(
      `isSchemaSubset: superset must be a JsonSchema object (received ${typeof superset})`,
    );
  }
  if (subset === null || typeof subset !== 'object') {
    throw new TypeError(
      `isSchemaSubset: subset must be a JsonSchema object (received ${typeof subset})`,
    );
  }
  const violations: SubsetViolation[] = [];
  compare(superset, subset, '', violations);
  return {
    compatible: violations.length === 0,
    violations,
  };
}

// ── Internal ──────────────────────────────────────────────────────

/**
 * Structural deep-equality for two JSON Schemas. A schema is always a
 * subset of itself, so an equal pair short-circuits {@link compare} —
 * this is what lets a pair that uses an otherwise-unsupported
 * construct (`enum`, `oneOf`, `const`, …) pass when the two sides are
 * identical (e.g. a source-fed `streamSpec` channel whose schema is
 * the backing tool's `outputSchema` verbatim).
 */
function schemasDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    const ab = a as unknown[];
    const bb = b as unknown[];
    if (ab.length !== bb.length) return false;
    return ab.every((v, i) => schemasDeepEqual(v, bb[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const aKeys = Object.keys(ao);
  if (aKeys.length !== Object.keys(bo).length) return false;
  return aKeys.every(
    (k) =>
      Object.prototype.hasOwnProperty.call(bo, k) &&
      schemasDeepEqual(ao[k], bo[k]),
  );
}

function compare(
  superset: JsonSchema,
  subset: JsonSchema,
  path: string,
  out: SubsetViolation[],
): void {
  // Identical schemas: a schema is trivially a subset of itself, so
  // skip the structural walk. This is the ONLY path by which a pair
  // using a P1/P2-unsupported construct (`enum`, `oneOf`, `const`, …)
  // can be proved compatible — and it is sound, because equal schemas
  // accept exactly the same value set.
  if (schemasDeepEqual(superset, subset)) return;

  // P2 unsupported constructs — flag instead of silently passing.
  // Presence on EITHER side is flagged because a recursive check on
  // an unresolved `$ref` / un-merged `allOf` would produce false
  // negatives. Subset-only presence is also flagged so a caller that
  // authors a narrower-by-`$ref` schema knows the subset check can't
  // prove it.
  if (hasUnsupported(superset) || hasUnsupported(subset)) {
    out.push({
      path,
      reason: 'unsupported',
      superset: safeStringify(supersetUnsupportedField(superset)),
      subset: safeStringify(supersetUnsupportedField(subset)),
      message:
        `${pathLabel(path)}: schema uses an unsupported construct ` +
        `($ref / allOf / oneOf / anyOf / enum / const) — the subset ` +
        `algorithm cannot prove compatibility for these constructs.`,
    });
    return;
  }

  // Type match. Superset `undefined` is a wildcard (accepts any
  // type). Subset `undefined` against a specific superset type is a
  // violation — "no declared type" is wider than any specific type.
  const sup = normalizeType(superset);
  const sub = normalizeType(subset);
  if (sup !== undefined) {
    if (sub === undefined || sub !== sup) {
      out.push({
        path,
        reason: 'type-mismatch',
        superset: sup,
        subset: sub ?? '(unspecified)',
        message:
          `${pathLabel(path)}: type mismatch — superset accepts ` +
          `'${sup}' but subset ${sub === undefined ? 'does not declare a type' : `declares '${sub}'`}.`,
      });
      // Type mismatch invalidates downstream object/array structural
      // checks — if the types don't match, deeper comparison is noise.
      return;
    }
  }

  // Object structure.
  if (sup === 'object' || sub === 'object') {
    compareObject(superset, subset, path, out);
  }
  // Array items. We descend through items only when both sides have
  // `type: 'array'` (or superset omitted type and subset declares
  // array — but that case is caught by the type block above as a
  // mismatch). Omission on either side is permissive.
  if (sup === 'array' || sub === 'array') {
    compareArray(superset, subset, path, out);
  }
}

function compareObject(
  superset: JsonSchema,
  subset: JsonSchema,
  path: string,
  out: SubsetViolation[],
): void {
  const supProps = superset.properties ?? {};
  const subProps = subset.properties ?? {};
  const supRequired = new Set(superset.required ?? []);
  const subRequired = new Set(subset.required ?? []);
  const supAdditional = resolveAdditional(superset.additionalProperties);
  const subAdditional = resolveAdditional(subset.additionalProperties);

  // Every subset property must either be in supProps (recurse) OR
  // be allowed by supAdditional.
  for (const key of Object.keys(subProps)) {
    const subChild = subProps[key];
    if (!subChild) continue; // paranoia — Object.keys guarantees it exists
    const supChild = supProps[key];
    const childPath = path === '' ? `properties.${key}` : `${path}.properties.${key}`;
    if (supChild) {
      compare(supChild, subChild, childPath, out);
    } else if (supAdditional.kind === 'allow') {
      // Allowed by `additionalProperties: true` on superset —
      // structurally unconstrained, so subset's shape is fine.
    } else if (supAdditional.kind === 'schema') {
      compare(supAdditional.schema, subChild, childPath, out);
    } else {
      // superset: additionalProperties false AND key not in
      // properties. Subset would allow a value the superset rejects.
      out.push({
        path: childPath,
        reason: 'extra-property',
        superset: '(not allowed)',
        subset: safeStringify(subChild),
        message:
          `${pathLabel(childPath)}: subset allows property '${key}' ` +
          `that superset rejects (not in superset.properties and ` +
          `superset.additionalProperties is false).`,
      });
    }
  }

  // Additional-properties compatibility. A subset that allows
  // additional properties when the superset rejects them is wider
  // in the "extra keys" dimension.
  if (supAdditional.kind === 'reject') {
    if (subAdditional.kind === 'allow') {
      out.push({
        path,
        reason: 'additional-properties-widens',
        superset: 'false',
        subset: 'true',
        message:
          `${pathLabel(path)}: subset.additionalProperties is true but ` +
          `superset.additionalProperties is false — subset accepts ` +
          `extra keys the superset rejects.`,
      });
    } else if (subAdditional.kind === 'schema') {
      out.push({
        path,
        reason: 'additional-properties-widens',
        superset: 'false',
        subset: safeStringify(subset.additionalProperties),
        message:
          `${pathLabel(path)}: subset declares an additionalProperties ` +
          `schema, but superset.additionalProperties is false.`,
      });
    }
    // subAdditional === 'reject' → equal; no violation.
  } else if (supAdditional.kind === 'schema') {
    if (subAdditional.kind === 'allow') {
      out.push({
        path,
        reason: 'additional-properties-widens',
        superset: safeStringify(superset.additionalProperties),
        subset: 'true',
        message:
          `${pathLabel(path)}: subset.additionalProperties is true ` +
          `(unconstrained) but superset constrains additional ` +
          `properties to a schema.`,
      });
    } else if (subAdditional.kind === 'schema') {
      const childPath =
        path === '' ? 'additionalProperties' : `${path}.additionalProperties`;
      compare(supAdditional.schema, subAdditional.schema, childPath, out);
    }
    // subAdditional === 'reject' → subset never emits extras, fits inside.
  }
  // supAdditional.kind === 'allow' → subset's extras are all legal.

  // Required-set checks. A required-on-subset-only property is fine
  // (subset is stricter). A required-on-superset-only property
  // means the subset can produce values missing that key, which the
  // superset would reject.
  for (const key of supRequired) {
    if (!subRequired.has(key)) {
      // Only a violation if the property is actually reachable on
      // the subset — if the subset simply doesn't mention the key
      // at all (and its additionalProperties rejects), the subset
      // can't even emit a value with that key, so a missing-required
      // on the superset is something the subset-produced value will
      // flunk.
      out.push({
        path: path === '' ? `required.${key}` : `${path}.required.${key}`,
        reason: 'missing-required',
        superset: '(required)',
        subset: subRequired.has(key) ? '(required)' : '(optional or absent)',
        message:
          `${pathLabel(path)}: superset requires '${key}' but subset ` +
          `does not — subset can emit values missing '${key}' that ` +
          `the superset rejects.`,
      });
    }
  }
}

function compareArray(
  superset: JsonSchema,
  subset: JsonSchema,
  path: string,
  out: SubsetViolation[],
): void {
  const supItems = superset.items;
  const subItems = subset.items;
  // Permissive when either side omits items.
  if (!supItems || !subItems) return;
  const childPath = path === '' ? 'items' : `${path}.items`;
  compare(supItems, subItems, childPath, out);
}

// ── Helpers ───────────────────────────────────────────────────────

type NormalizedType =
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'array'
  | 'object'
  | 'null';

function normalizeType(schema: JsonSchema): NormalizedType | undefined {
  return schema.type;
}

type AdditionalResolution =
  | { kind: 'allow' }
  | { kind: 'reject' }
  | { kind: 'schema'; schema: JsonSchema };

function resolveAdditional(
  value: JsonSchema['additionalProperties'],
): AdditionalResolution {
  // JSON Schema draft-07: omitted ⇒ additionalProperties `true`.
  if (value === undefined || value === true) return { kind: 'allow' };
  if (value === false) return { kind: 'reject' };
  return { kind: 'schema', schema: value };
}

function hasUnsupported(schema: JsonSchema): boolean {
  return (
    supersetUnsupportedField(schema) !== undefined
  );
}

/**
 * Returns the first unsupported P2-scope field present on the
 * schema, or `undefined` when none. Order is stable so violation
 * messages are deterministic.
 */
function supersetUnsupportedField(schema: JsonSchema): string | undefined {
  // JsonSchema type does not declare `$ref` / `allOf`, but raw JSON
  // can carry them — a zod-converted schema or a hand-authored
  // fixture will. We check via property lookup without widening the
  // type.
  const bag = schema as unknown as Record<string, unknown>;
  if (typeof bag['$ref'] === 'string') return '$ref';
  if (Array.isArray(bag['allOf'])) return 'allOf';
  if (Array.isArray(schema.oneOf)) return 'oneOf';
  if (Array.isArray(schema.anyOf)) return 'anyOf';
  if (Array.isArray(schema.enum)) return 'enum';
  if (schema.const !== undefined) return 'const';
  return undefined;
}

function safeStringify(value: unknown): string {
  if (value === undefined) return '(undefined)';
  let json: string;
  try {
    json = JSON.stringify(value);
  } catch {
    json = String(value);
  }
  if (json === undefined) return '(undefined)';
  if (json.length > 120) return json.slice(0, 117) + '...';
  return json;
}

function pathLabel(path: string): string {
  return path === '' ? '(root)' : path;
}

// JsonValue alias pin — keep the import non-dead across the module in
// case the future P1 enum/const implementation wants to reference it.
export type { JsonValue };
