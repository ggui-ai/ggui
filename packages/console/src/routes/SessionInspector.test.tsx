/**
 * SessionInspector — Slice 9b focused render tests.
 *
 * Lane 3 of the 4-lane taxonomy (vitest + jsdom render, no browser
 * spawn). Three concerns covered:
 *
 *   - Contract panel renders sections for actionSpec / streamSpec /
 *     propsSpec when present; honest empty-state when nothing
 *     declared.
 *   - Activity panel renders rows for dispatch / response / stream
 *     in arrival order; ring buffer cap prevents unbounded growth.
 *   - Test action panel disables when no actions declared; fires
 *     parsed JSON through the dispatcher when payload is valid;
 *     surfaces parse error when payload is invalid.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { StackItem } from '@ggui-ai/protocol';
import {
  ACTIVITY_TABS,
  MAX_ACTIVITY_EVENTS,
  SessionInspector,
  activityEventMatchesTab,
  type ActivityEvent,
  type ActivityTab,
} from './SessionInspector.js';

afterEach(() => {
  cleanup();
});

function makeStackItem(overrides: Partial<StackItem> = {}): StackItem {
  return {
    id: 'test-stack-item',
    componentCode: 'export default () => null',
    createdAt: '2026-04-22T00:00:00Z',
    ...overrides,
  };
}

describe('SessionInspector — contract panel', () => {
  it('renders the empty-contract copy when no actionSpec/streamSpec/propsSpec declared', () => {
    const entry = makeStackItem();
    render(
      <SessionInspector
        entry={entry}
        entryIndex={0}
        activity={[]}
        onFireAction={vi.fn()}
      />,
    );
    // Expand the contract disclosure.
    fireEvent.click(screen.getByText(/▸ contract/));
    expect(
      screen.getByText(/no contract declared on this stack entry/i),
    ).toBeTruthy();
  });

  it('renders actionSpec rows when actions are declared', () => {
    const entry = makeStackItem({
      actionSpec: {
        'tasks.create': {
          label: 'Create',
          description: 'Create a new task',
          
        },
        'tasks.complete': {
          label: 'Complete',
          description: 'Mark task complete',
          
        },
      },
    });
    render(
      <SessionInspector
        entry={entry}
        entryIndex={0}
        activity={[]}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ contract/));
    expect(screen.getByText('tasks.create')).toBeTruthy();
    expect(screen.getByText('tasks.complete')).toBeTruthy();
    // Section header reflects count.
    expect(screen.getByText(/ACT · 2 actions/)).toBeTruthy();
  });

  it('renders streamSpec channels with mode + replay metadata', () => {
    const entry = makeStackItem({
      streamSpec: {
        tasks: {
          schema: { type: 'array' },
          mode: 'replace',
          replay: 'latest',
        },
      },
    });
    render(
      <SessionInspector
        entry={entry}
        entryIndex={0}
        activity={[]}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ contract/));
    expect(screen.getByText('tasks')).toBeTruthy();
    expect(screen.getByText(/replace · replay latest/)).toBeTruthy();
  });
});

describe('SessionInspector — activity panel', () => {
  it('renders a row per activity event with the correct direction tag', () => {
    const activity: readonly ActivityEvent[] = [
      {
        kind: 'dispatch',
        id: 'evt-1',
        at: 1000,
        stackIndex: 0,
        data: { foo: 'bar' },
      },
      {
        kind: 'response',
        id: 'evt-2',
        at: 2000,
        data: { foo: 'bar' },
        response: { ok: true },
      },
      {
        kind: 'stream',
        id: 'evt-3',
        at: 3000,
        payload: [{ id: 1 }],
      },
    ];
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={activity}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    const rows = document.querySelectorAll('[data-ggui-inspect-event]');
    expect(rows.length).toBe(3);
    const directions = Array.from(rows).map((r) =>
      r.getAttribute('data-ggui-inspect-event-direction'),
    );
    // Reverse-order render — newest at top.
    expect(directions).toEqual(['stream', 'response', 'dispatch']);
  });

  it('renders the empty-activity copy when no events recorded', () => {
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={[]}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    expect(screen.getByText(/no activity yet/i)).toBeTruthy();
  });

  it('shows total count vs MAX_ACTIVITY_EVENTS in the disclosure header', () => {
    const activity: ActivityEvent[] = [];
    for (let i = 0; i < 5; i++) {
      activity.push({
        kind: 'dispatch',
        id: `evt-${i}`,
        at: 1000 + i,
        stackIndex: 0,
        data: { i },
      });
    }
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={activity}
        onFireAction={vi.fn()}
      />,
    );
    expect(
      screen.getByText(new RegExp(`5/${MAX_ACTIVITY_EVENTS}`)),
    ).toBeTruthy();
  });
});

// ── C12 filter-tab tests ──────────────────────────────────────────────
//
// Brief §C12 Area C: five tabs `All / Actions / Errors / Version /
// Subscribe` filter the activity list by `ActivityEvent` kind +
// nested observability `event.kind`. Tab tests assert the classifier
// + the rendered tab strip.

describe('SessionInspector — activityEventMatchesTab classifier', () => {
  const rows: Record<string, ActivityEvent> = {
    dispatch: {
      kind: 'dispatch',
      id: 'd-1',
      at: 1,
      stackIndex: 0,
      data: {},
    },
    response: {
      kind: 'response',
      id: 'r-1',
      at: 1,
      data: {},
      response: {},
    },
    stream: { kind: 'stream', id: 's-1', at: 1, payload: {} },
    wiredTool: {
      kind: 'observe',
      id: 'o-1',
      at: 1,
      event: { kind: 'wired-tool-invoked', toolName: 't' },
    },
    contractErr: {
      kind: 'observe',
      id: 'o-2',
      at: 1,
      event: { kind: 'contract-error-emitted', code: 'TOOL_THREW' },
    },
    versionMismatch: {
      kind: 'observe',
      id: 'o-3',
      at: 1,
      event: { kind: 'schema-version-mismatch', observedVersion: '1' },
    },
    subFailed: {
      kind: 'observe',
      id: 'o-4',
      at: 1,
      event: { kind: 'subscribe-failed', reason: 'x' },
    },
    unknownObs: {
      kind: 'observe',
      id: 'o-5',
      at: 1,
      event: { kind: 'brand-new-kind', detail: true },
    },
  };

  const cases: Array<[ActivityTab, Array<keyof typeof rows>]> = [
    [
      'All',
      [
        'dispatch',
        'response',
        'stream',
        'wiredTool',
        'contractErr',
        'versionMismatch',
        'subFailed',
        'unknownObs',
      ],
    ],
    ['Actions', ['dispatch', 'response', 'wiredTool']],
    ['Errors', ['contractErr']],
    ['Version', ['versionMismatch']],
    ['Subscribe', ['stream', 'subFailed']],
  ];

  for (const [tab, expected] of cases) {
    it(`buckets ${tab} events correctly`, () => {
      const matched = (Object.entries(rows) as Array<[keyof typeof rows, ActivityEvent]>)
        .filter(([, event]) => activityEventMatchesTab(event, tab))
        .map(([key]) => key)
        .sort();
      expect(matched).toEqual([...expected].sort());
    });
  }

  it('an unknown observability kind only appears under All', () => {
    const unknown = rows.unknownObs;
    if (unknown === undefined) throw new Error('missing unknown fixture');
    expect(activityEventMatchesTab(unknown, 'All')).toBe(true);
    for (const tab of ACTIVITY_TABS.filter((t) => t !== 'All')) {
      expect(activityEventMatchesTab(unknown, tab)).toBe(false);
    }
  });
});

describe('SessionInspector — activity tab strip', () => {
  const activity: readonly ActivityEvent[] = [
    {
      kind: 'dispatch',
      id: 'd-1',
      at: 1,
      stackIndex: 0,
      data: { id: 'x' },
    },
    {
      kind: 'observe',
      id: 'o-1',
      at: 2,
      event: { kind: 'wired-tool-invoked', toolName: 'tasks.create' },
    },
    {
      kind: 'observe',
      id: 'o-2',
      at: 3,
      event: { kind: 'contract-error-emitted', code: 'TOOL_THREW' },
    },
    {
      kind: 'observe',
      id: 'o-3',
      at: 4,
      event: { kind: 'schema-version-mismatch', observedVersion: '99' },
    },
    { kind: 'stream', id: 's-1', at: 5, payload: [{ id: 1 }] },
  ];

  it('renders all five tabs in the declared order', () => {
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={activity}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    const tabs = document.querySelectorAll(
      '[data-ggui-inspect-activity-tab]',
    );
    expect(tabs.length).toBe(ACTIVITY_TABS.length);
    const names = Array.from(tabs).map((t) =>
      t.getAttribute('data-ggui-inspect-activity-tab'),
    );
    expect(names).toEqual([...ACTIVITY_TABS]);
  });

  it('clicking the Errors tab filters the list to contract-error rows only', () => {
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={activity}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    const errorsTab = document.querySelector(
      '[data-ggui-inspect-activity-tab="Errors"]',
    );
    expect(errorsTab).toBeTruthy();
    fireEvent.click(errorsTab as HTMLElement);
    const rows = document.querySelectorAll('[data-ggui-inspect-event]');
    expect(rows.length).toBe(1);
    expect(rows[0]?.getAttribute('data-ggui-inspect-event-direction')).toBe(
      'observe',
    );
  });

  it('clicking the Actions tab includes both dispatch rows and wired-tool-invoked observations', () => {
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={activity}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    const actionsTab = document.querySelector(
      '[data-ggui-inspect-activity-tab="Actions"]',
    );
    fireEvent.click(actionsTab as HTMLElement);
    const rows = document.querySelectorAll('[data-ggui-inspect-event]');
    expect(rows.length).toBe(2);
    const directions = Array.from(rows)
      .map((r) => r.getAttribute('data-ggui-inspect-event-direction'))
      .sort();
    expect(directions).toEqual(['dispatch', 'observe']);
  });

  it('empty-state copy changes when a filter yields zero rows', () => {
    const noErrorsActivity: readonly ActivityEvent[] = [
      {
        kind: 'dispatch',
        id: 'd-1',
        at: 1,
        stackIndex: 0,
        data: {},
      },
    ];
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={noErrorsActivity}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ activity/));
    const errorsTab = document.querySelector(
      '[data-ggui-inspect-activity-tab="Errors"]',
    );
    fireEvent.click(errorsTab as HTMLElement);
    expect(screen.getByText(/no errors activity yet/i)).toBeTruthy();
  });
});

describe('SessionInspector — test action panel', () => {
  it('renders the disabled-state copy when no actionSpec actions declared', () => {
    render(
      <SessionInspector
        entry={makeStackItem()}
        entryIndex={0}
        activity={[]}
        onFireAction={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText(/▸ test action/));
    expect(
      screen.getByText(/the generated ui declared no actions/i),
    ).toBeTruthy();
  });

  it('fires the parsed payload through onFireAction on submit', () => {
    const onFireAction = vi.fn();
    const entry = makeStackItem({
      actionSpec: {
        'tasks.create': {
          label: 'Create',
          
        },
      },
    });
    render(
      <SessionInspector
        entry={entry}
        entryIndex={0}
        activity={[]}
        onFireAction={onFireAction}
      />,
    );
    fireEvent.click(screen.getByText(/▸ test action/));
    const textarea = document.querySelector(
      '[data-ggui-inspect-test-payload]',
    ) as HTMLTextAreaElement;
    expect(textarea).toBeTruthy();
    fireEvent.change(textarea, {
      target: { value: '{"title":"hello"}' },
    });
    fireEvent.click(screen.getByText(/fire →/));
    expect(onFireAction).toHaveBeenCalledTimes(1);
    expect(onFireAction).toHaveBeenCalledWith({ title: 'hello' });
  });

  it('surfaces a parse error and does NOT fire when payload is invalid JSON', () => {
    const onFireAction = vi.fn();
    const entry = makeStackItem({
      actionSpec: {
        'tasks.create': {
          label: 'Create',
          
        },
      },
    });
    render(
      <SessionInspector
        entry={entry}
        entryIndex={0}
        activity={[]}
        onFireAction={onFireAction}
      />,
    );
    fireEvent.click(screen.getByText(/▸ test action/));
    const textarea = document.querySelector(
      '[data-ggui-inspect-test-payload]',
    ) as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '{not valid json' } });
    fireEvent.click(screen.getByText(/fire →/));
    expect(onFireAction).not.toHaveBeenCalled();
    expect(
      document.querySelector('[data-ggui-inspect-test-parse-error]'),
    ).toBeTruthy();
  });
});
