/**
 * MVB-7 — A/B side-by-side mounts two preview iframes.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import type { Blueprint } from '@ggui-ai/protocol';
import { BlueprintComparison } from './BlueprintComparison.js';

afterEach(() => {
  cleanup();
});

function makeBlueprint(overrides: Partial<Blueprint> = {}): Blueprint {
  return {
    blueprintId: 'bp-test',
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

describe('BlueprintComparison', () => {
  it('mounts one preview per blueprint', () => {
    const blueprints = [
      makeBlueprint({ blueprintId: 'bp-a', codeHash: 'hash-a-code' }),
      makeBlueprint({ blueprintId: 'bp-b', codeHash: 'hash-b-code' }),
    ];
    const { container } = render(
      <BlueprintComparison blueprints={blueprints} />,
    );
    const wrapper = container.querySelector('[data-ggui-variant-comparison]');
    expect(wrapper?.getAttribute('data-ggui-variant-comparison-count')).toBe(
      '2',
    );
    const previews = container.querySelectorAll('[data-ggui-variant-preview]');
    expect(previews).toHaveLength(2);
  });

  it('renders pending placeholder for blueprints without codeHash', () => {
    const blueprints = [
      makeBlueprint({ blueprintId: 'bp-pending' }),
      makeBlueprint({ blueprintId: 'bp-ready', codeHash: 'h' }),
    ];
    const { container } = render(
      <BlueprintComparison blueprints={blueprints} />,
    );
    const pending = container.querySelector(
      '[data-ggui-variant-preview-id="bp-pending"]',
    );
    const ready = container.querySelector(
      '[data-ggui-variant-preview-id="bp-ready"]',
    );
    expect(pending?.getAttribute('data-ggui-variant-preview-state')).toBe(
      'pending',
    );
    expect(ready?.getAttribute('data-ggui-variant-preview-state')).toBe(
      'ready',
    );
  });
});
