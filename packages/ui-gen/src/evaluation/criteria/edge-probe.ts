/**
 * `space.edge`'s measurement (#1663): the expression a capture evaluates in the page to produce {@link EdgeBlock}s for
 * {@link judgeEdges}. It runs where the screenshot is taken, on the same DOM at the same width, so the rule reads what
 * the judge's frame shows. It only reads layout; it never writes to the page.
 *
 * What it measures, under `#root`, in CSS px from the card's left edge:
 *
 * - **Text blocks.** Text is grouped by its nearest non-inline element. A block's edge is its first visible character
 *   in ink: text in a transparent colour, private-use icon-font glyphs and formatting characters are not characters of
 *   the block. Its extent is the union of its inked line boxes. A marker before the text (an icon or image that paints,
 *   or a number or bullet on the same line) makes it a hanging marker: `edge` is the marker's, `textEdge` the text's.
 * - **Control groups.** Native and ARIA controls, and bounded boxes the visitor clicks (a pointer cursor or a tab stop,
 *   holding no control of their own), group by their parent and are measured at the first control: the border box
 *   when bounded, else its text. A control's contents are never blocks of the enclosing column.
 * - **Surfaces.** A non-inline box with a border on at least three sides, its own fill different from what it sits on,
 *   or a shadow. A table is a surface measured at its rule and not descended into. A box with no text, control, image
 *   or icon inside (a loading bar) is a `placeholder`, which is not a block.
 * - **Roles.** A list item is `list-item` when its list follows a paragraph; text centred in a box wider than it, or
 *   controls in a centring row, are `centred`.
 * - **Rows, first, read by geometry.** Items set on one line, however the CSS lays them out: an item after another
 *   measured item on its line that holds one block (a text, a control, or a box holding at most one text) belongs to
 *   the row and is not measured. An item with a stack inside it is a column.
 * - **Ornaments:** text with no letters or digits is not measured.
 *
 * Hidden elements (through any ancestor), zero-size ones and transparent text are skipped. What the rows and ornament
 * rules set aside is counted. A frame with no text in ink is reported as placeholders only. The expression returns a
 * JSON value; {@link parseEdgeProbe} is its typed read.
 */
import type { EdgeBlock } from './edge.js';

/** What the probe returns: the measured blocks, and whether the frame showed nothing to evaluate. */
export interface EdgeProbe {
  readonly blocks: readonly EdgeBlock[];
  readonly placeholdersOnly: boolean;
  /** What the probe saw and did not measure, by rule, so a dropped block is counted rather than silent. */
  readonly skipped: { readonly rowItems: number; readonly ornaments: number };
}

// Plain ES2020 for the page: no imports, no template literals, no helpers a bundler might rename.
export const EDGE_BLOCKS_EXPRESSION = String.raw`(() => {
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
  const bounded = (el) => { const s = css(el); return sides(s) >= 1 || (!clear(s.backgroundColor) && s.backgroundColor !== groundOf(el)); };
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
    return sides(s) >= 3 || (!clear(s.backgroundColor) && s.backgroundColor !== groundOf(el)) || (s.boxShadow && s.boxShadow !== 'none');
  };
  const path = (el) => {
    const parts = [];
    for (let e = el; e && e !== root && parts.length < 4; e = e.parentElement) {
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
    blocks.push(Object.assign({ id: idOf(s), kind: 'surface', edge: px(r.left), left: px(r.left), right: px(r.right), top: Math.round(r.top) }, within(s, false), isTable(s) ? { role: 'table' } : holds ? {} : { role: 'placeholder' }));
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
  const markerBefore = (b, textLeft, lineTop, lineBottom) => {
    const cands = [];
    const consider = (m) => { if (!painted(m)) return; const r = m.getBoundingClientRect(); if (r.left < textLeft - 2 && r.bottom > lineTop && r.top < lineBottom) cands.push(r.left); };
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
    const block = { id: idOf(b), kind: 'text', edge: px(marker !== null ? marker : first), left: px(Math.min(left, marker !== null ? marker : left)), right: px(right), top: Math.round(top) };
    if (marker !== null) block.textEdge = px(first);
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
    if (!bounded(firstEl)) { const tw = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT); const ns = []; for (let n = tw.nextNode(); n; n = tw.nextNode()) ns.push(n); const g = firstGlyph(ns); if (g) edge = g.left; }
    controls += 1;
    const ps = css(p);
    const centred = ps.justifyContent === 'center' || (ps.textAlign === 'center' && !/flex|grid/.test(ps.display));
    const block = { id: idOf(p) + ' [controls]', kind: 'controls', edge: px(edge), left: px(Math.min.apply(null, rs.map((r) => r.left))), right: px(Math.max.apply(null, rs.map((r) => r.right))), top: Math.round(topRow) };
    if (centred) block.role = 'centred';
    owners.push(firstEl); lines.push({ top: firstR.top, bottom: firstR.bottom }); rects.push(rs); rawLeft.push(Math.min.apply(null, rs.map((r) => r.left))); words.push('');
    blocks.push(Object.assign(block, within(firstEl, true)));
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
      blocks[i] = Object.assign({}, blocks[i], { edge: blocks[before].edge, left: Math.min(blocks[i].left, blocks[before].left), textEdge: blocks[i].edge });
      delete blocks[i].role;
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
  // Placeholders: a frame with no text in ink shows nothing to evaluate, whatever controls or boxes it draws.
  return { blocks: kept, placeholdersOnly: texts === 0, skipped: { rowItems: dropped.size, ornaments } };
})()`;

const KINDS: readonly EdgeBlock['kind'][] = ['text', 'controls', 'surface'];
const ROLES: readonly NonNullable<EdgeBlock['role']>[] = ['list-item', 'table', 'centred', 'placeholder'];
const isKind = (v: unknown): v is EdgeBlock['kind'] => KINDS.some((k) => k === v);
const isRole = (v: unknown): v is NonNullable<EdgeBlock['role']> => ROLES.some((r) => r === v);
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const field = (o: object, key: string): unknown => Reflect.get(o, key);

/**
 * The probe's typed read: `null` when the page had no `#root` or returned something else, so a failed measurement is
 * reported as unmeasured and never read as "no offsets". A malformed block fails the whole read for the same reason.
 */
export function parseEdgeProbe(value: unknown): EdgeProbe | null {
  if (typeof value !== 'object' || value === null) return null;
  const raw = field(value, 'blocks');
  const placeholdersOnly = field(value, 'placeholdersOnly');
  if (!Array.isArray(raw) || typeof placeholdersOnly !== 'boolean') return null;
  const skippedRaw = field(value, 'skipped');
  if (typeof skippedRaw !== 'object' || skippedRaw === null) return null;
  const rowItems = field(skippedRaw, 'rowItems');
  const ornaments = field(skippedRaw, 'ornaments');
  if (!num(rowItems) || !num(ornaments)) return null;
  const blocks: EdgeBlock[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) return null;
    const [id, kind, edge, left, right, top] = ['id', 'kind', 'edge', 'left', 'right', 'top'].map((k) => field(entry, k));
    const [within, textEdge, role] = ['within', 'textEdge', 'role'].map((k) => field(entry, k));
    if (typeof id !== 'string' || !isKind(kind) || !num(edge) || !num(left) || !num(right) || !num(top)) return null;
    if (within !== undefined && typeof within !== 'string') return null;
    if (textEdge !== undefined && !num(textEdge)) return null;
    if (role !== undefined && !isRole(role)) return null;
    blocks.push({
      id,
      kind,
      edge,
      left,
      right,
      top,
      ...(within !== undefined ? { within } : {}),
      ...(textEdge !== undefined ? { textEdge } : {}),
      ...(role !== undefined ? { role } : {}),
    });
  }
  return { blocks, placeholdersOnly, skipped: { rowItems, ornaments } };
}
