/**
 * `Devtools` — route switcher for the `/devtools/*` namespace.
 *
 * The `/devtools/*` namespace is gated behind `GGUI_MODE=dev`. This
 * component switches on `route.kind` and renders the matching debug
 * surface: LLM trace, validator, cache, timeline, payloads, or the
 * benchmarks dashboard.
 *
 * The index variant (`/devtools`) lists every surface with a one-line
 * "what it answers" description so operators can pick the right one.
 */
import type { ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import type { DevtoolsRoute } from '../router.js';
import { LlmTrace } from './LlmTrace.js';
import { Validator } from './Validator.js';
import { Cache } from './Cache.js';
import { Timeline } from './Timeline.js';
import { Payloads } from './Payloads.js';
import { Benchmarks } from './Benchmarks.js';

interface SurfaceMeta {
  readonly title: string;
  readonly slice: string;
  readonly answers: string;
}

const SURFACES: Record<string, SurfaceMeta> = {
  'devtools-llm-trace': {
    title: 'LLM trace',
    slice: '7a',
    answers: 'Why is my generation slow / wrong?',
  },
  'devtools-validator': {
    title: 'Validator tier results',
    slice: '7b',
    answers: 'Which check failed, and what did the LLM emit?',
  },
  'devtools-cache': {
    title: 'Cache hit/miss + feature vectors',
    slice: '7c',
    answers: "Why didn't this match my saved blueprint?",
  },
  'devtools-timeline': {
    title: 'Render event timeline',
    slice: '7d',
    answers: 'What was the UI state at each event?',
  },
  'devtools-payloads': {
    title: 'Raw render/update payloads',
    slice: '7e',
    answers: 'What did the agent actually send me?',
  },
  'devtools-benchmarks': {
    title: 'Benchmarks dashboard',
    slice: '7f',
    answers: 'How do providers/models score on the public corpus?',
  },
};

export function Devtools({
  route,
}: {
  readonly route: DevtoolsRoute;
}): ReactElement {
  if (route.kind === 'devtools-index') return <DevtoolsIndex />;
  if (route.kind === 'devtools-llm-trace') return <LlmTrace />;
  if (route.kind === 'devtools-validator') return <Validator />;
  if (route.kind === 'devtools-cache') return <Cache />;
  if (route.kind === 'devtools-timeline') return <Timeline />;
  if (route.kind === 'devtools-payloads') return <Payloads />;
  if (route.kind === 'devtools-benchmarks') return <Benchmarks />;
  // Exhaustive — `route` is `never` here. If a new devtools-* kind
  // lands without an explicit handler, this assignment fails to
  // compile, forcing the new branch to be added above.
  const _exhaustive: never = route;
  void _exhaustive;
  return <DevtoolsIndex />;
}

function DevtoolsIndex(): ReactElement {
  return (
    <section className="ggui-section">
      <SectionHead
        num="DEVTOOLS / 00"
        title="Dev-mode debug surfaces."
        mute="GGUI_MODE=dev"
        intro={
          <>
            Default for <code className="ggui-code">ggui dev</code>. Each
            surface answers a different question about the last
            generation; sub-slices ship one at a time.
          </>
        }
      />
      <div className="ggui-card">
        <div className="ggui-card__head">
          <span className="ggui-card__title">surfaces</span>
          <span className="ggui-card__num">DEV / 01</span>
        </div>
        <div className="ggui-card__body">
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              display: 'grid',
              gap: 12,
            }}
          >
            {Object.entries(SURFACES).map(([kind, m]) => (
              <li
                key={kind}
                data-ggui-devtools-surface={kind}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  gap: 16,
                  padding: '10px 0',
                  borderBottom: '1px solid var(--ggui-rule)',
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontWeight: 500 }}>{m.title}</div>
                  <div className="ggui-muted" style={{ fontSize: 13 }}>
                    {m.answers}
                  </div>
                </div>
                <span
                  className="ggui-muted"
                  style={{ fontSize: 12, whiteSpace: 'nowrap' }}
                >
                  Slice {m.slice}
                </span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

