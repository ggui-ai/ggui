/**
 * The finish probe: one read of the rendered card's DOM, taken beside the edge probe just before the screenshot, that
 * the finish instruments (`finish.ts`) turn into verdicts. It reads declared, computed values (colours, opacity,
 * blending, boxes, font sizes), never pixels, so what it reports is exactly what the page asked the browser to paint.
 *
 * Frozen by version: a change to what this expression reads is a NEW probe with a new version id, never a silent
 * rewrite of a measured one (the edge probe's discipline, `edge-probe.ts` v1 / `edge-probe-v2.ts`).
 *
 * What it refuses to guess: a text whose effective background cannot be composited from flat colours (a background
 * image or gradient anywhere up the chain, an element opacity below 1, a blend mode, or another element painted over
 * the text's centre) is reported with `composite: false`, and the contrast instrument reads it as not evaluated —
 * never as a number. The overlap is checked only for a run whose centre is inside the viewport (`elementFromPoint`
 * answers nothing outside it).
 *
 * Colours: a computed colour may serialize in any CSS colour syntax (`oklch(…)`, `color(srgb …)`, a resolved
 * `color-mix(…)`), so every colour is read through a 1×1 canvas into 8-bit sRGB; plain `rgb()` / `rgba()` are read
 * directly. A canvas stores premultiplied alpha, so a TRANSLUCENT colour read that way comes back with its channels
 * rounded by one or two steps (more at low alpha): a one-step difference on such a colour is not a real one. A band
 * whose background colour is translucent is not flat. Paints outside the band (fills and borders)
 * are composited over white, not over the surface behind them.
 */

/** This probe's frozen identity, carried on every verdict it answers. */
export const FINISH_PROBE_VERSION = 'finish-probe-v1';

/** An sRGB colour with alpha in [0, 1], as the browser computed it. */
export type Rgba = readonly [number, number, number, number];

export interface FinishText {
  /** The element's tag, lower-case, for evidence. */
  readonly tag: string;
  /** The text's first characters, for evidence. */
  readonly sample: string;
  readonly color: Rgba;
  /** The backgrounds from the element up to the first opaque one, nearest first; composited over white when none is opaque. */
  readonly backgrounds: readonly Rgba[];
  /** False when the background cannot be composited from flat colours (see the module docblock). */
  readonly composite: boolean;
  /** Computed font size in px. */
  readonly fontSize: number;
  /** Computed font weight (100–900). */
  readonly fontWeight: number;
  /** A heading: h1–h6 or role="heading". */
  readonly heading: boolean;
  /** Inside a control (a button or role="button"). */
  readonly control: boolean;
  /** Rendered line count: the content height (the box less its vertical padding and borders) over the computed line height. */
  readonly lines: number;
}

/** A painted colour and how much of the card it covers in px² (a fill: its box; a border: its length × width). */
export interface FinishPaint {
  readonly kind: 'fill' | 'border';
  readonly color: Rgba;
  readonly area: number;
  /** Painted inside the hero band (the band itself included). */
  readonly inHero: boolean;
  /** A fill painted by a control itself (a button or role="button"). */
  readonly control: boolean;
  /** For a control's fill: the backgrounds behind it, nearest first up to the first opaque one (as `FinishText.backgrounds`); empty otherwise. */
  readonly behind: readonly Rgba[];
}

export interface FinishBox {
  readonly width: number;
  readonly height: number;
}

export interface FinishProbe {
  readonly version: typeof FINISH_PROBE_VERSION;
  readonly card: FinishBox;
  /** The first hero surface under the card (`[data-ggui-surface="hero"]`), when there is one. */
  readonly hero: (FinishBox & { readonly background: Rgba | null; readonly flat: boolean; readonly firstChild: boolean }) | null;
  /** The card's resolved `--ggui-color-heroGround` (var() chains followed on the card), or `null` when it cannot be resolved to a colour. */
  readonly heroGround: Rgba | null;
  readonly texts: readonly FinishText[];
  /** Every chromatic paint on the card: fills and visible borders (text colours are on `texts`). */
  readonly paints: readonly FinishPaint[];
}

/**
 * The expression the capture evaluates in the page. Plain page JavaScript (no template literals: it is shipped as a
 * string), reading only under `#root`, writing nothing. Bounded: at most 400 elements are visited.
 */
export const FINISH_PROBE_EXPRESSION = String.raw`(() => {
  const root = document.getElementById('root');
  if (!root) return null;
  const card = root.firstElementChild;
  if (!card) return null;
  const pixel = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const viaCanvas = (c) => {
    if (!pixel || String(c).trim().length === 0) return null;
    pixel.clearRect(0, 0, 1, 1);
    pixel.fillStyle = '#010203';
    pixel.fillStyle = c;
    if (pixel.fillStyle === '#010203' && String(c).trim().toLowerCase() !== '#010203') return null;
    pixel.fillRect(0, 0, 1, 1);
    const d = pixel.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], Math.round((d[3] / 255) * 1000) / 1000];
  };
  const rgba = (c) => {
    const m = /^rgba?\(([^)]+)\)$/.exec(String(c).trim());
    if (!m) return viaCanvas(c);
    const p = m[1].split(/[\s,\/]+/).filter((x) => x.length > 0).map((x) => (x.endsWith('%') ? Number(x.slice(0, -1)) / 100 : Number(x)));
    if (p.length < 3 || p.some((x) => !Number.isFinite(x))) return null;
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  };
  const hex = (c) => {
    const m = /^#([0-9a-f]{3,8})$/i.exec(String(c).trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = h.split('').map((x) => x + x).join('');
    if (h.length !== 6 && h.length !== 8) return null;
    const n = (i) => parseInt(h.slice(i, i + 2), 16);
    return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
  };
  const resolveVar = (name) => {
    let v = getComputedStyle(card).getPropertyValue(name).trim();
    for (let depth = 0; depth < 6; depth++) {
      const m = /^var\(\s*(--[A-Za-z0-9-]+)\s*(?:,\s*(.+))?\)$/.exec(v);
      if (!m) break;
      const next = getComputedStyle(card).getPropertyValue(m[1]).trim();
      v = next.length > 0 ? next : (m[2] || '').trim();
    }
    return hex(v) || rgba(v);
  };
  const chain = (start) => {
    const backgrounds = [];
    let composite = true;
    for (let a = start; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.backgroundImage !== 'none' || parseFloat(as.opacity) < 1 || as.mixBlendMode !== 'normal') composite = false;
      const ab = rgba(as.backgroundColor);
      if (ab === null) { composite = false; break; }
      if (ab[3] > 0) backgrounds.push(ab);
      if (ab[3] >= 1) break;
    }
    return { backgrounds, composite };
  };
  const box = (el) => { const r = el.getBoundingClientRect(); return { width: r.width, height: r.height }; };
  const cardBox = box(card);
  const texts = [];
  const paints = [];
  const visited = [];
  const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT);
  let node = card;
  while (node && visited.length < 400) { visited.push(node); node = walker.nextNode(); }
  for (const el of visited) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility !== 'visible') continue;
    const r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) continue;
    const bg = rgba(cs.backgroundColor);
    const inHero = el.closest('[data-ggui-surface="hero"]') !== null;
    if (bg && bg[3] > 0 && el !== card) {
      const control = el.matches('button, [role="button"]');
      paints.push({ kind: 'fill', color: bg, area: r.width * r.height, inHero, control, behind: control ? chain(el.parentElement).backgrounds : [] });
    }
    for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
      const bw = parseFloat(cs['border' + side + 'Width']);
      if (bw > 0 && cs['border' + side + 'Style'] !== 'none') {
        const bc = rgba(cs['border' + side + 'Color']);
        if (bc && bc[3] > 0) paints.push({ kind: 'border', color: bc, area: bw * (side === 'Top' || side === 'Bottom' ? r.width : r.height), inHero, control: false, behind: [] });
      }
    }
    let own = '';
    for (const child of el.childNodes) if (child.nodeType === 3) own += child.textContent;
    own = own.trim();
    if (own.length === 0) continue;
    const color = rgba(cs.color);
    if (!color) continue;
    const under = chain(el);
    const backgrounds = under.backgrounds;
    let composite = under.composite;
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit) && !hit.contains(el)) composite = false;
    const lh = parseFloat(cs.lineHeight);
    const fontSize = parseFloat(cs.fontSize);
    const lineHeight = Number.isFinite(lh) && lh > 0 ? lh : fontSize * 1.2;
    const edges = ['paddingTop', 'paddingBottom', 'borderTopWidth', 'borderBottomWidth'].reduce((sum, k) => sum + (parseFloat(cs[k]) || 0), 0);
    const tag = el.tagName.toLowerCase();
    texts.push({
      tag,
      sample: own.slice(0, 40),
      color,
      backgrounds,
      composite,
      fontSize,
      fontWeight: Number(cs.fontWeight) || 400,
      heading: /^h[1-6]$/.test(tag) || el.getAttribute('role') === 'heading',
      control: el.closest('button, [role="button"]') !== null,
      lines: Math.max(1, Math.round((r.height - edges) / lineHeight)),
    });
  }
  const heroEl = card.querySelector('[data-ggui-surface="hero"]') || (card.getAttribute('data-ggui-surface') === 'hero' ? card : null);
  let hero = null;
  if (heroEl) {
    const hs = getComputedStyle(heroEl);
    const hb = box(heroEl);
    const hbg = rgba(hs.backgroundColor);
    hero = {
      width: hb.width,
      height: hb.height,
      background: hbg,
      flat: hs.backgroundImage === 'none' && parseFloat(hs.opacity) >= 1 && hs.mixBlendMode === 'normal' && hbg !== null && hbg[3] >= 1,
      firstChild: heroEl.parentElement === card && card.firstElementChild === heroEl,
    };
  }
  return { version: 'finish-probe-v1', card: cardBox, hero, heroGround: resolveVar('--ggui-color-heroGround'), texts, paints };
})()`;

const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);

function parseRgba(x: unknown): Rgba | null {
  if (!Array.isArray(x) || x.length !== 4 || !x.every(isNum)) return null;
  return [x[0], x[1], x[2], x[3]];
}

function parseBox(x: unknown): FinishBox | null {
  if (typeof x !== 'object' || x === null) return null;
  const w = (x as { width?: unknown }).width;
  const h = (x as { height?: unknown }).height;
  return isNum(w) && isNum(h) ? { width: w, height: h } : null;
}

function parseText(x: unknown): FinishText | null {
  if (typeof x !== 'object' || x === null) return null;
  const t = x as Record<string, unknown>;
  const color = parseRgba(t['color']);
  const backgrounds = Array.isArray(t['backgrounds']) ? t['backgrounds'].map(parseRgba) : null;
  if (
    color === null ||
    backgrounds === null ||
    backgrounds.some((b) => b === null) ||
    typeof t['tag'] !== 'string' ||
    typeof t['sample'] !== 'string' ||
    typeof t['composite'] !== 'boolean' ||
    typeof t['heading'] !== 'boolean' ||
    typeof t['control'] !== 'boolean' ||
    !isNum(t['fontSize']) ||
    !isNum(t['fontWeight']) ||
    !isNum(t['lines'])
  ) {
    return null;
  }
  return {
    tag: t['tag'],
    sample: t['sample'],
    color,
    backgrounds: backgrounds.filter((b): b is Rgba => b !== null),
    composite: t['composite'],
    fontSize: t['fontSize'],
    fontWeight: t['fontWeight'],
    heading: t['heading'],
    control: t['control'],
    lines: t['lines'],
  };
}

/**
 * The probe's typed read. Anything that is not the shape above is `null`: a failed measurement, never an empty one —
 * so a probe that broke can never read as "no text failed".
 */
export function parseFinishProbe(value: unknown): FinishProbe | null {
  if (typeof value !== 'object' || value === null) return null;
  const v = value as Record<string, unknown>;
  if (v['version'] !== FINISH_PROBE_VERSION) return null;
  const card = parseBox(v['card']);
  if (card === null || !Array.isArray(v['texts']) || !Array.isArray(v['paints'])) return null;
  const texts = v['texts'].map(parseText);
  if (texts.some((t) => t === null)) return null;
  const paints: FinishPaint[] = [];
  for (const p of v['paints']) {
    if (typeof p !== 'object' || p === null) return null;
    const q = p as Record<string, unknown>;
    const kind = q['kind'];
    const color = parseRgba(q['color']);
    const area = q['area'];
    const inHero = q['inHero'];
    const control = q['control'];
    const behind = Array.isArray(q['behind']) ? q['behind'].map(parseRgba) : null;
    if ((kind !== 'fill' && kind !== 'border') || color === null || !isNum(area) || typeof inHero !== 'boolean' || typeof control !== 'boolean') return null;
    if (behind === null || behind.some((b) => b === null)) return null;
    paints.push({ kind, color, area, inHero, control, behind: behind.filter((b): b is Rgba => b !== null) });
  }
  const heroGround = v['heroGround'] === null || v['heroGround'] === undefined ? null : parseRgba(v['heroGround']);
  if (v['heroGround'] !== null && v['heroGround'] !== undefined && heroGround === null) return null;
  let hero: FinishProbe['hero'] = null;
  if (v['hero'] !== null && v['hero'] !== undefined) {
    const h = v['hero'] as Record<string, unknown>;
    const hb = parseBox(h);
    const bg = h['background'] === null ? null : parseRgba(h['background']);
    if (hb === null || (h['background'] !== null && bg === null) || typeof h['flat'] !== 'boolean' || typeof h['firstChild'] !== 'boolean') return null;
    hero = { ...hb, background: bg, flat: h['flat'], firstChild: h['firstChild'] };
  }
  return { version: FINISH_PROBE_VERSION, card, hero, heroGround, texts: texts.filter((t): t is FinishText => t !== null), paints };
}
