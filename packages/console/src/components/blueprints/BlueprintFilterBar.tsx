/**
 * Filter bar for the blueprint variants list.
 *
 * Three axes the operator can narrow on:
 *
 *   - **persona** — free-form substring match. Mirrors the
 *     `variance.persona` slot operators set when authoring variants.
 *   - **generator** — slug select (default-haiku-4-5 vs advanced-opus-
 *     4-7). Empty means any. Provenance-aware: only `llm`-sourced
 *     variants can match an engine slug — `user` / `curated` variants
 *     carry no engine provenance (same rule as the
 *     `ggui_ops_list_blueprints` filter).
 *   - **drafts only** — gates by `validatorScore` below the threshold
 *     so operators can find sub-pass variants stored but not selected.
 *
 * Local-state pattern: the bar emits its current filters via `onChange`
 * on every keystroke / select / toggle; the parent owns the filter
 * state and re-applies it to the list. This keeps the bar pure (no
 * useEffect, no debounce on the parent's behalf) so jsdom tests can
 * synchronously assert the click → callback contract.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variants-filter-bar` on the form root.
 *   - `data-ggui-variants-filter-persona` on the persona input.
 *   - `data-ggui-variants-filter-generator` on the generator select.
 *   - `data-ggui-variants-filter-drafts-only` on the drafts checkbox.
 */
import type { ChangeEvent, ReactElement } from 'react';
import type { BlueprintSource } from '@ggui-ai/protocol';

/** Available generator slugs surfaced in the select. Pre-launch v1 ships
 *  two; the slug parser is liberal so future generators slot in here. */
export const KNOWN_GENERATOR_SLUGS = [
  'ui-gen-default-haiku-4-5',
  'ui-gen-advanced-opus-4-7',
] as const;

export type KnownGeneratorSlug = (typeof KNOWN_GENERATOR_SLUGS)[number];

/** Default sub-pass threshold — variants with `validatorScore` below this
 *  surface in "drafts only" mode. Matches the advanced generator's
 *  iterative-loop pass gate. */
export const DRAFT_VALIDATOR_THRESHOLD = 0.8;

export interface VariantFilters {
  readonly persona: string;
  readonly generator: string;
  readonly draftsOnly: boolean;
}

export const EMPTY_VARIANT_FILTERS: VariantFilters = {
  persona: '',
  generator: '',
  draftsOnly: false,
};

export interface BlueprintFilterBarProps {
  readonly filters: VariantFilters;
  readonly onChange: (next: VariantFilters) => void;
  /** Slugs to surface in the generator select. Defaults to {@link
   *  KNOWN_GENERATOR_SLUGS}. Override when a deployment registers
   *  bespoke generators we don't ship by default. */
  readonly generatorSlugs?: readonly string[];
}

export function BlueprintFilterBar({
  filters,
  onChange,
  generatorSlugs,
}: BlueprintFilterBarProps): ReactElement {
  const slugs = generatorSlugs ?? KNOWN_GENERATOR_SLUGS;
  const setPersona = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...filters, persona: event.target.value });
  };
  const setGenerator = (event: ChangeEvent<HTMLSelectElement>): void => {
    onChange({ ...filters, generator: event.target.value });
  };
  const setDraftsOnly = (event: ChangeEvent<HTMLInputElement>): void => {
    onChange({ ...filters, draftsOnly: event.target.checked });
  };
  return (
    <form
      data-ggui-variants-filter-bar
      className="ggui-form"
      onSubmit={(event) => event.preventDefault()}
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 16,
        alignItems: 'flex-end',
        marginBottom: 20,
      }}
    >
      <div className="ggui-field" style={{ flex: 1, minWidth: 200 }}>
        <label className="ggui-label" htmlFor="ggui-variants-filter-persona">
          persona
        </label>
        <input
          id="ggui-variants-filter-persona"
          data-ggui-variants-filter-persona
          aria-label="filter by persona"
          placeholder="e.g. minimalist, data-dense"
          value={filters.persona}
          onChange={setPersona}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
        />
      </div>
      <div className="ggui-field" style={{ minWidth: 220 }}>
        <label className="ggui-label" htmlFor="ggui-variants-filter-generator">
          generator
        </label>
        <select
          id="ggui-variants-filter-generator"
          data-ggui-variants-filter-generator
          aria-label="filter by generator"
          value={filters.generator}
          onChange={setGenerator}
        >
          <option value="">any</option>
          {slugs.map((slug) => (
            <option key={slug} value={slug}>
              {slug}
            </option>
          ))}
        </select>
      </div>
      <label
        className="ggui-field"
        htmlFor="ggui-variants-filter-drafts-only"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          cursor: 'pointer',
        }}
      >
        <input
          id="ggui-variants-filter-drafts-only"
          data-ggui-variants-filter-drafts-only
          type="checkbox"
          aria-label="show drafts only"
          checked={filters.draftsOnly}
          onChange={setDraftsOnly}
        />
        <span className="ggui-label" style={{ margin: 0 }}>
          drafts only (score &lt; {DRAFT_VALIDATOR_THRESHOLD.toFixed(2)})
        </span>
      </label>
    </form>
  );
}

/**
 * Predicate — true when a blueprint passes the active filters. Pulled
 * out of {@link BlueprintList} so the list and tests share one rule
 * surface (otherwise drift sneaks in the moment a new axis lands).
 */
export function blueprintMatchesFilters<
  T extends {
    readonly variance: { readonly persona?: string };
    readonly source: BlueprintSource;
    readonly validatorScore?: number;
  },
>(bp: T, filters: VariantFilters): boolean {
  const needle = filters.persona.trim().toLowerCase();
  if (needle.length > 0) {
    const persona = bp.variance.persona?.toLowerCase() ?? '';
    if (!persona.includes(needle)) return false;
  }
  if (
    filters.generator.length > 0 &&
    (bp.source.kind !== 'llm' || bp.source.generator !== filters.generator)
  ) {
    return false;
  }
  if (filters.draftsOnly) {
    if (
      bp.validatorScore === undefined ||
      bp.validatorScore >= DRAFT_VALIDATOR_THRESHOLD
    ) {
      return false;
    }
  }
  return true;
}
