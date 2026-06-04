/**
 * A2UI v0 seed corpus — 3 cases chosen to exercise distinct
 * deterministic-emitter branches:
 *
 *   - `form-feedback`   — intent hits the form-regex (`feedback`),
 *                         emitter returns TextField + Button shell
 *   - `list-todos`      — intent hits the list-regex (`todos`),
 *                         emitter returns list shell
 *   - `minimal-greeting` — intent matches NEITHER regex, emitter
 *                          returns just heading + body skeleton
 *
 * The "minimal" case is the v0 stand-in for "legitimately produces
 * no preview or only a minimal one" — the deterministic emitter
 * always emits 4 frames (it isn't a no-preview path), but the
 * shell is empty, so the frames are structurally smaller. That
 * maps to the user's brief: "one case that may legitimately
 * produce no preview or only a minimal one."
 *
 * When a truly-no-preview path exists (e.g., a case that routes
 * through the gate's `mcp-apps-render` or `no-story` skip), add it
 * to the corpus with `emitterEnabled: false` and the runner will
 * wire the render WITHOUT provisional-preview deps.
 */

import type { A2uiIntentShape } from './types.js';

export interface A2uiCase {
  readonly id: string;
  readonly intentShape: A2uiIntentShape;
  /** Story intent passed to the emitter's heuristic. */
  readonly intent: string;
  /**
   * When false, the runner wires NO emitter — simulating the
   * gate-skipped path. v0 corpus keeps this true across the board
   * because the deterministic emitter always runs; the shape
   * dimension is what varies.
   */
  readonly emitterEnabled: boolean;
  /**
   * Whether the corpus expects at least one frame. For
   * `emitterEnabled: true` with the deterministic emitter, this
   * is always true (4 frames on happy path). Declared explicitly
   * on the case so future corpus additions (e.g., an aborting
   * emitter) can set it independently.
   */
  readonly previewExpected: boolean;
}

export const A2UI_V0_CASES: readonly A2uiCase[] = [
  {
    id: 'form-feedback',
    intentShape: 'form',
    intent: 'collect customer feedback',
    emitterEnabled: true,
    previewExpected: true,
  },
  {
    id: 'list-todos',
    intentShape: 'list',
    intent: 'show a list of todos for today',
    emitterEnabled: true,
    previewExpected: true,
  },
  {
    id: 'minimal-greeting',
    // Intent deliberately outside both regexes — lands in the
    // `minimal` branch where `pickShell` returns empty fragments.
    intentShape: 'minimal',
    intent: 'greet the visitor',
    emitterEnabled: true,
    previewExpected: true,
  },
];
