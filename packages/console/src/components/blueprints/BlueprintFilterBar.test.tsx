/**
 * MVB-7 — filter bar emission + predicate compatibility tests.
 *
 * Two surfaces:
 *   - The `<BlueprintFilterBar>` component (emits filter changes via
 *     `onChange`).
 *   - The exported `blueprintMatchesFilters` predicate (the same rule
 *     the list consumer applies).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  BlueprintFilterBar,
  EMPTY_VARIANT_FILTERS,
  blueprintMatchesFilters,
  DRAFT_VALIDATOR_THRESHOLD,
} from './BlueprintFilterBar.js';

afterEach(() => {
  cleanup();
});

describe('BlueprintFilterBar — emission', () => {
  it('emits persona changes via onChange', () => {
    const onChange = vi.fn();
    render(
      <BlueprintFilterBar
        filters={EMPTY_VARIANT_FILTERS}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/filter by persona/i), {
      target: { value: 'minimalist' },
    });
    expect(onChange).toHaveBeenCalledWith({
      persona: 'minimalist',
      generator: '',
      draftsOnly: false,
    });
  });

  it('emits generator changes via onChange', () => {
    const onChange = vi.fn();
    render(
      <BlueprintFilterBar
        filters={EMPTY_VARIANT_FILTERS}
        onChange={onChange}
      />,
    );
    fireEvent.change(screen.getByLabelText(/filter by generator/i), {
      target: { value: 'ui-gen-advanced-opus-4-7' },
    });
    expect(onChange).toHaveBeenCalledWith({
      persona: '',
      generator: 'ui-gen-advanced-opus-4-7',
      draftsOnly: false,
    });
  });

  it('emits draftsOnly toggle via onChange', () => {
    const onChange = vi.fn();
    render(
      <BlueprintFilterBar
        filters={EMPTY_VARIANT_FILTERS}
        onChange={onChange}
      />,
    );
    fireEvent.click(screen.getByLabelText(/show drafts only/i));
    expect(onChange).toHaveBeenCalledWith({
      persona: '',
      generator: '',
      draftsOnly: true,
    });
  });
});

describe('blueprintMatchesFilters', () => {
  const baseBlueprint = {
    source: {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    } as const,
    variance: { persona: 'minimalist' as string | undefined },
    validatorScore: undefined as number | undefined,
  };

  it('passes every variant when filters are empty', () => {
    expect(
      blueprintMatchesFilters(baseBlueprint, EMPTY_VARIANT_FILTERS),
    ).toBe(true);
  });

  it('rejects when persona substring missing', () => {
    expect(
      blueprintMatchesFilters(baseBlueprint, {
        persona: 'dense',
        generator: '',
        draftsOnly: false,
      }),
    ).toBe(false);
  });

  it('matches persona case-insensitively', () => {
    expect(
      blueprintMatchesFilters(baseBlueprint, {
        persona: 'MINIM',
        generator: '',
        draftsOnly: false,
      }),
    ).toBe(true);
  });

  it('rejects when generator does not match', () => {
    expect(
      blueprintMatchesFilters(baseBlueprint, {
        persona: '',
        generator: 'ui-gen-advanced-opus-4-7',
        draftsOnly: false,
      }),
    ).toBe(false);
  });

  it('never matches non-llm-sourced variants against an engine slug', () => {
    // Provenance rule (mirrors the ggui_ops_list_blueprints filter):
    // `user` / `curated` rows carry no engine provenance, so an active
    // generator filter excludes them even though they pass other axes.
    const userSourced = {
      ...baseBlueprint,
      source: { kind: 'user' } as const,
    };
    expect(
      blueprintMatchesFilters(userSourced, {
        persona: '',
        generator: 'ui-gen-default-haiku-4-5',
        draftsOnly: false,
      }),
    ).toBe(false);
    expect(
      blueprintMatchesFilters(userSourced, EMPTY_VARIANT_FILTERS),
    ).toBe(true);
  });

  it('draftsOnly excludes variants with no score', () => {
    expect(
      blueprintMatchesFilters(baseBlueprint, {
        persona: '',
        generator: '',
        draftsOnly: true,
      }),
    ).toBe(false);
  });

  it('draftsOnly includes sub-threshold variants', () => {
    const sub = { ...baseBlueprint, validatorScore: 0.5 };
    expect(
      blueprintMatchesFilters(sub, {
        persona: '',
        generator: '',
        draftsOnly: true,
      }),
    ).toBe(true);
  });

  it('draftsOnly excludes at/above threshold variants', () => {
    const pass = { ...baseBlueprint, validatorScore: DRAFT_VALIDATOR_THRESHOLD };
    expect(
      blueprintMatchesFilters(pass, {
        persona: '',
        generator: '',
        draftsOnly: true,
      }),
    ).toBe(false);
  });
});
