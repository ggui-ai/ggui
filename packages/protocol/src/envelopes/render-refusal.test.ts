/**
 * SPEC §7.1's refused arm as ONE primitive (ggui#803 leg 9): the tool
 * result a render gate answers with when a pre-generation check
 * refuses. Every server that projects a refusal — the shipping
 * `ggui_render` handler, the protocol reference server — builds it
 * here, so the four facts below have one source and the kit's
 * refusal-envelope catalog grades that source through each of them.
 */
import { describe, expect, it } from 'vitest';

import { projectRenderRefusal } from './render-refusal.js';
import type { PreGenerationRefusal } from '../schemas/mcp.js';

const refusal: PreGenerationRefusal = {
  code: 'insufficient_credit',
  message: 'the balance is 0 cents; a render needs at least 1',
  fix: 'add credit to the app and call again with the same handshakeId',
  retry: 'after-fix',
  handshake: 'intact',
  balanceCentsAtCheck: 0,
};

describe('projectRenderRefusal — SPEC §7.1 refused arm', () => {
  it('is an in-result error, never a throw: isError is true', () => {
    expect(projectRenderRefusal(refusal).isError).toBe(true);
  });

  it('leads the courtesy text with the code, then message and fix — the pinned `<code>: <message> <fix>`', () => {
    const result = projectRenderRefusal(refusal);
    expect(result.content).toEqual([
      {
        type: 'text',
        text: 'insufficient_credit: the balance is 0 cents; a render needs at least 1 add credit to the app and call again with the same handshakeId',
      },
    ]);
  });

  it('carries the refusal verbatim under outcome refused — the code on refusal.code is the mechanism', () => {
    expect(projectRenderRefusal(refusal).structuredContent).toEqual({
      outcome: 'refused',
      refusal,
    });
  });

  it('carries no _meta — nothing was read, no handshake consumed, nothing committed', () => {
    expect('_meta' in projectRenderRefusal(refusal)).toBe(false);
    expect(Object.keys(projectRenderRefusal(refusal)).sort()).toEqual([
      'content',
      'isError',
      'structuredContent',
    ]);
  });
});
