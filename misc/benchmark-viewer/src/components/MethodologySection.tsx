import type { BenchmarkMeta } from '@ggui-ai/shared';
import type { CommitSummary } from '../types';

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
              panel: {judges.map((j) => j.model).join(', ')}
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
