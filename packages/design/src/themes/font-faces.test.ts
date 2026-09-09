import { describe, it, expect } from 'vitest';
import { fontFaceRulesFor } from './font-faces';
import { lightTheme } from './defaults/light';

// ggui#987 §5 — the theme declares faces; the embedding host renders the rules and hands them to the card.
describe('fontFaceRulesFor', () => {
  it('renders one @font-face rule per declared face, https src only', () => {
    const css = fontFaceRulesFor({ ...lightTheme, typography: { faces: [
      { family: 'Inter', src: 'https://fonts.example.com/inter.woff2', weight: 400, style: 'normal', display: 'swap' },
      { family: 'Inter', src: 'https://fonts.example.com/inter-bold.woff2', weight: 700 },
    ] } });
    expect(css).toContain("@font-face { font-family: 'Inter'; src: url('https://fonts.example.com/inter.woff2') format('woff2'); font-weight: 400; font-style: normal; font-display: swap; }");
    expect(css).toContain("@font-face { font-family: 'Inter'; src: url('https://fonts.example.com/inter-bold.woff2') format('woff2'); font-weight: 700; }");
  });

  it('a document with no faces renders the empty string', () => {
    expect(fontFaceRulesFor(lightTheme)).toBe('');
  });

  it('refuses a non-https src or a malformed host (the document door names it)', () => {
    expect(() => fontFaceRulesFor({ ...lightTheme, typography: { faces: [{ family: 'X', src: 'http://x.example/x.woff2' }] } })).toThrow(/https/);
    expect(() => fontFaceRulesFor({ ...lightTheme, typography: { faces: [{ family: 'X', src: 'https://x/x.woff2' }] } })).toThrow(/host/);
  });

  it('escapes quotes in the family name and never emits a value that could close the rule', () => {
    const css = fontFaceRulesFor({ ...lightTheme, typography: { faces: [{ family: "Bad'Name}", src: 'https://x.example/a.woff2' }] } });
    expect(css).toContain("font-family: 'Bad\\'Name}'");
    expect(css.split('@font-face').length).toBe(2);
  });
});
