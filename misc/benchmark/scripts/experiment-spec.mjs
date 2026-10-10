/**
 * The pure half of `run-experiment.mjs`: what an experiment spec may say, and when a run must stop for cost.
 * No I/O here, so both rules are unit-tested (`experiment-spec.test.ts`).
 *
 * A spec names REGISTERED arms by id (the default matrix or `getCandidateVariants()`), never an ad-hoc model, so an
 * experiment re-runs by id. The arm ids are checked against the registry by the entrypoint (`resolveRunVariants`
 * throws on an unknown id); this module checks the shape.
 */

/** The ten prompts of the published nightly — the default corpus of an experiment. */
export const NIGHTLY_COMMITS = Object.freeze([
  'weather-card',
  'survey-form',
  'kanban-board',
  'periodic-table',
  'product-page',
  'chat-interface',
  'stock-ticker',
  'onboarding-wizard',
  'leaflet-map',
  'revenue-chart',
]);

/** A spec's id becomes an object-key prefix, so it is a lowercase slug. */
export const EXPERIMENT_ID = /^[a-z0-9][a-z0-9-]{2,63}$/;
/** Repetitions per arm per prompt. */
export const MAX_REPS = 10;
/** A spec's own cap may not exceed this, whatever it says: a typo cannot authorise a large spend. */
export const MAX_COST_CAP_USD = 100;
/**
 * The generation cost the report records (`estimatedCostUsd`) does not include the judge panel's calls. The stop
 * rule therefore projects with this margin, so a run stops before its total (generation + judging) passes the cap.
 */
export const JUDGING_MARGIN = 1.25;

/**
 * Parse and validate an experiment spec. Returns the normalised spec, or throws with every problem named.
 * @param {unknown} raw
 * @returns {{ id: string, variants: string[], commits: string[], reps: number, costCapUsd: number }}
 */
export function parseExperimentSpec(raw) {
  const problems = [];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('experiment spec: must be a JSON object');
  }
  const spec = /** @type {Record<string, unknown>} */ (raw);
  const allowed = new Set(['id', 'variants', 'commits', 'reps', 'costCapUsd']);
  for (const key of Object.keys(spec)) if (!allowed.has(key)) problems.push(`unknown field "${key}"`);

  const id = spec.id;
  if (typeof id !== 'string' || !EXPERIMENT_ID.test(id)) problems.push(`id must match ${EXPERIMENT_ID}`);

  const variants = spec.variants;
  const variantsOk =
    Array.isArray(variants) && variants.length > 0 && variants.every((v) => typeof v === 'string' && v.length > 0);
  if (!variantsOk) problems.push('variants must be a non-empty array of arm ids');
  else if (new Set(variants).size !== variants.length) problems.push('variants must not repeat an arm');

  const commitsRaw = spec.commits ?? [...NIGHTLY_COMMITS];
  const commitsOk =
    Array.isArray(commitsRaw) && commitsRaw.length > 0 && commitsRaw.every((c) => typeof c === 'string' && c.length > 0);
  if (!commitsOk) problems.push('commits, when given, must be a non-empty array of prompt ids');
  else if (new Set(commitsRaw).size !== commitsRaw.length) problems.push('commits must not repeat a prompt');

  const reps = spec.reps;
  if (!Number.isInteger(reps) || /** @type {number} */ (reps) < 1 || /** @type {number} */ (reps) > MAX_REPS) {
    problems.push(`reps must be an integer from 1 to ${MAX_REPS}`);
  }

  const cap = spec.costCapUsd;
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap <= 0 || cap > MAX_COST_CAP_USD) {
    problems.push(`costCapUsd must be a number above 0 and at most ${MAX_COST_CAP_USD}`);
  }

  if (problems.length > 0) throw new Error(`experiment spec: ${problems.join('; ')}`);
  return {
    id: /** @type {string} */ (id),
    variants: /** @type {string[]} */ ([...variants]),
    commits: /** @type {string[]} */ ([...commitsRaw]),
    reps: /** @type {number} */ (reps),
    costCapUsd: /** @type {number} */ (cap),
  };
}

/**
 * Before starting the next repetition: stop if the spend so far plus another repetition like the last one, with the
 * judging margin, would pass the cap. The first repetition always runs (there is nothing to project from); the cap
 * itself is bounded by {@link MAX_COST_CAP_USD}.
 * @param {{ capUsd: number, spentUsd: number, lastRepUsd: number | null }} args
 * @returns {{ stop: boolean, projectedUsd: number }}
 */
export function decideNextRep({ capUsd, spentUsd, lastRepUsd }) {
  if (lastRepUsd === null) return { stop: false, projectedUsd: 0 };
  const projectedUsd = (spentUsd + lastRepUsd) * JUDGING_MARGIN;
  return { stop: projectedUsd > capUsd, projectedUsd };
}
