/**
 * Pins for a judge answer cut off at the output cap (ggui#972 slice,
 * 2026-09-11: six kanban cells, `Expected ',' or ']' after array element`):
 * the score is recovered from the closed prefix in ONE call with a logged
 * `visual_judge_truncated`; a prefix without all four dimensions falls to
 * the retry path; the cap and the bounded-list instruction are pinned.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  VISUAL_JUDGE_MAX_OUTPUT_TOKENS,
  VISUAL_JUDGE_PROMPT_VERSION,
  VISUAL_JUDGE_PROMPT_DIGEST,
  VISUAL_EVAL_PROMPT,
  runVisualEvaluationDetailed,
  salvageTruncatedVisualAnswer,
  type ScreenshotBrowser,
  type VisualEvalDeps,
} from './visual-evaluator.js';

const COMPONENT = 'export default function C(){ return null; }';
const TRUNCATED =
  '{\n  "completeness": 88,\n  "layout": 76,\n  "hierarchy": 80,\n  "aesthetics": 84,\n  "issues": [\n' +
  '    { "dimension": "layout", "severity": "major", "description": "columns stacked", "fix": "use a row" },\n' +
  '    { "dimension": "aesthetics", "severity": "minor", "description": "flat cards", "fix": "add a shadow" },\n' +
  '    { "dimension": "layout", "severity": "minor", "description": "cut he';
const NO_DIMS = '{\n  "completeness": 88,\n  "layout": 76,\n  "issues": [ { "dimension": "lay';

function deps(answers: readonly string[]): VisualEvalDeps & { calls: number } {
  const state = { calls: 0 };
  return {
    get calls() {
      return state.calls;
    },
    launch: async (): Promise<ScreenshotBrowser> => ({
      newPage: async () => ({
        setContent: async () => {},
        waitForNetworkIdle: async () => {},
        waitForSelector: async () => null,
        evaluate: async () => 0,
        screenshot: async () => new Uint8Array([1, 2]),
      }),
      close: async () => {},
    }),
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => {
      const text = answers[Math.min(state.calls, answers.length - 1)] ?? '';
      state.calls += 1;
      return { text, inputTokens: 1, outputTokens: 1 };
    },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('visual judge — truncated answers', () => {
  it('cap ≥ 4096 and the prompt bounds the issues list', () => {
    expect(VISUAL_JUDGE_MAX_OUTPUT_TOKENS).toBeGreaterThanOrEqual(4096);
    expect(VISUAL_EVAL_PROMPT).toContain('AT MOST 6 issues');
  });
  it('the instrument name is tied to the bounded-list text and the digest to the prompt bytes', () => {
    expect(VISUAL_JUDGE_PROMPT_VERSION).toBe('v2-bounded-issues');
    expect(VISUAL_EVAL_PROMPT.includes('AT MOST 6 issues')).toBe(true); // the name promises this text
    expect(VISUAL_JUDGE_PROMPT_DIGEST).toBe(createHash('sha256').update(VISUAL_EVAL_PROMPT, 'utf8').digest('hex'));
    expect(VISUAL_JUDGE_PROMPT_DIGEST).toMatch(/^[0-9a-f]{64}$/);
  });
  it('salvage: all four dimensions + the closed issues, the critique replaced by a truncation note', () => {
    const r = salvageTruncatedVisualAnswer(TRUNCATED, 60);
    expect(r).not.toBeNull();
    expect(r?.finalScore).toBe(82);
    expect(r?.issues.length).toBe(2);
    expect(r?.critique).toContain('truncated');
    expect(salvageTruncatedVisualAnswer(NO_DIMS, 60)).toBeNull();
  });
  it('a truncated answer is recovered in ONE judge call with a logged visual_judge_truncated (no retry)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([TRUNCATED]);
    const out = await runVisualEvaluationDetailed(
      { compiledCode: COMPONENT, originalPrompt: 'x' },
      { provider: 'claude', passThreshold: 60, canvases: ['md'] },
      d,
    );
    expect(out.result?.finalScore).toBe(82);
    expect(d.calls).toBe(1);
    expect(warn.mock.calls.filter((c) => String(c[0]).includes('visual_judge_truncated')).length).toBe(1);
  });
  it('a prefix without all dimensions falls to the retry path (two calls) and then unavailable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const d = deps([NO_DIMS, NO_DIMS]);
    const out = await runVisualEvaluationDetailed({ compiledCode: COMPONENT, originalPrompt: 'x' }, { provider: 'claude', passThreshold: 60 }, d);
    expect(out.result).toBeNull();
    expect(d.calls).toBe(2);
    expect(out.unavailableReason?.startsWith('judge answer unparsable:')).toBe(true);
  });
});
