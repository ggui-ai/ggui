/**
 * SPEC §7.1's REFUSED arm as one primitive (ggui#803 leg 9).
 *
 * A render gate that refuses before generation answers with a tool
 * RESULT — never a throw, never a JSON-RPC error — carrying four facts:
 *
 *   1. `isError: true` — the call did not render.
 *   2. `content[0].text` = `<code>: <message> <fix>` — a courtesy line
 *      for the model; the code LEADS so the state is visible without
 *      parsing, but `structuredContent.refusal.code` is the mechanism.
 *   3. `structuredContent` = `{ outcome: 'refused', refusal }` — the
 *      refusal verbatim, the whole payload being
 *      {@link refusedOutputSchema}.
 *   4. No `_meta` — nothing was read, no handshake consumed, nothing
 *      committed, so there is no identity to carry.
 *
 * Parties: every server that projects a pre-generation refusal — the
 * shipping `ggui_render` handler and the protocol reference server
 * both build the result HERE, so the facts have one source. Failure
 * mode: a projection that drifts from these facts fails the
 * conformance kit's `refusal-envelope` catalog; the violation is
 * observed by the handler's and the reference server's conformance
 * suites, which grade this function through each of them.
 *
 * The text deliberately shares nothing with a FAILED render's text:
 * that one says the handshakeId "is consumed", which is false for a
 * refusal — the same id is valid on a retry. The two texts are
 * contradictory by construction and must never be one builder.
 */
import type { z } from 'zod';

import type { PreGenerationRefusal, refusedOutputSchema } from '../schemas/mcp.js';

/** The refused arm's `structuredContent` — derived from the schema, never restated. */
export type RefusedRenderOutput = z.infer<typeof refusedOutputSchema>;

/** The tool result a render gate answers a pre-generation refusal with. */
export interface RenderRefusalResult {
  readonly isError: true;
  readonly content: readonly [{ readonly type: 'text'; readonly text: string }];
  readonly structuredContent: RefusedRenderOutput;
}

/**
 * Project a {@link PreGenerationRefusal} onto the §7.1 refused tool
 * result. Pure and synchronous: the deterministic projection is the
 * whole obligation.
 */
export function projectRenderRefusal(refusal: PreGenerationRefusal): RenderRefusalResult {
  return {
    isError: true,
    content: [{ type: 'text', text: `${refusal.code}: ${refusal.message} ${refusal.fix}` }],
    structuredContent: { outcome: 'refused', refusal },
  };
}
