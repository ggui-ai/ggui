/**
 * Sample `--projector` module: SPEC §7.1's refused arm, built from
 * `@ggui-ai/protocol` primitives only. `project(refusal)` returns the
 * kit's `ProjectedRefusalResult` for a code on the render-gate surface
 * and `null` for one that is not — that code has no render envelope to
 * project. Passes the refusal-envelope catalog (cli.test.ts pins it).
 */
import { RENDER_GATE_REFUSAL_CODES } from '@ggui-ai/protocol';

export function project(refusal) {
  if (!RENDER_GATE_REFUSAL_CODES.includes(refusal.code)) return null;
  return {
    isError: true,
    // The code LEADS as a courtesy; `refusal.code` is the mechanism.
    text: `${refusal.code}: ${refusal.message} ${refusal.fix}`,
    structuredContent: { outcome: 'refused', refusal },
    hasMeta: false,
    // Nothing read, no handshake consumed, nothing committed.
    identityFields: [],
  };
}
