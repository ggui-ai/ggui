/**
 * MVB-7 — variant-card focused tests.
 *
 * Asserts the badge surface (persona, source, validatorScore,
 * createdBy) + the three action buttons. Heavy interaction lives in
 * the list test; this file pins per-card semantics so future tweaks
 * to {@link BlueprintVariantCard} don't silently drop the metadata
 * surface.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { Blueprint } from '@ggui-ai/protocol';
import { BlueprintVariantCard } from './BlueprintVariantCard.js';

afterEach(() => {
  cleanup();
});

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintId: 'bp-test-1',
    contractHash: 'hash-a',
    appId: 'app-test',
    source: {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
    variance: {},
    createdAt: '2026-05-12T00:00:00Z',
    createdBy: 'agent',
    contract: { intent: 'test' } as Blueprint['contract'],
    ...overrides,
  };
}

describe('BlueprintVariantCard — badges', () => {
  it('shows persona, source (generator slug), validatorScore, and createdBy badges', () => {
    const blueprint = makeBlueprint({
      source: {
        kind: 'llm',
        generator: 'ui-gen-advanced-opus-4-7',
        model: 'claude-opus-4-7',
      },
      validatorScore: 0.87,
      createdBy: 'operator',
      variance: { persona: 'minimalist' },
    });
    render(
      <ul>
        <BlueprintVariantCard
          blueprint={blueprint}
          index={0}
          onPreview={vi.fn()}
          onSetDefault={vi.fn()}
          onDelete={vi.fn()}
        />
      </ul>,
    );
    expect(screen.getByText(/persona: minimalist/i)).toBeTruthy();
    expect(screen.getByText(/ui-gen-advanced-opus-4-7/)).toBeTruthy();
    expect(screen.getByText(/score 0\.87/)).toBeTruthy();
    expect(screen.getByText(/by operator/i)).toBeTruthy();
  });

  it('stamps default-flag data-attr when isOperatorDefault is true', () => {
    const blueprint = makeBlueprint({ isOperatorDefault: true });
    const { container } = render(
      <ul>
        <BlueprintVariantCard
          blueprint={blueprint}
          index={0}
          onPreview={vi.fn()}
          onSetDefault={vi.fn()}
          onDelete={vi.fn()}
        />
      </ul>,
    );
    const card = container.querySelector('[data-ggui-variant-card]');
    expect(card?.getAttribute('data-ggui-variant-default')).toBe('true');
    // set-default button disabled when already default
    const setDefaultBtn = container.querySelector(
      '[data-ggui-variant-action="set-default"]',
    ) as HTMLButtonElement;
    expect(setDefaultBtn.disabled).toBe(true);
  });

  it('fires preview / set-default / delete callbacks with the blueprintId', () => {
    const onPreview = vi.fn();
    const onSetDefault = vi.fn();
    const onDelete = vi.fn();
    const blueprint = makeBlueprint({ blueprintId: 'bp-callback' });
    const { container } = render(
      <ul>
        <BlueprintVariantCard
          blueprint={blueprint}
          index={0}
          onPreview={onPreview}
          onSetDefault={onSetDefault}
          onDelete={onDelete}
        />
      </ul>,
    );
    fireEvent.click(
      container.querySelector('[data-ggui-variant-action="preview"]')!,
    );
    fireEvent.click(
      container.querySelector('[data-ggui-variant-action="set-default"]')!,
    );
    fireEvent.click(
      container.querySelector('[data-ggui-variant-action="delete"]')!,
    );
    expect(onPreview).toHaveBeenCalledWith('bp-callback');
    expect(onSetDefault).toHaveBeenCalledWith('bp-callback');
    expect(onDelete).toHaveBeenCalledWith('bp-callback');
  });

  it('renders the compare-toggle button when onCompareToggle is provided', () => {
    const onCompareToggle = vi.fn();
    const blueprint = makeBlueprint({ blueprintId: 'bp-compare' });
    const { container } = render(
      <ul>
        <BlueprintVariantCard
          blueprint={blueprint}
          index={0}
          onPreview={vi.fn()}
          onSetDefault={vi.fn()}
          onDelete={vi.fn()}
          onCompareToggle={onCompareToggle}
        />
      </ul>,
    );
    fireEvent.click(
      container.querySelector('[data-ggui-variant-action="compare-toggle"]')!,
    );
    expect(onCompareToggle).toHaveBeenCalledWith('bp-compare');
  });
});
