import type { CSSProperties } from 'react';
import type { GridProps, ResponsiveColumns } from './types';
import { renderWithTrait, type WithTrait } from '../interact/trait';
import { resolveSpacing } from './spacing-scale';

/** Viewport breakpoint widths (px), mobile-first, ascending. */
const BREAKPOINTS: ReadonlyArray<readonly [keyof ResponsiveColumns, number]> = [
  ['sm', 640],
  ['md', 768],
  ['lg', 1024],
  ['xl', 1280],
];

// `minmax(0, 1fr)` (not bare `1fr`) keeps wide children from blowing the
// track out past the container — a common CSS-grid footgun.
const track = (n: number): string => `repeat(${n}, minmax(0, 1fr))`;

/** Stable short hash of a responsive-columns config → scoped class suffix. */
function hashColumns(cfg: ResponsiveColumns): string {
  const s = JSON.stringify(cfg);
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/**
 * Grid — 2-D layout primitive. Stack/Row only flow along one axis;
 * Grid arranges children into rows AND columns.
 *
 * Three modes:
 * - fixed: `columns={3}` → three equal columns at every width.
 * - per-breakpoint: `columns={{ base: 1, md: 3 }}` → explicit counts
 *   that change at viewport breakpoints (the design system emits the
 *   media queries; the caller just declares the counts).
 * - fluid: `minColumnWidth={220}` → as many equal columns as fit, each
 *   ≥220px. `columns` is ignored in this mode.
 *
 * Trait composition via `as` — make the grid interactive without
 * changing the JSX tree: `<Grid as={Clickable} onClick={handler}>`.
 */
export function Grid(props: WithTrait<GridProps>) {
  const {
    children,
    columns = 2,
    gap = 'md',
    minColumnWidth,
    style,
    className,
    as: Trait,
    ...traitProps
  } = props;

  const resolvedMin =
    typeof minColumnWidth === 'number' ? `${minColumnWidth}px` : minColumnWidth;

  // ── Fluid mode — `minColumnWidth` wins and `columns` is ignored. ──
  if (resolvedMin !== undefined) {
    const composedStyle: CSSProperties = {
      display: 'grid',
      gridTemplateColumns: `repeat(auto-fill, minmax(${resolvedMin}, 1fr))`,
      gap: resolveSpacing(gap),
      ...style,
    };
    return renderWithTrait(
      Trait,
      traitProps,
      { className, style: composedStyle },
      children,
    );
  }

  // ── Per-breakpoint mode — `columns` is a {base,sm,md,lg,xl} map. ──
  // `grid-template-columns` lives in a scoped class (inline styles can't
  // carry media queries); a co-rendered `<style>` holds the rules. The
  // `<style>` is `display:none` by UA default, so it never becomes a
  // grid cell.
  if (typeof columns === 'object') {
    const cls = `ggui-grid-${hashColumns(columns)}`;
    const rules: string[] = [
      `.${cls}{grid-template-columns:${track(columns.base ?? 1)}}`,
    ];
    for (const [bp, px] of BREAKPOINTS) {
      const n = columns[bp];
      if (typeof n === 'number') {
        rules.push(
          `@media (min-width:${px}px){.${cls}{grid-template-columns:${track(n)}}}`,
        );
      }
    }
    const composedStyle: CSSProperties = {
      display: 'grid',
      gap: resolveSpacing(gap),
      ...style,
    };
    return renderWithTrait(
      Trait,
      traitProps,
      { className: className ? `${className} ${cls}` : cls, style: composedStyle },
      <>
        <style>{rules.join('')}</style>
        {children}
      </>,
    );
  }

  // ── Fixed mode — `columns` is a plain integer. ──
  const composedStyle: CSSProperties = {
    display: 'grid',
    gridTemplateColumns: track(columns),
    gap: resolveSpacing(gap),
    ...style,
  };
  return renderWithTrait(
    Trait,
    traitProps,
    { className, style: composedStyle },
    children,
  );
}
