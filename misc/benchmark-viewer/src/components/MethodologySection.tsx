import type { BenchmarkMeta } from '@ggui-ai/shared';
import type { CommitSummary } from '../types';
import { formatJudge } from '../format';

interface Props {
  /**
   * Report meta — carries the judge panel disclosure. Optional so the
   * static methodology renders before/without a loaded report; the
   * judge-panel line fills in once a report is present.
   */
  meta?: BenchmarkMeta;
  /**
   * The run's corpus — one entry per prompt/commit. Optional for the
   * same reason; the corpus list renders only when a report is loaded.
   */
  commits?: CommitSummary[];
  /**
   * Base URL of the data source (index.json + per-day reports). When
   * provided, a "raw data" link is rendered. Omitted → no link.
   */
  rawDataUrl?: string;
}

/**
 * The 5 aesthetic dimensions the judge panel scores, with the definitions
 * transcribed verbatim from `AESTHETIC_EVAL_PROMPT` in
 * `oss/misc/benchmark/src/multi-sdk/post-eval.ts`. Kept in sync by hand —
 * the prompt is the source of truth; if it changes, update this list.
 */
const DIMENSIONS: ReadonlyArray<{ label: string; definition: string }> = [
  {
    label: 'layout',
    definition:
      'Is the layout correct? Proper grid/flex usage, responsive, no overflow or clipping issues, appropriate spacing between elements.',
  },
  {
    label: 'designTokens',
    definition:
      'Does it use ggui design tokens? var(--ggui-color-*) for colors (especially semantic: surface, onSurface, outline) and var(--ggui-spacing-*) for padding/margins — no hardcoded hex colors, no rgba()/hsl(), no raw pixel values for spacing.',
  },
  {
    label: 'hierarchy',
    definition:
      'Clear visual hierarchy? Proper heading sizes, section separation, scannable structure, good use of whitespace.',
  },
  {
    label: 'polish',
    definition:
      'Interactive polish? Hover/focus states on buttons/links, transitions, disabled states on forms, loading indicators where appropriate.',
  },
  {
    label: 'dataPresentation',
    definition:
      'Does it render data from props correctly? No placeholder text like "Lorem ipsum", no hardcoded example data in the component body (defaults in props are OK), proper formatting of numbers/dates.',
  },
];

/**
 * Methodology changes, newest first. House rule: methodology never changes
 * silently — cadence, matrix, panel, prompt, and scoring changes are all
 * announced here, dated, because run-to-run comparability is the product.
 */
const CHANGELOG: ReadonlyArray<{ date: string; text: string }> = [
  {
    date: '2026-09-12',
    text:
      'Instrument reading, not a score change: the 2026-09-12 run (source hash ' +
      '187de87f53cf, runner f30ad85) is the first on the primed contract-behaviour ' +
      'check announced below. chat-interface reads as a measurement again (11/11 ' +
      'arms ok). survey-form (0/11) and onboarding-wizard (1/11) now read ' +
      '"action-no-effect" on every arm: the check primes inputs and clicks, but ' +
      'those components put Submit and Complete behind form completion or step ' +
      'navigation the static probe does not perform. That is a limit of the ' +
      'instrument, symmetric across every arm — not a finding about any model — ' +
      'and issue #1040 tracks it. Read those two rows as "not measured" until it ' +
      'closes. Scores, the corpus, the judge panel and every arm are unaffected; ' +
      'history is not rewritten.',
  },
  {
    date: '2026-09-11',
    text:
      'Instrument reading, not a score change: the 2026-09-11 run (source hash ' +
      '072705e0b79e) is the first on the fixed contract-behaviour check, and it ' +
      'shows the next limit of a click-only probe — chat-interface, survey-form ' +
      'and onboarding-wizard read "no clickable control" on every arm because ' +
      'those components disable Send, Submit and Complete until something is ' +
      'typed or chosen, and the check skipped disabled controls and never typed ' +
      '(issue #1021). product-page and kanban-board readings on that row stand. ' +
      'The check now primes inputs first — a value in each empty text field and ' +
      'textarea, the first option of each select, the first radio of an ' +
      'unchosen group — and, when every control is still disabled, says so ' +
      'in words instead of "not rendered". Those three commits read as ' +
      'measurements again from the first run on a runner image carrying the ' +
      'fix; that run\'s row will show the new source hash. Scores, the corpus, ' +
      'the judge panel and every arm are unaffected; history is not rewritten.',
  },
  {
    date: '2026-09-10',
    text:
      'Instrument reading, not a score change: the contract-behaviour check ' +
      'introduced with benchmark-report.v2 reads "action-not-rendered" on 53 of ' +
      'the 55 action-commit cells of the 2026-09-10 run, near-identically across ' +
      'all 11 arms and three providers. That uniformity is the validator, not the ' +
      'models: it locates the control by the action label\'s text and never ' +
      'clicks unnamed controls (issue #996; fix mirrors the harness\'s own ' +
      '"click every clickable, judge by the observed dispatch" rule). The column ' +
      'is not rendered on this page; it is present, self-described by kind and ' +
      'diagnostic, in the public report JSON. Treat it as an instrument reading ' +
      'until an entry here announces the fix. Quality scores, the corpus, the ' +
      'judge panel and every arm are unaffected; history is not rewritten. ' +
      'Same day, the fix: the validator now finds the control the way the ' +
      'generation harness does — controls that name the action first ' +
      '(data-action, aria-label, text), then every clickable, judged by the ' +
      'dispatch actually observed for that action (#996). A second defect found ' +
      'beneath it the same day: the check rendered each component with NO ' +
      'props, so a board or list that draws its controls from props was empty ' +
      'and had nothing to click; it now renders with the commit\'s fixture ' +
      'props — the same props the visual judge receives — and re-collects the ' +
      'live controls after every click, because a filter or an opened editor ' +
      're-renders the tree and a control found earlier may no longer exist. The ' +
      'column reads as a measurement again from the first run on a runner ' +
      'image carrying these ' +
      'fixes — the change-triggered run that follows their landing; that ' +
      'run\'s row will show the new source hash.',
  },
  {
    date: '2026-09-09',
    text:
      'Matrix: an OpenAI frontier arm added — openai-frontier = GPT-6 astra ' +
      '($10 / $50 per MTok), alongside the existing fast, balanced and premium ' +
      'OpenAI arms; the matrix is now 11 arms. As with claude-frontier, the arm ' +
      'carries the "premium" tier label (the tier vocabulary has no frontier ' +
      'value) and is a separate row. Scores for the new arm start with its first ' +
      'run on or after this date; every existing arm, the corpus, and the judge ' +
      'panel are unchanged, so prior rows stay comparable. Reports from this ' +
      'date also carry per-cell fields — the runtime-probe verdict and a ' +
      'contract-behaviour check re-run in-task for every cell — under ' +
      'meta.schemaVersion = "benchmark-report.v2"; these add disclosure and ' +
      'change no score. History is not rewritten.',
  },
  {
    date: '2026-09-07',
    text:
      'Generator identities de-modeled: the two generation harnesses are now ' +
      'identified as `ui-gen-default` and `ui-gen-advanced` (previously ' +
      '`ui-gen-default-haiku-4-5` and `ui-gen-advanced-opus-4-7`). A harness is ' +
      'not a model — the model under test is each arm’s own field — so the ids ' +
      'no longer carry one. Reports published from this date carry the new ids ' +
      'and `meta.schemaVersion = "benchmark-report.v1"`; earlier reports keep ' +
      'their ids unchanged (history is not rewritten). Scores, corpus, matrix, ' +
      'and the judge panel are unchanged.',
  },
  {
    date: '2026-09-03',
    text:
      'Disclosure: the in-loop evaluator’s per-criterion coverage now also ' +
      'counts the cells it bypassed by design (same-image low-risk cells, where ' +
      'no criterion applies). Those cells were always outside the coverage ' +
      'denominator and still are; the change is that a run whose every cell ' +
      'was bypassed now reads "no cell required the in-loop evaluator" instead ' +
      'of carrying no coverage disclosure at all — which was indistinguishable ' +
      'from a run that predates the instrument. Scores, corpus, matrix, and ' +
      'the judge panel are unchanged.',
  },
  {
    date: '2026-09-03',
    text:
      'Cadence refinement: the change detector now keys on a hash of the ' +
      'generation harness and runner source (and their declared ' +
      'dependencies), not on the runner image’s commit. Between ' +
      '2026-08-24 and 2026-09-01, five of the published runs were triggered ' +
      'by image rebuilds caused only by unrelated dependency-lockfile changes ' +
      '— honest re-measurements of an unchanged harness. Those rows stand; ' +
      'from this date such rebuilds no longer trigger a run. Scoring, corpus, ' +
      'matrix, and the judge panel are unchanged.',
  },
  {
    date: '2026-09-02',
    text:
      'Matrix: a Claude frontier arm added — claude-frontier = Claude Fable 5.1 ' +
      '($10 / $50 per MTok), alongside the existing fast (Haiku 4.5), balanced ' +
      '(Sonnet 5), and premium (Opus 5) arms. Both Opus 5 and Fable 5.1 carry ' +
      'the "premium" tier label (the tier vocabulary has no frontier value); ' +
      'they are separate arms with separate rows. Scores for the new arm ' +
      'start with the first run on or after this date; every existing arm, the ' +
      'corpus, and the judge panel are unchanged, so prior rows stay ' +
      'comparable. History is not rewritten.',
  },
  {
    date: '2026-09-02',
    text:
      'Judge disclosure now records the sampling each judge ACTUALLY ran with. ' +
      'The panel requests temperature 0 for reproducibility; the router ' +
      'strips sampling parameters for model families that reject them and ' +
      'reports what it applied. All three pinned judges accept temperature 0, ' +
      'so no published score changes — the line under each run simply says so ' +
      'per judge instead of asserting it.',
  },
  {
    date: '2026-08-25',
    text:
      'Post-hoc finding on the 2026-08-19 judge-coverage collapse: a second ' +
      'candidate cause surfaced — a billing suspension on the account behind ' +
      'the Gemini judge key overlapped that window (all 30 google-variant ' +
      'cells generated but zero were judged; generation preceded judging in ' +
      'each cell). Retroactively indistinguishable from judge rate limiting ' +
      'because failures were silently swallowed at the time — the defect the ' +
      '2026-08-20 resilience change fixed. No scores changed; billing alerts ' +
      'now exist on that account, so a repeat fails loudly.',
  },
  {
    date: '2026-08-21',
    text:
      'Cadence: weekly → change-triggered. The full matrix now fires only ' +
      'when the generation harness, model matrix, or runner changes (a daily ' +
      '03:00 UTC probe checks and exits otherwise), with a 28-day long-stop ' +
      'so provider-side model drift still gets caught. Run dates are ' +
      'therefore irregular by design — every published run corresponds to ' +
      'an actual update. Scoring and corpus are unchanged.',
  },
  {
    date: '2026-08-20',
    text:
      'Per-cell generation timeout for the published weekly run: 300s → 600s. ' +
      'On 2026-08-19, 7 heavy-prompt cells hit the 300s limit and produced no ' +
      'data; success rates on or after this change are measured under the ' +
      'longer budget. Generation wall time is still recorded per cell, so ' +
      'slowness remains visible.',
  },
  {
    date: '2026-08-20',
    text:
      'Judge-panel resilience: judge calls now retry with backoff and are ' +
      'concurrency-capped, and every report discloses its judge coverage ' +
      '(scored cells / generated cells) with a low-coverage flag under 80%. ' +
      'The 2026-08-19 run predates the disclosure fields: only 24 of its 79 ' +
      'generated cells (30%) carry a panel score — its aggregate scores are ' +
      'not representative. Scoring itself is unchanged (panel v3, same ' +
      'prompt); coverage disclosure is additive, not a comparability break.',
  },
  {
    date: '2026-08-19',
    text:
      'Cadence: daily → weekly (Mondays 03:00 UTC). Model matrix refreshed to ' +
      'the current standard lineups — Claude balanced/premium → Sonnet 5 / Opus 5, ' +
      'OpenAI balanced/premium → GPT-5.6 Terra / Sol, Google balanced → ' +
      'Gemini 3.7 Flash (premium stays 3.1 Pro Preview; no higher tier exists). ' +
      'Judge panel: the Google judge moved from a retired preview id to ' +
      'Gemini 3.5 Flash (panel version v2 → v3). Scores on or after this date ' +
      'are not comparable with earlier dates.',
  },
  {
    date: '2026-08-19',
    text:
      'Runs dated 2026-06-15 through 2026-08-19 show 0% success across every ' +
      'cell. That was a pipeline credential outage (the runner fired with ' +
      'unpopulated API-key secrets), not a model failure — no generation was ' +
      'ever attempted. Those runs are kept, honestly, as pipeline history.',
  },
];

/**
 * Standing methodology disclosure for the benchmark dashboard.
 *
 * Renders the static parts (what we measure / how we score / noise band)
 * always; the judge-panel and corpus parts fill in once a report is
 * loaded. This is the credibility surface — it explains the scale, the
 * panel, the variance, and — load-bearing — that we publish per-cell
 * scores, NOT a provider ranking.
 */
export function MethodologySection({ meta, commits, rawDataUrl }: Props) {
  const judges = meta?.judges;
  return (
    <section className="rule-line pt-6 mt-12 max-w-3xl">
      <p className="eyebrow mb-4">methodology</p>

      <div className="space-y-8 text-sm text-ink-3 leading-relaxed">
        <div>
          <h3 className="text-ink font-semibold mb-3">What we measure</h3>
          <dl className="space-y-2">
            {DIMENSIONS.map((d) => (
              <div key={d.label}>
                <dt className="font-mono text-ink inline">{d.label}</dt>
                <dd className="inline"> — {d.definition}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">How we score</h3>
          <p>
            Each dimension is scored 0–100. The 5 dimensions are equally
            weighted (20% each) into a single 0–100 quality score. A cell
            passes at a threshold of 70.
          </p>
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">Judge panel</h3>
          <p>
            Every score is the mean of a 3-model LLM judge panel — one model
            each from Anthropic, OpenAI, and Google — scored at temperature 0.
            Averaging across providers neutralizes single-model bias (no model
            grades only its own family), and we report the per-cell spread
            (max−min of the panel) as a disagreement signal.
          </p>
          {judges && judges.length > 0 && (
            <p className="font-mono text-xs text-ink-4 mt-2">
              panel: {judges.map(formatJudge).join(', ')}
            </p>
          )}
        </div>

        <div>
          <h3 className="text-ink font-semibold mb-2">Noise band</h3>
          <p>
            LLM-judge scores carry inherent variance — the same component can
            score a few points apart across runs. We surface the per-cell
            spread so you can see where the panel disagreed.{' '}
            <strong className="text-ink font-semibold">
              We publish per-cell scores, not a provider ranking.
            </strong>{' '}
            Small score gaps between providers are within the noise band and
            should not be read as one model being "better".
          </p>
        </div>

        {commits && commits.length > 0 && (
          <div>
            <h3 className="text-ink font-semibold mb-2">Corpus</h3>
            <p className="mb-2">
              {commits.length} fixed prompt{commits.length === 1 ? '' : 's'},
              run identically across every variant:
            </p>
            <ul className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-xs text-ink-4">
              {commits.map((c) => (
                <li key={c.commitId}>
                  {c.name} <span className="text-ink-3">({c.commitId})</span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div>
          <h3 className="text-ink font-semibold mb-2">Methodology changes</h3>
          <ul className="space-y-2">
            {CHANGELOG.map((entry, i) => (
              <li key={`${entry.date}-${i}`}>
                <span className="font-mono text-xs text-ink-4 mr-2">
                  {entry.date}
                </span>
                {entry.text}
              </li>
            ))}
          </ul>
        </div>

        {rawDataUrl && (
          <div>
            <h3 className="text-ink font-semibold mb-2">Raw data</h3>
            <p>
              Every report on this dashboard is served as plain JSON.{' '}
              <a
                href={new URL('index.json', rawDataUrl).toString()}
                className="font-mono text-ink underline underline-offset-2 hover:text-ink-3"
                target="_blank"
                rel="noreferrer"
              >
                index.json
              </a>{' '}
              lists every run; each links its per-day report.
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
