import { describe, expect, it } from 'vitest';
import { appThemeSchema, isKeyframesText } from './app-theme';

// ggui#987 follower D — `keyframes.{light,dark}` is bounded to what the
// slot is FOR: `@keyframes <ident> { … }` blocks and nothing else. Found by
// oss's adversarial review of the card half: values were injection-restricted,
// the keyframes string was not, and both land in the same <style>.
const SPIN = '@keyframes spin { from { transform: rotate(0deg) } to { transform: rotate(360deg) } }';
const PULSE = '@keyframes accent-pulse{0%{opacity:1}50%{opacity:0.7}100%{opacity:1}}';

const V2 = {
  overlayHash: 'a'.repeat(64),
  overlays: { light: { '--ggui-color-primary-500': '#3355ff' }, dark: { '--ggui-color-primary-500': '#99aaff' } },
} as const;

describe('isKeyframesText (ggui#987 D)', () => {
  it('accepts one block, many blocks, frame selectors of every kind, comments, whitespace and url()', () => {
    expect(isKeyframesText(SPIN)).toBe(true);
    expect(isKeyframesText(PULSE)).toBe(true);
    expect(isKeyframesText(`${SPIN}\n\n${PULSE}\n`)).toBe(true);
    expect(isKeyframesText('@keyframes fade { 0%, 100% { opacity: 1; } 50% { opacity: .4; } }')).toBe(true);
    expect(isKeyframesText('/* entrance */ @keyframes _in-2 { from { opacity: 0 } }')).toBe(true);
    expect(isKeyframesText('@keyframes bg { to { background-image: url(https://cdn.example/x.png) } }')).toBe(true);
    expect(isKeyframesText('')).toBe(true);
    expect(isKeyframesText('   \n ')).toBe(true);
  });

  it('refuses anything that is not a @keyframes block', () => {
    expect(isKeyframesText('body { display: none }')).toBe(false);
    expect(isKeyframesText(`${SPIN} body { display: none }`)).toBe(false);
    expect(isKeyframesText('@import url(https://evil.example/x.css);')).toBe(false);
    expect(isKeyframesText('@media (prefers-color-scheme: dark) { body { color: red } }')).toBe(false);
    expect(isKeyframesText('@font-face { font-family: x; src: url(https://evil.example/x.woff2) }')).toBe(false);
    expect(isKeyframesText('@-webkit-keyframes spin { to { transform: rotate(360deg) } }')).toBe(false);
  });

  it('refuses at-rules nested inside a block, <>, unbalanced or over-nested braces, and a missing name', () => {
    expect(isKeyframesText('@keyframes x { to { @import url(a) } }')).toBe(false);
    expect(isKeyframesText('@keyframes x { to { color: red } } </style><script>1</script>')).toBe(false);
    expect(isKeyframesText('@keyframes x { to { color: red }')).toBe(false);
    expect(isKeyframesText('@keyframes x { to { color: red } } }')).toBe(false);
    expect(isKeyframesText('@keyframes x { to { a { b: c } } }')).toBe(false);
    expect(isKeyframesText('@keyframes { to { color: red } }')).toBe(false);
    expect(isKeyframesText('@keyframes 9x { to { color: red } }')).toBe(false);
    expect(isKeyframesText('@keyframesspin { to { color: red } }')).toBe(false);
  });
});

describe('appThemeSchema.keyframes (ggui#987 D)', () => {
  it('accepts @keyframes text per mode and refuses other CSS, naming the mode', () => {
    expect(appThemeSchema.safeParse({ ...V2, keyframes: { light: SPIN, dark: PULSE } }).success).toBe(true);
    const r = appThemeSchema.safeParse({ ...V2, keyframes: { light: SPIN, dark: 'body{display:none}' } });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['keyframes', 'dark']);
  });

  it('keeps the 8192-char cap', () => {
    const long = `@keyframes x { to { --pad: ${'a'.repeat(8192)} } }`;
    expect(appThemeSchema.safeParse({ ...V2, keyframes: { light: long } }).success).toBe(false);
  });
});
