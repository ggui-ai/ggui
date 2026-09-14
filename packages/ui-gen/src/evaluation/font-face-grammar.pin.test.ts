/**
 * Pin (ggui#1093): ONE face grammar, two doors. The protocol's
 * `fontFaceDeclarationSchema` is the wire's door for `AppTheme.fonts`;
 * `@ggui-ai/design`'s `assertFontFace` is the renderer's guard on the same
 * declaration — design has no protocol dependency, so the grammar is
 * mirrored, not imported. A mirror without a pin drifts: this feeds the SAME
 * fixtures through both doors and requires the same verdict on each, so a
 * change to either one that the other does not follow fails here.
 *
 * It lives in `ui-gen` because that is the package which depends on both —
 * the judge paints an `AppTheme` through the design composer.
 */
import { describe, expect, it } from 'vitest';
import { fontFaceDeclarationSchema } from '@ggui-ai/protocol';
import { assertFontFace } from '@ggui-ai/design/themes';

interface Case {
  readonly what: string;
  readonly face: { family: string; src: string; weight?: string | number; style?: string; display?: string };
  readonly accepted: boolean;
}

const CASES: readonly Case[] = [
  { what: 'a minimal https face', face: { family: 'Neue Montreal', src: 'https://fonts.example.com/nm.woff2' }, accepted: true },
  { what: 'every optional field', face: { family: 'Inter', src: 'https://cdn.example.com/inter.woff2', weight: 700, style: 'italic', display: 'swap' }, accepted: true },
  { what: 'a numeric-string weight', face: { family: 'Inter', src: 'https://cdn.example.com/i.woff2', weight: '700' }, accepted: true },
  { what: 'http (not https)', face: { family: 'Inter', src: 'http://cdn.example.com/i.woff2' }, accepted: false },
  { what: 'a data: URL', face: { family: 'Inter', src: 'data:font/woff2;base64,AAA' }, accepted: false },
  { what: 'a relative path', face: { family: 'Inter', src: '/fonts/i.woff2' }, accepted: false },
  { what: 'a host with no dot', face: { family: 'Inter', src: 'https://localhost/i.woff2' }, accepted: false },
  { what: 'an empty family', face: { family: '', src: 'https://cdn.example.com/i.woff2' }, accepted: false },
  { what: 'a family with a newline', face: { family: 'In\nter', src: 'https://cdn.example.com/i.woff2' }, accepted: false },
];

describe('one face grammar, two doors (protocol schema ↔ design assertFontFace)', () => {
  it.each(CASES.map((c) => [c.what, c] as const))('%s — both doors agree', (_what, c) => {
    const wire = fontFaceDeclarationSchema.safeParse(c.face).success;
    let renderer = true;
    try {
      assertFontFace(c.face);
    } catch {
      renderer = false;
    }
    expect(wire).toBe(c.accepted);
    expect(renderer).toBe(c.accepted);
  });
});
