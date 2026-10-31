/**
 * `space.edge.v3`'s measurement (#1765, pre-registered on the row before any v3 value was read): `edge-probe-v2.ts`
 * (frozen, `space.edge.v2@5525a3d2c9ec`) with ONE change and its evidence. What paints is read by three doors, each
 * composited over the box's ground and measured two ways (WCAG luminance contrast, ΔE*ab CIE76); a door opens when either
 * clears its floor: a border side ≥ 1 px at ≥ 1.3:1 or ΔE ≥ 12; a fill at ≥ 1.06:1 or ΔE ≥ 3; a non-inset shadow layer's
 * colour at its own alpha (the peak; blur not modelled, its geometry reported) at ≥ 1.06:1 or ΔE ≥ 3. That one `paints()` replaces v2's
 * `bounded` (controls) and its surface test (any border side, any non-ground fill, any shadow). Evidence: every surface
 * and control set names the door that opened and its number (`paint`), a box v2 counted that paints nothing under v3 is
 * listed with its best door (`unpainted`), and every block names what its edges are (`edgeIs`, `textEdgeIs`). Everything
 * else is v2's, word for word. v2's own header, kept:
 *
 * `space.edge.v2`'s measurement (#1765): `edge-probe.ts` (v1, frozen at `cec465319`) with what the v2 rule
 * (`edge-v2.ts`) reads added, and nothing v1 measures changed. It runs where the screenshot is taken, on the same DOM at
 * the same width, and only reads layout.
 *
 * Added to every block: `bottom`. Added to surfaces: their content box (`contentLeft` / `contentRight`, inside border
 * and padding). Added to controls: `textEdge`, the first control's first character, so a control is compared by its
 * content (rule 5). Added blocks: `media`, a painted image, video or icon that is not a text's marker and sits in no
 * text, control or table, so a row led by an icon alone has a leader. Added to blocks in rows: `follows` and `item`, when
 * the block sits in an item of a horizontal flex or grid row that is not the row's leading item on its line (rule 2).
 * Added to the read: the card's own content box. Everything else is v1's, word for word.
 */
import type { CardContentBox } from './edge-v2.js';
import type { EdgeBlockV3, UnpaintedBox } from './edge-v3.js';

/** What the probe returns: the measured blocks, and whether the frame showed nothing to evaluate. */
export interface EdgeProbeV3 {
  readonly blocks: readonly EdgeBlockV3[];
  /** Boxes v2 counted as painting (a border side, a non-ground fill or a shadow) that open no v3 door. */
  readonly unpainted: readonly UnpaintedBox[];
  readonly cardContent: CardContentBox;
  readonly placeholdersOnly: boolean;
  /** What the probe saw and did not measure, by rule, so a dropped block is counted rather than silent. */
  readonly skipped: { readonly rowItems: number; readonly ornaments: number };
}

// Plain ES2020 for the page: no imports, no template literals, no helpers a bundler might rename.
export const EDGE_BLOCKS_V3_EXPRESSION = String.raw`(() => {
  const root = document.getElementById('root');
  if (!root) return null;
  const rootBox = root.getBoundingClientRect();
  const x0 = rootBox.left;
  const px = (v) => Math.round((v - x0) * 2) / 2;
  const CONTROL = 'button,input,select,textarea,[role="button"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],[role="option"],[role="link"],a[href]';
  const ALNUM = /[\p{L}\p{N}]/u;
  const css = (el) => getComputedStyle(el);
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  // Visible through every ancestor (an ancestor at opacity 0 or visibility hidden hides it), and not degenerate.
  const shown = (el) => {
    const s = css(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const inline = (s) => /^inline/.test(s.display) && s.display !== 'inline-block' && s.display !== 'inline-flex' && s.display !== 'inline-grid';
  const groundOf = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) { const b = css(p).backgroundColor; if (!clear(b)) return b; }
    return 'rgb(255, 255, 255)';
  };
  const sides = (s) => ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s['border' + k + 'Width']) > 0 && s['border' + k + 'Style'] !== 'none' && !clear(s['border' + k + 'Color'])).length;
  // v3: what paints, by three doors. A colour is composited over the box's ground (itself over white) on a 1×1 canvas,
  // so every CSS colour syntax the engine resolves is read the same way; an unreadable colour opens no door.
  const cv = document.createElement('canvas'); cv.width = 1; cv.height = 1;
  const cx = cv.getContext('2d', { willReadFrequently: true });
  const parses = (c) => { cx.fillStyle = '#010203'; cx.fillStyle = c; const a = cx.fillStyle; cx.fillStyle = '#030201'; cx.fillStyle = c; return !(a === '#010203' && cx.fillStyle === '#030201'); };
  // The ground, opaque: every ancestor background from the outermost down, over the probe's white fallback.
  const groundChain = (el) => { const out = []; for (let p = el.parentElement; p; p = p.parentElement) { const b = css(p).backgroundColor; if (!clear(b) && parses(b)) out.unshift(b); } return out; };
  const over = (top, chain) => { cx.clearRect(0, 0, 1, 1); cx.fillStyle = '#ffffff'; cx.fillRect(0, 0, 1, 1); for (const g of chain) { cx.fillStyle = g; cx.fillRect(0, 0, 1, 1); } if (top !== null) { cx.fillStyle = top; cx.fillRect(0, 0, 1, 1); } const d = cx.getImageData(0, 0, 1, 1).data; return [d[0], d[1], d[2]]; };
  const lin = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
  const ratioOf = (a, b) => { const x = lum(a); const y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  const lab = (c) => { const r = lin(c[0]); const g = lin(c[1]); const b = lin(c[2]); const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116); const X = f((0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047); const Y = f(0.2126 * r + 0.7152 * g + 0.0722 * b); const Z = f((0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883); return [116 * Y - 16, 500 * (X - Y), 200 * (Y - Z)]; };
  const deOf = (a, b) => { const p = lab(a); const q = lab(b); return Math.sqrt(Math.pow(p[0] - q[0], 2) + Math.pow(p[1] - q[1], 2) + Math.pow(p[2] - q[2], 2)); };
  const FLOORS = { border: { ratio: 1.3, de: 12 }, fill: { ratio: 1.06, de: 3 }, shadow: { ratio: 1.06, de: 3 } };
  const measure = (door, colour, chain) => { if (!parses(colour)) return null; const g = over(null, chain); const c = over(colour, chain); const ratio = ratioOf(c, g); const de = deOf(c, g); const f = FLOORS[door]; return { door, ratio, de, byRatio: ratio >= f.ratio, byDe: de >= f.de, opens: ratio >= f.ratio || de >= f.de, score: Math.max(ratio / f.ratio, de / f.de) }; };
  // A box-shadow's layers: split on commas outside parentheses; the engine writes each layer's colour first.
  const shadowLayers = (v) => { if (!v || v === 'none') return []; const out = []; let depth = 0; let cur = ''; for (const ch of v) { if (ch === '(') depth += 1; if (ch === ')') depth -= 1; if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch; } if (cur.trim()) out.push(cur.trim()); return out; };
  const shadowColour = (layer) => { if (/\binset\b/.test(layer)) return null; const m = /^([a-z-]+\([^)]*\)|#[0-9a-f]{3,8}|[a-z]+)/i.exec(layer); if (!m) return null; const geo = layer.slice(m[0].length).match(/-?[\d.]+px/g) || []; return geo.some((g) => parseFloat(g) !== 0) ? { colour: m[0], geo: geo.join(' ') } : null; };
  const doors = (el) => {
    const s = css(el);
    const ground = groundChain(el);
    const reads = [];
    for (const k of ['Top', 'Right', 'Bottom', 'Left']) if (parseFloat(s['border' + k + 'Width']) >= 1 && s['border' + k + 'Style'] !== 'none' && s['border' + k + 'Style'] !== 'hidden' && !clear(s['border' + k + 'Color'])) reads.push(measure('border', s['border' + k + 'Color'], ground));
    if (!clear(s.backgroundColor)) reads.push(measure('fill', s.backgroundColor, ground));
    for (const layer of shadowLayers(s.boxShadow)) { const c = shadowColour(layer); if (c !== null && !clear(c.colour)) { const r = measure('shadow', c.colour, ground); if (r !== null) reads.push({ ...r, geo: c.geo }); } }
    return reads.filter((r) => r !== null);
  };
  // A shadow reading carries its layer's geometry (x y blur spread, as the engine writes it): its numbers are the peak, and
  // the geometry is what lets a reader judge that peak against the rendered pixel.
  const fmt = (r) => r.door + ' ' + (Math.round(r.ratio * 100) / 100).toFixed(2) + ':1 / ΔE ' + (Math.round(r.de * 10) / 10).toFixed(1) + (r.geo ? ' (peak; ' + r.geo + ')' : '');
  // Each door once, at its strongest reading (a border's best side, a shadow's best layer), with both measures.
  const perDoor = (reads) => ['border', 'fill', 'shadow'].map((d) => reads.filter((r) => r.door === d)).filter((rs) => rs.length).map((rs) => rs.reduce((a, b) => (b.score > a.score ? b : a)));
  const paintOf = (el) => {
    const reads = perDoor(doors(el));
    const all = reads.map(fmt).join('; ');
    const open = reads.filter((r) => r.opens);
    if (open.length) { const r = open.reduce((a, b) => (b.score > a.score ? b : a)); return { paints: true, label: 'paints by ' + r.door + ' (' + (r.byRatio && r.byDe ? 'ratio and ΔE' : r.byRatio ? 'ratio' : 'ΔE') + '): ' + all }; }
    if (!reads.length) return { paints: false, label: 'paints nothing: no border, fill or shadow' };
    return { paints: false, label: 'paints nothing: ' + all };
  };
  // v2's paint tests, kept only to list what v3 stops counting and which v2 test had counted it (evidence, never a decision).
  const v2Why = (el) => { const s = css(el); const w = []; if (sides(s) >= 1) w.push('border'); if (!clear(s.backgroundColor) && s.backgroundColor !== groundOf(el)) w.push('fill'); if (s.boxShadow && s.boxShadow !== 'none') w.push('shadow'); return w; };
  const bounded = (el) => paintOf(el).paints;
  // A control: a native or ARIA one, or a bounded box the visitor clicks (a pointer cursor or a tab stop) that holds no
  // control of its own and is not the whole card. Its contents are not blocks of the column (decided 2026-10-02).
  const isControl = (el) => {
    const s = css(el);
    if (inline(s)) return false;
    if (el.matches(CONTROL)) return true;
    if (el === root) return false;
    const clickable = s.cursor === 'pointer' || (el.hasAttribute('tabindex') && el.tabIndex >= 0);
    if (!clickable || !bounded(el) || el.querySelector(CONTROL)) return false;
    const r = el.getBoundingClientRect();
    return r.width * r.height < 0.6 * rootBox.width * rootBox.height;
  };
  const isTable = (el) => el.matches('table,[role="table"],[role="grid"]');
  const isSurface = (el) => {
    if (el === root || isControl(el)) return false;
    const s = css(el);
    if (/^inline/.test(s.display) || s.display === 'contents') return false;
    if (isTable(el)) return true;
    // v3 (the design lead, #1765): what paints owns its edge — a door that opens (border, fill or shadow, by its floor).
    return paintOf(el).paints;
  };
  const path = (el) => {
    const parts = [];
    // v2: the whole path from the root, so nested boxes with the same tail and text never share an id (v1 kept four
    // steps, and three nested surfaces of one card read as one container).
    for (let e = el; e && e !== root; e = e.parentElement) {
      const i = e.parentElement ? Array.prototype.indexOf.call(e.parentElement.children, e) + 1 : 1;
      parts.unshift(e.tagName.toLowerCase() + ':' + i);
    }
    return parts.join('>');
  };
  const label = (el) => { const t = (el.innerText || '').replace(/\s+/g, ' ').trim(); return path(el) + (t ? ' "' + t.slice(0, 24) + '"' : ''); };
  const surfaces = [];
  const surfaceOf = (el, self) => { for (let p = self ? el : el.parentElement; p && p !== root; p = p.parentElement) if (surfaces.indexOf(p) >= 0) return p; return null; };
  const inTable = (el) => { for (let p = el.parentElement; p && p !== root; p = p.parentElement) if (isTable(p)) return true; return false; };
  const inControl = (el) => { for (let p = el; p && p !== root; p = p.parentElement) if (isControl(p)) return p; return null; };
  const all = Array.prototype.slice.call(root.querySelectorAll('*')).filter(shown);
  for (const el of all) if (isSurface(el) && !inTable(el) && !inControl(el)) surfaces.push(el);
  // v3 evidence: what v2 counted as painting and v3 does not, with its best door.
  const unpainted = [];
  const ids = new Map();
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, label(el)); return ids.get(el); };
  const blocks = [];
  // Per block: the element it stands for and its first line's box, for rows.
  const owners = [];
  const lines = [];
  // Per block: its raw line boxes and left, so a row reads the line two items share, not a wrapped item's widest line.
  const rects = [];
  const rawLeft = [];
  const words = [];
  const within = (el, self) => { const s = surfaceOf(el, self); return s ? { within: idOf(s) } : {}; };
  for (const s of surfaces) {
    const r = s.getBoundingClientRect();
    owners.push(s); lines.push({ top: r.top, bottom: r.bottom }); rects.push([r]); rawLeft.push(r.left); words.push('');
    // A placeholder: a box with no text, no control and no image or icon inside it (a loading bar). Not a block.
    const holds = Array.prototype.some.call(s.querySelectorAll('*'), (el) => shown(el) && (el.matches(CONTROL) || el.tagName === 'IMG' || el.tagName.toLowerCase() === 'svg')) || ALNUM.test(s.innerText || '');
    const ss = css(s);
    const cl = r.left + parseFloat(ss.borderLeftWidth) + parseFloat(ss.paddingLeft);
    const cr = r.right - parseFloat(ss.borderRightWidth) - parseFloat(ss.paddingRight);
    blocks.push(Object.assign({ id: idOf(s), kind: 'surface', edge: px(r.left), edgeIs: 'box', left: px(r.left), right: px(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), contentLeft: px(cl), contentRight: px(cr), paint: isTable(s) ? 'a table' : paintOf(s).label }, within(s, false), isTable(s) ? { role: 'table' } : holds ? {} : { role: 'placeholder' }));
  }
  const blockOf = (node) => { for (let p = node.parentElement; p && p !== root; p = p.parentElement) if (!inline(css(p))) return p; return root; };
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test(n.data) || !n.parentElement || n.parentElement.closest('style,script,noscript,template') || !shown(n.parentElement) || inControl(n.parentElement) || inTable(n.parentElement)) continue;
    const b = blockOf(n);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(n);
  }
  // Ink: text whose own colour is not transparent. The edge is the first visible character in ink (decided 2026-10-02):
  // leading invisible text, private-use icon-font glyphs and formatting characters are not characters of the block,
  // while a currency sign or a quotation mark is.
  const inked = (n) => !clear(css(n.parentElement).color) && ALNUM.test(n.data);
  const textRects = (nodes) => {
    const rs = [];
    for (const n of nodes) { if (!inked(n)) continue; const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rs.push(r); }
    return rs;
  };
  const glyphAt = (n, i) => { const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1); const r = range.getClientRects()[0]; return r || null; };
  const firstGlyph = (nodes) => {
    for (const n of nodes) { if (!inked(n)) continue; const i = n.data.search(/[^\s\p{Co}\p{Cf}]/u); if (i < 0) continue; const r = glyphAt(n, i); if (r) return r; }
    return null;
  };
  // A marker paints: a loaded image, an SVG with a filled or stroked shape, or an element with its own fill, border
  // or visible text. An element that paints nothing is not a marker.
  const painted = (m) => {
    if (!shown(m)) return false;
    if (m.tagName === 'IMG') return m.complete && m.naturalWidth > 0;
    if (m.tagName.toLowerCase() === 'svg' || m.closest('svg')) {
      const shapes = m.querySelectorAll('path,circle,rect,line,polyline,polygon,ellipse,use,text');
      return Array.prototype.some.call(shapes, (sh) => { const st = css(sh); return (st.fill !== 'none' && !clear(st.fill)) || (st.stroke !== 'none' && !clear(st.stroke)); });
    }
    const s = css(m);
    if (!clear(s.backgroundColor) || sides(s) >= 1 || ((m.textContent || '').trim().length > 0 && !clear(s.color))) return true;
    // A wrapper that paints nothing itself is a marker when an image or icon inside it paints.
    return Array.prototype.some.call(m.querySelectorAll('svg,img'), (k) => painted(k));
  };
  const markerEls = [];
  const markerBefore = (b, textLeft, lineTop, lineBottom) => {
    const cands = [];
    const consider = (m) => { if (!painted(m)) return; const r = m.getBoundingClientRect(); if (r.left < textLeft - 2 && r.bottom > lineTop && r.top < lineBottom) { cands.push(r.left); markerEls.push(m); } };
    for (const m of b.querySelectorAll('svg,img,[aria-hidden="true"],i')) if ((m.textContent || '').trim().length <= 2) consider(m);
    const p = b.parentElement;
    if (p && p !== root && /flex/.test(css(p).display) && !/column/.test(css(p).flexDirection)) for (const sib of p.children) { if (sib === b) break; if (sib.matches('svg,img,i,[aria-hidden="true"]') || !(sib.textContent || '').trim()) consider(sib); }
    return cands.length ? Math.min.apply(null, cands) : null;
  };
  let texts = 0;
  let ornaments = 0;
  for (const [b, nodes] of groups) {
    if (!nodes.some((n) => ALNUM.test(n.data))) { ornaments += 1; continue; }
    const rs = textRects(nodes);
    const g = firstGlyph(nodes);
    if (!rs.length || g === null) continue;
    texts += 1;
    const first = g.left;
    const left = Math.min.apply(null, rs.map((r) => r.left));
    const right = Math.max.apply(null, rs.map((r) => r.right));
    const top = Math.min.apply(null, rs.map((r) => r.top));
    const marker = markerBefore(b, first, g.top, g.bottom);
    const s = css(b);
    const box = b.getBoundingClientRect();
    const parent = b.parentElement ? css(b.parentElement) : null;
    const centredText = s.textAlign === 'center' && right - left < box.width * 0.9;
    const centredBox = parent && /flex/.test(parent.display) && /column/.test(parent.flexDirection) && parent.alignItems === 'center';
    const list = b.matches('li') || s.display === 'list-item' ? b.closest('ul,ol') : null;
    const inProse = list && list.previousElementSibling && list.previousElementSibling.matches('p');
    const bottom = Math.max.apply(null, rs.map((r) => r.bottom));
    const block = { id: idOf(b), kind: 'text', edge: px(marker !== null ? marker : first), edgeIs: marker !== null ? 'marker' : 'first character', left: px(Math.min(left, marker !== null ? marker : left)), right: px(right), top: Math.round(top), bottom: Math.round(bottom) };
    if (marker !== null) { block.textEdge = px(first); block.textEdgeIs = 'first character'; }
    if (centredText || centredBox) block.role = 'centred';
    else if (inProse) block.role = 'list-item';
    owners.push(b); lines.push({ top: g.top, bottom: g.bottom }); rects.push(rs); rawLeft.push(Math.min(left, marker !== null ? marker : left)); words.push(nodes.map((n) => n.data).join('').trim());
    blocks.push(Object.assign(block, within(b, true)));
  }
  const ctlGroups = new Map();
  for (const el of all) { if (!isControl(el) || inTable(el) || (el.parentElement && inControl(el.parentElement))) continue; const p = el.parentElement || root; if (!ctlGroups.has(p)) ctlGroups.set(p, []); ctlGroups.get(p).push(el); }
  let controls = 0;
  for (const [p, els] of ctlGroups) {
    const rs = els.map((e) => e.getBoundingClientRect());
    const topRow = Math.min.apply(null, rs.map((r) => r.top));
    let firstEl = null; let firstR = null;
    els.forEach((e, i) => { const r = rs[i]; if (r.top - topRow < r.height / 2 && (!firstR || r.left < firstR.left)) { firstEl = e; firstR = r; } });
    let edge = firstR.left;
    let edgeIs = 'box';
    const tw = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT); const ns = []; for (let n = tw.nextNode(); n; n = tw.nextNode()) ns.push(n);
    const cg = firstGlyph(ns);
    const firstPaintRead = paintOf(firstEl);
    if (!firstPaintRead.paints && cg) { edge = cg.left; edgeIs = 'first character'; }
    // v2: a control's edge is its first painted content — its first character or a painted icon inside its box,
    // whichever is leftmost; an icon drawn over a native field counts. A field with neither reads its padding edge.
    const fs = css(firstEl);
    const fieldEdge = firstEl.matches('input,select,textarea') ? firstR.left + parseFloat(fs.borderLeftWidth) + parseFloat(fs.paddingLeft) : null;
    const iconLefts = all.filter((k) => k.matches('svg,img,i,[aria-hidden="true"]') && !(k.parentElement && k.parentElement.closest('svg')) && painted(k)).map((k) => k.getBoundingClientRect()).filter((r) => r.left >= firstR.left - 1 && r.right <= firstR.right + 1 && r.top >= firstR.top - 1 && r.bottom <= firstR.bottom + 1).map((r) => r.left);
    const iconLeft = iconLefts.length ? Math.min.apply(null, iconLefts) : null;
    controls += 1;
    const ps = css(p);
    const centred = ps.justifyContent === 'center' || (ps.textAlign === 'center' && !/flex|grid/.test(ps.display));
    const block = { id: idOf(p) + ' [controls]', kind: 'controls', edge: px(edge), edgeIs: edgeIs, left: px(Math.min.apply(null, rs.map((r) => r.left))), right: px(Math.max.apply(null, rs.map((r) => r.right))), top: Math.round(topRow), bottom: Math.round(Math.max.apply(null, rs.map((r) => r.bottom))), paint: firstPaintRead.label };
    const firstPaint = [cg ? cg.left : null, iconLeft].filter((v) => v !== null);
    if (firstPaint.length) { block.textEdge = px(Math.min.apply(null, firstPaint)); block.textEdgeIs = iconLeft !== null && (cg === null || iconLeft < cg.left) ? 'icon' : 'first character'; }
    else if (fieldEdge !== null) { block.textEdge = px(fieldEdge); block.textEdgeIs = 'field'; }
    if (centred) block.role = 'centred';
    owners.push(firstEl); lines.push({ top: firstR.top, bottom: firstR.bottom }); rects.push(rs); rawLeft.push(Math.min.apply(null, rs.map((r) => r.left))); words.push('');
    blocks.push(Object.assign(block, within(firstEl, true)));
  }
  // v2: media — a painted image, video or icon that is not a text's marker and sits in no text, control or table.
  const textOwners = Array.from(groups.keys());
  for (const el of all) {
    if (!el.matches('img,video,picture,svg') || (el.parentElement && el.parentElement.closest('svg')) || !painted(el) || inControl(el) || inTable(el)) continue;
    if (markerEls.some((m) => m === el || m.contains(el))) continue;
    if (textOwners.some((t) => t.contains(el))) continue;
    const r = el.getBoundingClientRect();
    // An icon drawn inside a control's box (a search field's glass) is the control's adornment, not a block.
    if (all.some((k) => isControl(k) && (() => { const kr = k.getBoundingClientRect(); return r.left >= kr.left - 1 && r.right <= kr.right + 1 && r.top >= kr.top - 1 && r.bottom <= kr.bottom + 1; })())) continue;
    owners.push(el); lines.push({ top: r.top, bottom: r.bottom }); rects.push([r]); rawLeft.push(r.left); words.push('');
    blocks.push(Object.assign({ id: idOf(el) + ' [media]', kind: 'media', edge: px(r.left), edgeIs: 'box', left: px(r.left), right: px(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom) }, within(el, false)));
  }
  // v2 rule 2, trailing: the right content edge of the box a block sits in (its nearest wider, non-inline ancestor
  // inside its container), where a right-anchored item ends.
  for (let i = 0; i < blocks.length; i += 1) {
    const el = owners[i];
    const w = el.getBoundingClientRect().width;
    for (let p = el.parentElement; p && p !== root.parentElement; p = p.parentElement) {
      const ps = css(p);
      if (inline(ps) || ps.display === 'contents') continue;
      const pr = p.getBoundingClientRect();
      if (pr.width <= w + 2) continue;
      blocks[i].parentRight = px(pr.right - parseFloat(ps.borderRightWidth) - parseFloat(ps.paddingRight));
      break;
    }
  }
  // v2 rule 2: a block in a row item that is not the row's leading item on its line follows that leader. A row is a
  // horizontal flex or grid box; the leading item is the leftmost of the shown children that share the item's line.
  const isRowBox = (el) => { const s = css(el); return (/flex/.test(s.display) && !/column/.test(s.flexDirection)) || /grid/.test(s.display); };
  const vOverlap = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;
  for (let i = 0; i < blocks.length; i += 1) {
    const el = owners[i];
    const c = (blocks[i].kind === 'surface' ? surfaceOf(el, false) : surfaceOf(el, true)) || root;
    for (let e = el; e && e !== c && e !== root; e = e.parentElement) {
      const p = e.parentElement;
      if (!p) break;
      if (isRowBox(p)) {
        const er = e.getBoundingClientRect();
        const line = Array.prototype.filter.call(p.children, (k) => shown(k) && vOverlap(k.getBoundingClientRect(), er));
        if (line.length >= 2) {
          const lead = line.reduce((a, k) => (k.getBoundingClientRect().left < a.getBoundingClientRect().left ? k : a));
          // A leader that paints nothing (an empty icon slot) leads nothing: the item after it stands alone on its line.
          const leads = painted(lead) || ALNUM.test(lead.innerText || '');
          if (lead !== e && leads) { blocks[i].follows = label(lead); blocks[i].item = label(e); break; }
        }
      }
      if (p === c) break;
    }
  }
  // Rows (decided 2026-10-01, read by geometry 2026-10-02): items set on one line, however the CSS sets them. An item
  // after another measured item on its line that holds one block (a text, a control, or a box holding at most one
  // text) belongs to the row and is not measured; an item with a stack inside it is a column.
  const dropped = new Set();
  const sameLine = (a, b) => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > Math.min(a.bottom - a.top, b.bottom - b.top) / 2;
  const contains = (o, el) => o === el || o.contains(el);
  const innerTexts = (i) => owners.map((el, k) => k).filter((k) => k !== i && blocks[k].kind !== 'surface' && contains(owners[i], owners[k]));
  const isPill = (i) => blocks[i].kind === 'surface' && innerTexts(i).length <= 1 && !owners.some((el, k) => k !== i && blocks[k].kind === 'surface' && contains(owners[i], el));
  const itemOf = (el, other) => { let e = el; while (e.parentElement && e.parentElement !== root && !e.parentElement.contains(other)) e = e.parentElement; return e; };
  for (let i = 0; i < blocks.length; i += 1) {
    if (blocks[i].kind === 'surface' && !isPill(i)) continue;
    const before = blocks.findIndex((bj, j) => j !== i && bj.within === blocks[i].within && !(bj.kind === 'surface' && !isPill(j)) && !contains(owners[j], owners[i]) && !contains(owners[i], owners[j]) && rects[j].some((r) => sameLine(r, lines[i]) && r.right <= rawLeft[i] + 1));
    if (before < 0) continue;
    // A number or bullet in front of a text on its line is a hanging marker, not a row: the pair is one block with two
    // edges, the marker's and the text's.
    if (blocks[i].kind === 'text' && blocks[before].kind === 'text' && /^[\p{N}\p{P}\p{S}]{1,3}$/u.test(words[before])) {
      blocks[i] = Object.assign({}, blocks[i], { edge: blocks[before].edge, edgeIs: 'marker', left: Math.min(blocks[i].left, blocks[before].left), textEdge: blocks[i].edge, textEdgeIs: 'first character' });
      delete blocks[i].role;
      // v2: the merged block's edge is its marker's, which leads the row, so it stands in its container's column.
      delete blocks[i].follows;
      delete blocks[i].item;
      dropped.add(before);
      continue;
    }
    const item = itemOf(owners[i], owners[before]);
    const inside = owners.map((el, k) => k).filter((k) => contains(item, owners[k]) && blocks[k].kind !== 'surface');
    const boxes = owners.map((el, k) => k).filter((k) => contains(item, owners[k]) && blocks[k].kind === 'surface' && k !== i);
    if (blocks[i].kind === 'surface') { if (boxes.length === 0) { dropped.add(i); for (const k of innerTexts(i)) dropped.add(k); } continue; }
    if (inside.length === 1 && boxes.length === 0) dropped.add(i);
  }
  const kept = blocks.filter((_, i) => !dropped.has(i));
  for (const el of all) { if (inTable(el) || el === root || /^inline/.test(css(el).display) || css(el).display === 'contents' || surfaces.indexOf(el) >= 0) continue; const w = v2Why(el); if (!w.length || paintOf(el).paints) continue; if (inControl(el) && inControl(el) !== el) continue; unpainted.push({ id: idOf(el), paint: paintOf(el).label, v2: w.join('+') }); }
  // Placeholders: a frame with no text in ink shows nothing to evaluate, whatever controls or boxes it draws.
  const rs0 = css(root);
  const cardContent = { left: px(rootBox.left + parseFloat(rs0.borderLeftWidth) + parseFloat(rs0.paddingLeft)), right: px(rootBox.right - parseFloat(rs0.borderRightWidth) - parseFloat(rs0.paddingRight)) };
  return { blocks: kept, unpainted, cardContent, placeholdersOnly: texts === 0, skipped: { rowItems: dropped.size, ornaments } };
})()`;

const KINDS: readonly EdgeBlockV3['kind'][] = ['text', 'controls', 'surface', 'media'];
const ROLES: readonly NonNullable<EdgeBlockV3['role']>[] = ['list-item', 'table', 'centred', 'placeholder'];
const EDGE_KINDS: readonly NonNullable<EdgeBlockV3['edgeIs']>[] = ['box', 'first character', 'marker', 'icon', 'field'];
const isKind = (v: unknown): v is EdgeBlockV3['kind'] => KINDS.some((k) => k === v);
const isRole = (v: unknown): v is NonNullable<EdgeBlockV3['role']> => ROLES.some((r) => r === v);
const isEdgeKind = (v: unknown): v is NonNullable<EdgeBlockV3['edgeIs']> => EDGE_KINDS.some((k) => k === v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const field = (o: object, key: string): unknown => Reflect.get(o, key);
const optNum = (v: unknown): boolean => v === undefined || num(v);
const optStr = (v: unknown): boolean => v === undefined || typeof v === 'string';

/**
 * The v3 probe's typed read: `null` when the page had no `#root` or returned something else, so a failed measurement
 * is reported as unmeasured and never read as "no offsets". A malformed block fails the whole read for the same reason.
 */
export function parseEdgeProbeV3(value: unknown): EdgeProbeV3 | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = field(value, 'blocks');
  const placeholdersOnly = field(value, 'placeholdersOnly');
  const cc = field(value, 'cardContent');
  if (!Array.isArray(raw) || typeof placeholdersOnly !== 'boolean' || typeof cc !== 'object' || cc === null) return null;
  const ccLeft = field(cc, 'left');
  const ccRight = field(cc, 'right');
  if (!num(ccLeft) || !num(ccRight)) return null;
  const skippedRaw = field(value, 'skipped');
  if (typeof skippedRaw !== 'object' || skippedRaw === null) return null;
  const rowItems = field(skippedRaw, 'rowItems');
  const ornaments = field(skippedRaw, 'ornaments');
  if (!num(rowItems) || !num(ornaments)) return null;
  const unpaintedRaw = field(value, 'unpainted');
  if (!Array.isArray(unpaintedRaw)) return null;
  const unpainted: UnpaintedBox[] = [];
  for (const u of unpaintedRaw) {
    if (typeof u !== 'object' || u === null) return null;
    const uid = field(u, 'id');
    const upaint = field(u, 'paint');
    const uv2 = field(u, 'v2');
    if (typeof uid !== 'string' || typeof upaint !== 'string' || typeof uv2 !== 'string') return null;
    unpainted.push({ id: uid, paint: upaint, v2: uv2 });
  }
  const blocks: EdgeBlockV3[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const [id, kind, edge, left, right, top, bottom] = ['id', 'kind', 'edge', 'left', 'right', 'top', 'bottom'].map((k) => field(entry, k));
    const [within, textEdge, role, contentLeft, contentRight, follows, item, parentRight] = ['within', 'textEdge', 'role', 'contentLeft', 'contentRight', 'follows', 'item', 'parentRight'].map((k) => field(entry, k));
    if (typeof id !== 'string' || !isKind(kind) || !num(edge) || !num(left) || !num(right) || !num(top) || !num(bottom)) return null;
    if (!optStr(within) || !optNum(textEdge) || !optNum(contentLeft) || !optNum(contentRight) || !optStr(follows) || !optStr(item) || !optNum(parentRight)) return null;
    if (role !== undefined && !isRole(role)) return null;
    const [edgeIs, textEdgeIs, paint] = ['edgeIs', 'textEdgeIs', 'paint'].map((k) => field(entry, k));
    if (!isEdgeKind(edgeIs) || (textEdgeIs !== undefined && !isEdgeKind(textEdgeIs)) || !optStr(paint)) return null;
    blocks.push({
      id,
      kind,
      edge,
      left,
      right,
      top,
      bottom,
      ...(typeof within === 'string' ? { within } : {}),
      ...(num(textEdge) ? { textEdge } : {}),
      ...(role !== undefined ? { role } : {}),
      ...(num(contentLeft) ? { contentLeft } : {}),
      ...(num(contentRight) ? { contentRight } : {}),
      ...(typeof follows === 'string' ? { follows } : {}),
      ...(typeof item === 'string' ? { item } : {}),
      ...(num(parentRight) ? { parentRight } : {}),
      edgeIs,
      ...(isEdgeKind(textEdgeIs) ? { textEdgeIs } : {}),
      ...(typeof paint === 'string' ? { paint } : {}),
    });
  }
  return { blocks, unpainted, cardContent: { left: ccLeft, right: ccRight }, placeholdersOnly, skipped: { rowItems, ornaments } };
}
