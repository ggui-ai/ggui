// ggui#1933 — the prompt taught `<Input onChange={(e) => setDraftText(e.target.value)} />`, while a design
// control's `onChange` hands over the value (`@ggui-ai/design` `Input`'s own docblock). tier-0 refuses the
// taught form (`Property 'target' does not exist on type 'string'`), so a model that follows the prompt
// spends a turn on it. The prompt now teaches `onChange={setDraftText}`; no prompt teaches `e.target`.
import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './system-prompt.js';
import { CONTEXT_SPEC_SECTION } from './hard-sections.js';

describe('the prompt binds a design control by its value (ggui#1933)', () => {
  it('the contextSpec section binds Input with the setter itself', () => {
    expect(CONTEXT_SPEC_SECTION).toContain('<Input value={draftText} onChange={setDraftText} />');
    expect(CONTEXT_SPEC_SECTION).not.toContain('e.target');
  });

  it.each([
    ['constrained', 'chat'],
    ['constrained', 'fullscreen'],
    ['free', 'chat'],
    ['free', 'fullscreen'],
  ] as const)('no %s / %s prompt teaches e.target', (designMode, shellType) => {
    expect(buildSystemPrompt({ userRequest: 'x', shellType, designMode })).not.toContain('e.target');
  });
});
