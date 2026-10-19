// ggui#1765 — the judge's page and the runtime pick a fit's CSS through ONE selection, `mountFitCss`. The judge page
// once assembled the fit rules by hand and left the card's content edge out of the inline fit, so a judged hello split
// where no served card did. This pins both callers to the one selection, fit by fit.
import { describe, expect, it } from 'vitest';
import { composeThemeCss, mountFitCss, type MountFit } from '@ggui-ai/design/rendering';
import { JUDGE_SCOPE_CLASS, buildRenderHTML } from './visual-evaluator.js';

const RADIUS = 12;
const CASES: ReadonlyArray<readonly [MountFit, Parameters<typeof buildRenderHTML>]> = [
  ['card', ['export default () => null;', undefined, undefined, undefined, undefined, undefined]],
  ['framed-card', ['export default () => null;', undefined, undefined, undefined, undefined, RADIUS]],
  ['fill', ['export default () => null;', undefined, 'fill', undefined, undefined, undefined]],
];

describe("the judge's page and the runtime take a fit's CSS from one selection (ggui#1765)", () => {
  it.each(CASES)('%s', (fit, args) => {
    const rules = mountFitCss(JUDGE_SCOPE_CLASS, fit, fit === 'framed-card' ? RADIUS : null);
    expect(rules.length).toBeGreaterThan(0);
    expect(buildRenderHTML(...args)).toContain(rules);
    // The runtime's composer ends its scoped block with the same selection for the fit.
    const runtimeRules = mountFitCss(JUDGE_SCOPE_CLASS, fit, null); // no app theme: the composer's radius reads the theme's lg token (null)
    expect(composeThemeCss({ layer: 'tree', scopeClass: JUDGE_SCOPE_CLASS, ...(fit === 'card' ? {} : { fit }) }).endsWith(runtimeRules)).toBe(true);
  });

  it("the judge scopes its root in every fit, so the fit's rules can reach it", () => {
    for (const [, args] of CASES) expect(buildRenderHTML(...args)).toContain(`<div id="root" class="${JUDGE_SCOPE_CLASS}">`);
  });
});
