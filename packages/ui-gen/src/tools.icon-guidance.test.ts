/**
 * ggui#1183 — the icon list is complete and constant, and the model is told so ONCE, in one definition, on the
 * tool's description and on every result: a name that is not there is answered by the nearest listed name, never by
 * a second call (three identical calls end the run — `SAME_EXCHANGE_BREAK_AT`).
 */
import { describe, expect, it } from 'vitest';
import { GET_ICONS_TOOL, ICON_LIST_NO_MATCH_GUIDANCE } from './tools.js';

describe('get_available_icons — the no-match guidance (ggui#1183)', () => {
  it('the tool description ends with the one definition, and the definition says the list is constant and forbids a second call', () => {
    expect(GET_ICONS_TOOL.description.endsWith(ICON_LIST_NO_MATCH_GUIDANCE)).toBe(true);
    expect(ICON_LIST_NO_MATCH_GUIDANCE).toContain('complete and constant');
    expect(ICON_LIST_NO_MATCH_GUIDANCE).toContain('nearest listed name');
    expect(ICON_LIST_NO_MATCH_GUIDANCE).toContain('never call this tool twice');
  });
});
