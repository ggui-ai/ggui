/**
 * Font-face transport, the theme's side (ggui#987 §5).
 *
 * A theme DECLARES faces (`typography.faces`); the embedding host admits
 * each face's origin its own way and hands the rendered `@font-face`
 * rules to the card as `hostContext.styles.css.fonts`, where the runtime
 * installs them under `<style id="ggui-host-fonts">`. This function
 * renders those rules from a document. It fetches nothing: `src` MUST be
 * `https:` with a well-formed host, and a face that fails to load in
 * the browser falls back down the family's stack.
 */
import type { DtcgTheme, FontFaceDeclaration } from './types';
import { ThemeDocumentInvalidError } from './derive-theme-variables';

function cssString(value: string): string {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]/g, ' ')}'`;
}

function formatFor(src: string): string {
  const ext = /\.([a-z0-9]+)(?:[?#].*)?$/i.exec(src)?.[1]?.toLowerCase();
  switch (ext) {
    case 'woff2':
      return 'woff2';
    case 'woff':
      return 'woff';
    case 'ttf':
      return 'truetype';
    case 'otf':
      return 'opentype';
    default:
      return 'woff2';
  }
}

/** Validate one declared face; the reason names the field a document door reports. */
export function assertFontFace(face: FontFaceDeclaration): void {
  let url: URL;
  try {
    url = new URL(face.src);
  } catch {
    throw new ThemeDocumentInvalidError([`typography.faces: src ${JSON.stringify(face.src)} is not a URL`]);
  }
  if (url.protocol !== 'https:') throw new ThemeDocumentInvalidError([`typography.faces: src must be https: (${face.family})`]);
  if (!/^[a-z0-9.-]+$/i.test(url.hostname) || !url.hostname.includes('.')) {
    throw new ThemeDocumentInvalidError([`typography.faces: src has no well-formed host (${face.family})`]);
  }
  if (!face.family || /[\r\n]/.test(face.family)) throw new ThemeDocumentInvalidError([`typography.faces: family is required`]);
}

/**
 * The `@font-face` rules for every face a document declares — one rule
 * per face, in declaration order; the empty string when none.
 */
export function fontFaceRulesFor(doc: DtcgTheme): string {
  return fontFaceRules(doc.typography?.faces ?? []);
}

/**
 * The `@font-face` rules for a list of declarations — the same text
 * `fontFaceRulesFor` emits for a document's `typography.faces`, for a
 * caller that holds the declarations rather than the document (a
 * server composing the served shell). Every face is asserted first.
 */
export function fontFaceRules(faces: ReadonlyArray<FontFaceDeclaration>): string {
  return faces
    .map((face) => {
      assertFontFace(face);
      const parts = [`font-family: ${cssString(face.family)}`, `src: url(${cssString(face.src)}) format('${formatFor(face.src)}')`];
      if (face.weight !== undefined) parts.push(`font-weight: ${String(face.weight).replace(/[^0-9a-z ]/gi, '')}`);
      if (face.style !== undefined) parts.push(`font-style: ${face.style.replace(/[^a-z-]/gi, '')}`);
      if (face.display !== undefined) parts.push(`font-display: ${face.display.replace(/[^a-z-]/gi, '')}`);
      return `@font-face { ${parts.join('; ')}; }`;
    })
    .join('\n');
}
