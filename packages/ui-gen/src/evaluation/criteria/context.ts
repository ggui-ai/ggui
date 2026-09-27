/**
 * The selector's inputs for one card — ggui#1436. Every key here is hashed into `criteriaSetId`
 * and STORED in the block (the CTO's A1), so a stored verdict reproduces its own set from the
 * record alone. `canvas` is added per canvas inside the judge; the rest is the harness's.
 */
import type { DataContract } from '@ggui-ai/protocol';
import type { Classification } from '../../classifier/axes.js';
import type { GenerationProfileInput } from '../../boilerplate/styling-profile.js';
import type { CriteriaChroma, CriteriaContext } from '../types-public.js';

/** The primary at its 500 step, as the design's tokens render it (`--ggui-color-primary-500: #rrggbb;`). */
const PRIMARY_500 = /--ggui-color-primary-500:\s*(#[0-9a-fA-F]{3}|#[0-9a-fA-F]{6})\s*;/;
/** Below this max−min spread (0..1) a primary reads as achromatic — an inversion, not a hue. */
const ACHROMATIC_SPREAD = 0.08;

/** Read the theme's chroma off its tokens; `unknown` when no primary is named. */
export function chromaOfCssTokens(cssTokens: string | undefined): CriteriaChroma {
  const m = cssTokens?.match(PRIMARY_500);
  if (!m) return 'unknown';
  const hex = m[1]!.slice(1);
  const full = hex.length === 3 ? hex.split('').map((c) => c + c).join('') : hex;
  const channels = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16));
  const spread = (Math.max(...channels) - Math.min(...channels)) / 255;
  return spread < ACHROMATIC_SPREAD ? 'achromatic' : 'chromatic';
}

export interface CriteriaContextSources {
  readonly classification: Classification;
  readonly contract: DataContract | undefined;
  readonly cssTokens: string | undefined;
  readonly profile: GenerationProfileInput | undefined;
  readonly shell: string;
  readonly kind?: string;
}

/** The context minus `canvas` — the judge fills that per canvas. */
export type CriteriaContextInput = Omit<CriteriaContext, 'canvas'>;

export function criteriaContextFor(src: CriteriaContextSources): CriteriaContextInput {
  const v = src.classification.vector;
  const preset = src.profile?.aesthetic?.id;
  return {
    hasActions: Object.keys(src.contract?.actionSpec ?? {}).length > 0,
    riskTier: src.classification.riskTier,
    axes: { render: v.render, state: v.state, writes: v.writes, fetch: v.fetch, layout: v.layout },
    chroma: chromaOfCssTokens(src.cssTokens),
    profilePresent: src.profile !== undefined,
    shell: src.shell,
    ...(src.kind !== undefined ? { kind: src.kind } : {}),
    ...(preset !== undefined ? { preset } : {}),
  };
}
