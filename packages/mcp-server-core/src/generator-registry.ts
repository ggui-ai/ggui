/**
 * GeneratorRegistry — the registered-generator seam.
 *
 * One {@link UiGenerator} per (tier × model), addressable by a stable slug
 * `ui-gen-{tier}-{model}`. The registry is the operator-facing surface
 * for declaring which generators are available on a given deployment.
 * {@link Blueprint} rows are keyed by the producing generator's slug;
 * the `ggui_ops_generate_blueprint` tool accepts the slug as a
 * dispatch target; the LLM variant selector picks among candidates
 * whose generators all live in this registry.
 *
 * The single-generator path (every render routes to one factory-built
 * generator) is the default: the registry holds one entry whose slug
 * is `ui-gen-default-haiku-4-5` and the OSS render handler reads from
 * `generation.uiGenerator` directly. This interface is the seam that
 * multi-generator dispatch builds on.
 *
 * Slug grammar (parser is liberal — extension-friendly):
 *
 *   `ui-gen-<tier>-<model>` where tier is `default` | `advanced` | a
 *   future operator-defined value, and model is the canonical-model
 *   identifier the generator targets (e.g. `haiku-4-5`, `opus-4-7`,
 *   `sonnet-4-6`, `gemini-3-flash`, `gpt-5-codex`). The model segment
 *   carries everything after `ui-gen-<tier>-`, so dashes inside the
 *   model name are preserved (`haiku-4-5` parses as one model token).
 */
import type { UiGenerator, GeneratorTier } from './ui-generator.js';

/**
 * Parsed slug components.
 */
export interface GeneratorSlugParts {
  readonly tier: GeneratorTier;
  readonly model: string;
}

/**
 * Validate a slug string against the `ui-gen-<tier>-<model>` grammar.
 * Returns `true` iff the slug is syntactically well-formed; this does
 * not check whether a generator with that slug is actually registered.
 */
export function isValidGeneratorSlug(slug: string): boolean {
  return parseGeneratorSlug(slug) !== null;
}

/**
 * Split a slug into `{tier, model}`. Returns `null` for any input that
 * doesn't match the grammar. The model segment captures everything
 * after the second dash, so `ui-gen-default-haiku-4-5` parses cleanly
 * with `tier='default'`, `model='haiku-4-5'`.
 *
 * Rules:
 *   - prefix MUST be `ui-gen-`
 *   - tier MUST be at least one character, no dashes, no whitespace
 *   - model MUST be at least one character (dashes allowed inside)
 *   - no leading / trailing whitespace
 */
export function parseGeneratorSlug(slug: string): GeneratorSlugParts | null {
  if (typeof slug !== 'string') return null;
  if (slug !== slug.trim()) return null;
  if (!slug.startsWith('ui-gen-')) return null;
  const rest = slug.slice('ui-gen-'.length);
  // Disallow leading dash on the rest (no empty tier).
  if (rest.length === 0 || rest.startsWith('-')) return null;
  const dashIdx = rest.indexOf('-');
  if (dashIdx <= 0) return null;
  const tier = rest.slice(0, dashIdx);
  const model = rest.slice(dashIdx + 1);
  if (tier.length === 0 || model.length === 0) return null;
  if (/\s/.test(tier) || /\s/.test(model)) return null;
  return { tier, model };
}

/**
 * Compose a slug from its components. Mirror of {@link parseGeneratorSlug}.
 * Throws on invalid input so callers can't accidentally register a
 * generator under a malformed slug.
 */
export function formatGeneratorSlug(parts: GeneratorSlugParts): string {
  if (!parts.tier || /\s|-/.test(parts.tier)) {
    throw new Error(
      `formatGeneratorSlug: tier must be a non-empty dashless / whitespace-free identifier, got ${JSON.stringify(parts.tier)}`,
    );
  }
  if (!parts.model || /\s/.test(parts.model)) {
    throw new Error(
      `formatGeneratorSlug: model must be a non-empty whitespace-free identifier, got ${JSON.stringify(parts.model)}`,
    );
  }
  return `ui-gen-${parts.tier}-${parts.model}`;
}

/**
 * Operator-facing seam for registered generators.
 *
 * Lookup is by slug. The default-generator pointer is the v1 fallback
 * for callers that don't specify which generator to run (e.g. an
 * agent-side push that doesn't carry a blueprint-level generator hint).
 * The blueprint matcher reads {@link defaultGenerator} when no
 * blueprint candidate matches at handshake time; the
 * `ggui_ops_generate_blueprint` tool uses it when the caller omits
 * an explicit `generator` slug.
 */
export interface GeneratorRegistry {
  /**
   * Register a generator. The generator's own `slug` field is the
   * registration key. Re-registering an existing slug throws — the
   * operator must explicitly remove a generator before replacing it,
   * preventing accidental swap during composition.
   */
  register(generator: UiGenerator): void;

  /**
   * Look up a generator by slug. Returns `null` when no generator with
   * that slug is registered. Callers MUST handle the `null` case —
   * an absent slug typically reflects a misconfigured operator deploy
   * (e.g. agent requested `ui-gen-advanced-opus-4-7` against an OSS
   * pod that didn't install Playwright).
   */
  get(slug: string): UiGenerator | null;

  /**
   * Enumerate every registered generator in registration order. Used
   * by the console blueprint UX and bench framework to drive the
   * "pick which generator" picker.
   */
  list(): readonly UiGenerator[];

  /**
   * The operator-pinned default generator. Returns the first-registered
   * generator unless an explicit default was set via
   * {@link setDefaultGenerator}. Throws when the registry is empty —
   * callers that depend on the default MUST register at least one
   * generator before invoking.
   */
  defaultGenerator(): UiGenerator;

  /**
   * Pin a specific slug as the registry's default. Throws when the
   * slug isn't registered. The pin persists for the lifetime of the
   * registry instance.
   */
  setDefaultGenerator(slug: string): void;
}
