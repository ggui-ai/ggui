/**
 * `BlueprintSource` — the single provenance vocabulary for blueprints.
 *
 * One discriminated union, replacing the flat provenance strings that
 * previously lived on three separate seams (catalog entries, screen
 * blueprints, and the runtime cache registry). The discriminant is
 * `kind`; the `llm` arm carries the engine provenance that the flat
 * strings could never express.
 *
 * Arms:
 *
 *   - `llm` — engine-generated. `generator` is the slug of the
 *     {@link UiGenerator} that produced the component code; `model` is
 *     the LLM model id the engine called. Both REQUIRED: every
 *     generation mint site has them in scope, and an engine-generated
 *     artifact without them is not a real state.
 *   - `user` — developer-registered / hand-authored. Covers
 *     manifest-declared UIs, operator-registered blueprints, and
 *     imported artifacts that carry no engine claim. No engine
 *     provenance exists for these, so the arm carries none.
 *   - `curated` — hand-authored system blueprint shipped with a
 *     deployment's screen-blueprint catalog (a design call made by the
 *     catalog author, ranked above generated output by the matcher).
 *
 * Dead-arm verdict (2026-06 provenance trace): the legacy flat
 * vocabularies also declared a `heuristic` arm ("rule-based composer").
 * A repo-wide mint trace found ZERO sites that ever produced it, so the
 * arm is deleted rather than carried. There is intentionally NO
 * legacy/unlabeled arm and NO optional provenance: blueprints are a
 * cache (invalidation = regeneration, never data loss), so unlabeled
 * rows are dropped at the trust boundary, never coerced.
 */

/** Closed list of `BlueprintSource` discriminants. */
export const BLUEPRINT_SOURCE_KINDS = ["llm", "user", "curated"] as const;

/** Discriminant of {@link BlueprintSource}. */
export type BlueprintSourceKind = (typeof BLUEPRINT_SOURCE_KINDS)[number];

/** Engine-generated — full engine provenance is mandatory. */
export interface LlmBlueprintSource {
  readonly kind: "llm";
  /**
   * Slug of the generator that produced the component code (e.g.
   * `'ui-gen-default-haiku-4-5'`). The server's `GeneratorRegistry` is
   * the authority for which slugs exist on a given deployment.
   */
  readonly generator: string;
  /** Model id of the LLM call the generator made. */
  readonly model: string;
}

/** Developer-registered / hand-authored — no engine provenance exists. */
export interface UserBlueprintSource {
  readonly kind: "user";
}

/** Hand-authored system blueprint shipped with a deployment's catalog. */
export interface CuratedBlueprintSource {
  readonly kind: "curated";
}

export type BlueprintSource =
  | LlmBlueprintSource
  | UserBlueprintSource
  | CuratedBlueprintSource;

/**
 * Validating narrower for trust boundaries (DB row → union, JSON
 * artifact → union). Returns a CANONICAL rebuild of the union value —
 * stray keys on the input do not ride through — or `null` when the
 * value is not a well-formed `BlueprintSource`. Callers at load seams
 * drop-with-log or reject loudly on `null`; coercing a malformed value
 * into an arm is banned.
 */
export function parseBlueprintSource(value: unknown): BlueprintSource | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const v = value as Record<string, unknown>;
  switch (v["kind"]) {
    case "llm": {
      const generator = v["generator"];
      const model = v["model"];
      if (typeof generator !== "string" || generator.length === 0) return null;
      if (typeof model !== "string" || model.length === 0) return null;
      return { kind: "llm", generator, model };
    }
    case "user":
      return { kind: "user" };
    case "curated":
      return { kind: "curated" };
    default:
      return null;
  }
}

/** Type-guard form of {@link parseBlueprintSource}. */
export function isBlueprintSource(value: unknown): value is BlueprintSource {
  return parseBlueprintSource(value) !== null;
}
