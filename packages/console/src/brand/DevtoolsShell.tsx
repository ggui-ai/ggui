/**
 * `DevtoolsShell` — sub-shell for the dev-mode debug zone (`/devtools/*`).
 *
 * Sibling to {@link AdminShell}. Same left-rail pattern, different
 * audience: where `/admin/*` is production operator chrome (lean,
 * security-first), `/devtools/*` is the dev-mode firehose — full LLM
 * traces, validator results, cache scoring, session timeline, raw
 * payloads. Default for `ggui dev`; never mounts for `ggui serve`.
 *
 * Three groups:
 *
 *   - **Inspect**     — LLM trace, Validator, Cache
 *   - **Replay**      — Timeline, Payloads
 *   - **Performance** — Benchmarks dashboard
 */
import type { ReactElement, ReactNode } from 'react';
import { navigateTo, type Route } from '../router.js';

export interface DevtoolsShellProps {
  readonly route: Route;
  readonly children: ReactNode;
}

interface RailItem {
  readonly label: string;
  readonly path: string;
  readonly match: Route['kind'];
}

interface RailGroup {
  readonly label: string;
  readonly items: readonly RailItem[];
}

const GROUPS: readonly RailGroup[] = [
  {
    label: 'inspect',
    items: [
      {
        label: 'LLM trace',
        path: '/devtools/llm-trace',
        match: 'devtools-llm-trace',
      },
      {
        label: 'validator',
        path: '/devtools/validator',
        match: 'devtools-validator',
      },
      { label: 'cache', path: '/devtools/cache', match: 'devtools-cache' },
    ],
  },
  {
    label: 'replay',
    items: [
      {
        label: 'timeline',
        path: '/devtools/timeline',
        match: 'devtools-timeline',
      },
      {
        label: 'payloads',
        path: '/devtools/payloads',
        match: 'devtools-payloads',
      },
    ],
  },
  {
    label: 'performance',
    items: [
      {
        label: 'benchmarks',
        path: '/devtools/benchmarks',
        match: 'devtools-benchmarks',
      },
    ],
  },
];

export function DevtoolsShell({
  route,
  children,
}: DevtoolsShellProps): ReactElement {
  return (
    <div className="ggui-config-grid" data-ggui-devtools-shell>
      <DevtoolsRail route={route} />
      <div className="ggui-admin-pane">{children}</div>
    </div>
  );
}

function DevtoolsRail({ route }: { readonly route: Route }): ReactElement {
  return (
    <nav
      className="ggui-config-rail"
      aria-label="devtools sections"
      data-ggui-devtools-rail
    >
      {GROUPS.map((group) => (
        <div key={group.label} data-ggui-devtools-group={group.label}>
          <div
            className="ggui-stack__head"
            style={{ padding: '10px 14px 6px', borderBottom: 0 }}
          >
            <span className="ggui-stack__label" style={{ fontSize: 11 }}>
              {group.label}
            </span>
          </div>
          <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
            {group.items.map((item) => {
              const isActive = route.kind === item.match;
              return (
                <li key={item.path} data-ggui-devtools-item={item.match}>
                  <button
                    type="button"
                    onClick={() => navigateTo(item.path)}
                    aria-current={isActive ? 'page' : undefined}
                    className={`ggui-config-rail__btn${isActive ? ' is-active' : ''}`}
                  >
                    {item.label}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
