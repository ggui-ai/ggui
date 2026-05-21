/**
 * Elevation Token System
 *
 * Maps semantic elevation levels to shadow + z-index combinations.
 * Provides a unified API for layering UI elements with consistent
 * visual depth and stacking order.
 */

import { shadow } from './spacing';
import { zIndex } from './spacing';

export const elevation = {
  level0: { shadow: 'none' as const, zIndex: 0 },
  level1: { shadow: shadow.sm, zIndex: 'auto' as const },
  level2: { shadow: shadow.md, zIndex: zIndex.dropdown },
  level3: { shadow: shadow.lg, zIndex: zIndex.banner },
  level4: { shadow: shadow.xl, zIndex: zIndex.modal },
  level5: { shadow: shadow['2xl'], zIndex: zIndex.tooltip },
} as const;

export type Elevation = typeof elevation;
export type ElevationLevel = keyof typeof elevation;
