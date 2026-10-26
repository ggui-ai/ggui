// ggui#2010 — the no-truncate pin reaches the visual evaluator's verdict: a control label the in-page read names
// fails the canvas as `control-truncated`, on every capture shape; an unavailable read is no verdict. The in-page
// expression itself is pinned against Chromium in @ggui-ai/ui-visual-tester (truncated-controls.test.ts).
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { TRUNCATED_CONTROLS_EXPRESSION } from '@ggui-ai/ui-visual-tester/truncated-controls';
import {
  CARD_BOX_EXPRESSION,
  NO_TRUNCATE_CHIP_EXAMPLE,
  runVisualEvaluationDetailed,
  runVisualFit,
  summarizeVisualResult,
  truncatedControlLabels,
  truncatedControlsVerdict,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';
import { REVEALED_PROPS } from '../fragments/revealed-props.js';

const UNFRAMED = 'export default function C(){ return null; }';
const FRAMED = 'export default function C(){ return null; } export const gguiMountCanvas = "xs-chat-card";';

/** A fake browser whose page answers the truncation read with `labels` and every other read with a plain height. */
function deps(labels: unknown): VisualEvalDeps {
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async () => {},
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async (expression: string) =>
        expression === TRUNCATED_CONTROLS_EXPRESSION ? labels : expression === CARD_BOX_EXPRESSION ? { x: 32, y: 32, width: 784, height: 180 } : 200,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return { launch, env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' }, settleMs: 0 };
}

/** {@link deps} plus a judge that scores every canvas 85 — above the threshold, so only a deterministic verdict can fail it. */
function judgedDeps(labels: unknown): VisualEvalDeps {
  return {
    ...deps(labels),
    judge: async () => ({
      text: JSON.stringify({ completeness: 85, layout: 85, hierarchy: 85, aesthetics: 85, issues: [], critique: 'fine' }),
      inputTokens: 10,
      outputTokens: 5,
    }),
  };
}

describe('truncatedControlsVerdict (ggui#2010)', () => {
  it('names the cut labels as a critical instrument issue', () => {
    const issue = truncatedControlsVerdict('xs-chat-card', { attempt: { truncatedControls: ['Start a new notebook for this week'] } });
    expect(issue?.dimension).toBe('control-truncated');
    expect(issue?.severity).toBe('critical');
    expect(issue?.origin).toBe('instrument');
    expect(issue?.description).toContain('"Start a new notebook for this week"');
  });

  // The fix text (CDO, final): the rule, then the mechanics, and the chip example only where the prompt taught it.
  const RULE =
    "A control's label must show whole: never clip or ellipsize its text. Let the control grow, or wrap its text " +
    'inside it; if a container cannot hold every control, drop whole controls rather than cut one.';
  const MECHANICS =
    'No text-overflow: ellipsis, no white-space: nowrap with overflow hidden, no fixed width or height on the ' +
    'control. A chip that is wider than its row wraps inside itself (max-width: 100%; white-space: normal).';
  const cut = { attempt: { truncatedControls: ['Start a new notebook for this week'] } };

  it('the fix is the rule and the mechanics, with no chip example where the prompt did not teach one', () => {
    expect(truncatedControlsVerdict('xs-chat-card', cut)?.fix).toBe(`${RULE} ${MECHANICS}`);
    expect(truncatedControlsVerdict('xs-chat-card', cut, { offeredChoiceTaught: false })?.fix).toBe(`${RULE} ${MECHANICS}`);
  });

  it('the fix adds the chip example where the prompt taught the offered-items choice', () => {
    expect(truncatedControlsVerdict('xs-chat-card', cut, { offeredChoiceTaught: true })?.fix).toBe(
      `${RULE} ${MECHANICS} ${NO_TRUNCATE_CHIP_EXAMPLE}`,
    );
  });

  it('the chip example is the one the offered-items fragment teaches, verbatim (one text, two places)', () => {
    expect(NO_TRUNCATE_CHIP_EXAMPLE).toBe('A group of quick-reply chips is `<Row wrap maxRows={3}>`.');
    const taught = REVEALED_PROPS.filter((r) => r.axis === 'choice' && r.value === 'offered-items');
    expect(taught.length).toBeGreaterThan(0);
    expect(taught.some((r) => r.description.includes(NO_TRUNCATE_CHIP_EXAMPLE))).toBe(true);
  });

  it('no label, or no reading, is no verdict', () => {
    expect(truncatedControlsVerdict('md', { attempt: { truncatedControls: [] } })).toBeNull();
    expect(truncatedControlsVerdict('md', { attempt: { truncatedControls: null } })).toBeNull();
    expect(truncatedControlsVerdict('md', { attempt: {} })).toBeNull();
  });
});

describe('runVisualFit carries the pin on every capture shape (ggui#2010)', () => {
  const hasTruncated = (issues: readonly { subcategory?: string }[]) => issues.some((i) => (i.subcategory ?? '').includes('control-truncated'));

  it.each([
    ['the natural inline card (xs-chat-card)', UNFRAMED, 'xs-chat-card'],
    ['the card-box capture (a framed card at md)', FRAMED, 'md'],
    ['the full-page capture (an unframed card at md)', UNFRAMED, 'md'],
  ] as const)('%s: a cut label fails the canvas as control-truncated', async (_shape, code, canvas) => {
    const outcome = await runVisualFit({ compiledCode: code, originalPrompt: 'a hello' }, { canvases: [canvas] }, deps(['Start a new notebook']));
    expect(outcome.status).toBe('measured');
    if (outcome.status === 'measured') expect(hasTruncated(outcome.issues)).toBe(true);
  });

  it('the context says whether the prompt taught the chip example, and the fix follows it', async () => {
    const fixOf = async (offeredChoiceTaught: boolean | undefined) => {
      const outcome = await runVisualFit(
        { compiledCode: UNFRAMED, originalPrompt: 'a hello', ...(offeredChoiceTaught !== undefined ? { offeredChoiceTaught } : {}) },
        { canvases: ['xs-chat-card'] },
        deps(['Start a new notebook']),
      );
      return outcome.status === 'measured' ? outcome.issues.find((i) => (i.subcategory ?? '').includes('control-truncated'))?.fix : undefined;
    };
    expect(await fixOf(true)).toContain(NO_TRUNCATE_CHIP_EXAMPLE);
    expect(await fixOf(false)).not.toContain(NO_TRUNCATE_CHIP_EXAMPLE);
    expect(await fixOf(undefined)).not.toContain(NO_TRUNCATE_CHIP_EXAMPLE);
  });

  it('control: nothing cut, or a read that is not a label list, carries no truncation issue', async () => {
    for (const labels of [[], 200, null]) {
      const outcome = await runVisualFit({ compiledCode: UNFRAMED, originalPrompt: 'a hello' }, { canvases: ['xs-chat-card'] }, deps(labels));
      if (outcome.status === 'measured') expect(hasTruncated(outcome.issues)).toBe(false);
    }
  });
});

describe('the judged canvas carries the cut labels (ggui#2010) — a consumer refusing on `passed` can name them', () => {
  // Verbatim: a duplicate and a padded label stay as the instrument read them (no trim, no dedup).
  const LABELS = ['Show recent notes', 'Show recent notes', '  Archive  '];
  const judge = (labels: unknown) =>
    runVisualEvaluationDetailed({ compiledCode: UNFRAMED, originalPrompt: 'a hello' }, { provider: 'claude', passThreshold: 70, canvases: ['md'] }, judgedDeps(labels));

  it('a cut label: passed=false at a passing score, the labels on the canvas and on its summary, verbatim', async () => {
    const { result } = await judge(LABELS);
    const md = result?.canvases?.[0];
    expect(md?.score).toBe(85);
    expect(md?.overflow).toBe(false);
    expect(md?.passed).toBe(false);
    expect(md?.truncatedControls).toEqual(LABELS);
    const summary = result === null ? undefined : summarizeVisualResult(result);
    expect(summary?.canvases[0]?.truncatedControls).toEqual(LABELS);
  });

  it('control: nothing cut, or no reading — passed at the same score and no member (absent, never [])', async () => {
    for (const labels of [[], null, 200]) {
      const { result } = await judge(labels);
      const md = result?.canvases?.[0];
      expect(md?.passed).toBe(true);
      expect(md).not.toHaveProperty('truncatedControls');
      const summary = result === null ? undefined : summarizeVisualResult(result);
      expect(summary?.canvases[0]).not.toHaveProperty('truncatedControls');
    }
  });

  it('truncatedControlLabels is the one source the verdict and the member read', () => {
    expect(truncatedControlLabels({ attempt: { truncatedControls: LABELS } })).toEqual(LABELS);
    expect(truncatedControlLabels({ attempt: { truncatedControls: [] } })).toBeNull();
    expect(truncatedControlLabels({ attempt: { truncatedControls: null } })).toBeNull();
    expect(truncatedControlLabels({ attempt: {} })).toBeNull();
  });
});
