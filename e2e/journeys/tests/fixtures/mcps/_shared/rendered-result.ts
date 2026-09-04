/**
 * ONE narrowing seam for live `ggui_render` results across the
 * journeys mount-integration fixtures (ggui#786).
 *
 * The three `mount-integration.test.ts` files (tasks / contacts /
 * notes) each carried their own `as { sessionId: string; action:
 * string }` cast on the render result. A cast asserts a shape without
 * checking it, so all three would have read `undefined` off a refusal
 * — whose structuredContent carries neither field — and reported it as
 * a falsy `sessionId` rather than the refusal it was.
 *
 * This is an ASSERTION function rather than a parse-and-return on
 * purpose. `renderOutputSchema` is a `z.object`, so parsing STRIPS
 * unknown keys; returning the parsed value would silently make the
 * companion `expect(Object.keys(structured)).not.toContain('url')`
 * assertion vacuous — it would pass even if the server did put a dead
 * `url` back on the wire. Asserting instead narrows the ORIGINAL
 * object, so that key check keeps grading the real payload.
 */
import {
  isFailedRenderOutput,
  isRefusedRenderOutput,
  isRenderedOutput,
  renderOutputSchema,
  type GguiRenderOutput,
} from '@ggui-ai/protocol';

/**
 * A committed, mountable render. Derived from {@link GguiRenderOutput}
 * — the six identity fields are non-optional on this arm, which is
 * what `isRenderedOutput` proves.
 */
export type RenderedResult = GguiRenderOutput & {
  outcome: 'rendered';
  sessionId: string;
  action: string;
};

/**
 * Assert a `ggui_render` result is the RENDERED arm, or throw naming
 * why it was not. The three throws are distinct: a scenario that fails
 * because the deployment refused should say so with the registry code
 * and the recovery step, not report a falsy `sessionId`.
 */
export function assertRenderedResult(
  structured: unknown,
): asserts structured is RenderedResult {
  const parsed = renderOutputSchema.safeParse(structured);
  if (!parsed.success) {
    throw new Error(
      `ggui_render output is not conformant to renderOutputSchema: ${JSON.stringify(structured).slice(0, 400)}`,
    );
  }
  const out = parsed.data;

  // Declined BEFORE any work: nothing committed, handshake intact.
  if (isRefusedRenderOutput(out)) {
    throw new Error(
      `ggui_render REFUSED (${out.refusal.code}): ${out.refusal.message} ` +
        `Fix: ${out.refusal.fix} [retry=${out.refusal.retry}; handshake intact]`,
    );
  }
  // Generation RAN and produced nothing. The handshake is consumed.
  if (isFailedRenderOutput(out)) {
    throw new Error(
      `ggui_render FAILED (${out.error.code}): ${out.error.message}`,
    );
  }
  if (!isRenderedOutput(out)) {
    throw new Error(`ggui_render returned unknown outcome "${out.outcome}"`);
  }
}
