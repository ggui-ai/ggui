/**
 * Side-by-side A/B comparison view for two blueprint variants.
 *
 * Wraps two {@link BlueprintPreview} mounts in a two-column grid at
 * equal size so the operator can read aesthetic differences without
 * window-tabbing. Each preview keeps its full metadata header — the
 * operator picks the winner by sight, not by metric.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variant-comparison` on the grid root.
 *   - `data-ggui-variant-comparison-count={n}` so specs can assert
 *     "two iframes mounted" without parsing children.
 */
import type { ReactElement } from 'react';
import type { Blueprint } from '@ggui-ai/protocol';
import { BlueprintPreview } from './BlueprintPreview.js';

export interface BlueprintComparisonProps {
  readonly blueprints: readonly Blueprint[];
  /** Optional iframe height for both panes. */
  readonly height?: number;
}

export function BlueprintComparison({
  blueprints,
  height,
}: BlueprintComparisonProps): ReactElement {
  return (
    <div
      data-ggui-variant-comparison
      data-ggui-variant-comparison-count={blueprints.length}
      style={{
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(blueprints.length, 1)}, minmax(0, 1fr))`,
        gap: 16,
      }}
    >
      {blueprints.map((bp) => (
        <BlueprintPreview
          key={bp.blueprintId}
          blueprint={bp}
          height={height}
          title={bp.variance.persona ?? bp.blueprintId.slice(0, 12)}
        />
      ))}
    </div>
  );
}
