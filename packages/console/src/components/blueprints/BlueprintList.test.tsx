/**
 * MVB-7 — focused render + grouping tests for the variants list.
 *
 * Light by design (per the plan §Phase 7 — "5-10 component tests for
 * console UI, lighter — Phase 7 is operator UX, browser-verified").
 * The unit lane asserts grouping logic + filter compatibility +
 * data-attr contract; the brand-kit visual checks live in browser
 * specs.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { Blueprint } from '@ggui-ai/protocol';
import {
  BlueprintList,
  groupBlueprintsByContract,
} from './BlueprintList.js';
import {
  EMPTY_VARIANT_FILTERS,
} from './BlueprintFilterBar.js';

afterEach(() => {
  cleanup();
});

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintId: 'bp-test-1',
    contractHash: 'hash-a',
    appId: 'app-test',
    generator: 'ui-gen-default-haiku-4-5',
    variance: {},
    createdAt: '2026-05-12T00:00:00Z',
    createdBy: 'agent',
    contract: { intent: 'test' } as Blueprint['contract'],
    ...overrides,
  };
}

describe('groupBlueprintsByContract', () => {
  it('groups multiple blueprints by contractHash', () => {
    const blueprints = [
      makeBlueprint({ blueprintId: 'bp-1', contractHash: 'hash-a' }),
      makeBlueprint({ blueprintId: 'bp-2', contractHash: 'hash-a' }),
      makeBlueprint({ blueprintId: 'bp-3', contractHash: 'hash-b' }),
    ];
    const groups = groupBlueprintsByContract(blueprints);
    expect(groups).toHaveLength(2);
    const hashA = groups.find((g) => g.contractHash === 'hash-a');
    const hashB = groups.find((g) => g.contractHash === 'hash-b');
    expect(hashA?.blueprints.map((b) => b.blueprintId).sort()).toEqual([
      'bp-1',
      'bp-2',
    ]);
    expect(hashB?.blueprints.map((b) => b.blueprintId)).toEqual(['bp-3']);
  });

  it('orders within-group by operator-default → score desc → createdAt desc', () => {
    const blueprints = [
      makeBlueprint({
        blueprintId: 'bp-mid',
        contractHash: 'hash-a',
        validatorScore: 0.7,
        createdAt: '2026-05-12T10:00:00Z',
      }),
      makeBlueprint({
        blueprintId: 'bp-default',
        contractHash: 'hash-a',
        isOperatorDefault: true,
        validatorScore: 0.5,
        createdAt: '2026-05-12T09:00:00Z',
      }),
      makeBlueprint({
        blueprintId: 'bp-top',
        contractHash: 'hash-a',
        validatorScore: 0.95,
        createdAt: '2026-05-12T08:00:00Z',
      }),
    ];
    const [group] = groupBlueprintsByContract(blueprints);
    expect(group?.blueprints.map((b) => b.blueprintId)).toEqual([
      'bp-default',
      'bp-top',
      'bp-mid',
    ]);
  });

  it('uses contract.intent as group label when present, else hash prefix', () => {
    const withIntent = makeBlueprint({
      contractHash: 'h1',
      contract: { intent: 'create-task' } as Blueprint['contract'],
    });
    const withoutIntent = makeBlueprint({
      contractHash: 'h2-very-long-content-hash-string',
      contract: {} as Blueprint['contract'],
    });
    const groups = groupBlueprintsByContract([withIntent, withoutIntent]);
    const g1 = groups.find((g) => g.contractHash === 'h1');
    const g2 = groups.find((g) => g.contractHash === 'h2-very-long-content-hash-string');
    expect(g1?.intent).toBe('create-task');
    expect(g2?.intent).toContain('h2-very-l');
  });
});

describe('BlueprintList — render', () => {
  const noopOnPreview = vi.fn();
  const noopOnSetDefault = vi.fn();
  const noopOnDelete = vi.fn();
  const noopOnOpenContract = vi.fn();
  const noopOnGenerate = vi.fn();

  it('renders empty state when no blueprints', () => {
    render(
      <BlueprintList
        blueprints={[]}
        filters={EMPTY_VARIANT_FILTERS}
        onPreview={noopOnPreview}
        onSetDefault={noopOnSetDefault}
        onDelete={noopOnDelete}
        onOpenContract={noopOnOpenContract}
        onGenerate={noopOnGenerate}
      />,
    );
    expect(screen.getByText(/no blueprints for this app yet/i)).toBeTruthy();
  });

  it('renders a group per contract with the right data-attrs', () => {
    const blueprints = [
      makeBlueprint({ blueprintId: 'bp-1', contractHash: 'hash-a' }),
      makeBlueprint({ blueprintId: 'bp-2', contractHash: 'hash-a' }),
      makeBlueprint({ blueprintId: 'bp-3', contractHash: 'hash-b' }),
    ];
    const { container } = render(
      <BlueprintList
        blueprints={blueprints}
        filters={EMPTY_VARIANT_FILTERS}
        onPreview={noopOnPreview}
        onSetDefault={noopOnSetDefault}
        onDelete={noopOnDelete}
        onOpenContract={noopOnOpenContract}
        onGenerate={noopOnGenerate}
      />,
    );
    const groups = container.querySelectorAll('[data-ggui-variants-group]');
    expect(groups).toHaveLength(2);
    const hashes = Array.from(groups).map((g) =>
      g.getAttribute('data-ggui-variants-group-hash'),
    );
    expect(hashes).toContain('hash-a');
    expect(hashes).toContain('hash-b');
  });

  it('renders the operator-default star on the pinned variant', () => {
    const blueprints = [
      makeBlueprint({
        blueprintId: 'bp-default',
        contractHash: 'hash-a',
        isOperatorDefault: true,
      }),
      makeBlueprint({ blueprintId: 'bp-other', contractHash: 'hash-a' }),
    ];
    const { container } = render(
      <BlueprintList
        blueprints={blueprints}
        filters={EMPTY_VARIANT_FILTERS}
        onPreview={noopOnPreview}
        onSetDefault={noopOnSetDefault}
        onDelete={noopOnDelete}
        onOpenContract={noopOnOpenContract}
        onGenerate={noopOnGenerate}
      />,
    );
    const defaultCard = container.querySelector(
      '[data-ggui-variant-id="bp-default"]',
    );
    expect(defaultCard?.getAttribute('data-ggui-variant-default')).toBe('true');
    const otherCard = container.querySelector(
      '[data-ggui-variant-id="bp-other"]',
    );
    expect(otherCard?.getAttribute('data-ggui-variant-default')).toBe('false');
  });

  it('narrows visible variants when persona filter is set', () => {
    const blueprints = [
      makeBlueprint({
        blueprintId: 'bp-min',
        contractHash: 'hash-a',
        variance: { persona: 'minimalist' },
      }),
      makeBlueprint({
        blueprintId: 'bp-dense',
        contractHash: 'hash-a',
        variance: { persona: 'data-dense' },
      }),
    ];
    const { container } = render(
      <BlueprintList
        blueprints={blueprints}
        filters={{
          persona: 'min',
          generator: '',
          draftsOnly: false,
        }}
        onPreview={noopOnPreview}
        onSetDefault={noopOnSetDefault}
        onDelete={noopOnDelete}
        onOpenContract={noopOnOpenContract}
        onGenerate={noopOnGenerate}
      />,
    );
    const group = container.querySelector('[data-ggui-variants-group]');
    expect(group?.getAttribute('data-ggui-variants-group-count')).toBe('1');
    const cards = within(group as HTMLElement).queryAllByText(/minimalist/i);
    expect(cards.length).toBeGreaterThan(0);
  });
});
