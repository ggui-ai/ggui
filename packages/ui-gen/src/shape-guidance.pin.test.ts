/**
 * Shape Guidance pin — the axis-conditioned prompt section (`compose()`
 * over `classifyAxes()`), digested PER FIXTURE so a fragment cut moves
 * exactly the cells it names. `design-mode.pin.test.ts` pins the STABLE
 * PREFIX without an `axisDelta`; this file pins the delta.
 *
 * Recorded with `GGUI_PIN_PRINT=1 pnpm --filter @ggui-ai/ui-gen exec vitest
 * run src/shape-guidance.pin.test.ts`. Fixture A (a todo list) is the
 * control — its digest must not move when a board fragment is cut;
 * fixture B (a kanban board) is the cell such a cut names.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { classifyAxes } from './classifier/index.js';
import { compose } from './compose.js';
import { PIN_FIXTURES } from './pin-fixtures.js';

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function shapeGuidance(i: number): { readonly vector: string; readonly text: string } {
  const f = PIN_FIXTURES[i]!;
  const classification = classifyAxes({ contract: f.contract, prompt: f.userRequest });
  return { vector: JSON.stringify(classification.vector), text: compose(classification).promptText };
}

// ── Recorded on the clean tree, 2026-09-11. Exp 004's board cut (dormant sha 39f2325e8, rule
// not met) moved fixture B alone (render=board, 7e6b370f…) and left fixture A byte-identical —
// the receipt this pin exists to give. ──
// Re-recorded 2026-09-12 for ggui#1046: the render=grid guidance names BOTH shapes (tile grid; board = the
// columns map wrapped in <Grid columns={{ base: 1, md: columns.length }}> of <Stack> columns) and drops the
// `display: grid` sentence that contradicted the prompt's NEVER rule — fixture B (render=grid) moves, fixture A stays.
export const SHAPE_GUIDANCE_SHA256: readonly string[] = [
  '15abd0fa3944eba787a286fb5cd39a78bef42c80559a4d234222becd5b3d3a80',
  'a3ac98059b5242994b3954764d0ad9a950bd860f87a41d58f7f94f0a0dbba1d5',
];
export const SHAPE_GUIDANCE_VECTOR: readonly string[] = [
  '{"render":"list","state":"ui-affordance","writes":"commit","writeTrigger":"click","realtime":"none","fetch":"none","layout":"single","tooling":"none"}',
  '{"render":"grid","state":"merge","writes":"none","writeTrigger":"click","realtime":"merge","fetch":"none","layout":"single","tooling":"none"}',
];

describe('Shape Guidance pin — one digest per fixture', () => {
  for (const [i, f] of PIN_FIXTURES.entries()) {
    it(`${f.userRequest}: vector + Shape Guidance digest match the recorded constants`, () => {
      const { vector, text } = shapeGuidance(i);
      const digest = sha256(text);
      if (process.env.GGUI_PIN_PRINT === '1') {
        console.log(`SHAPE_GUIDANCE[${i}] vector=${vector}`);
        console.log(`SHAPE_GUIDANCE[${i}] sha256=${digest}`);
      }
      expect(vector).toBe(SHAPE_GUIDANCE_VECTOR[i]);
      expect(digest).toBe(SHAPE_GUIDANCE_SHA256[i]);
    });
  }
});
