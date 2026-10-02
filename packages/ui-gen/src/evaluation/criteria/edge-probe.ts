/**
 * `space.edge`'s measurement (#1663, step 2): the expression a capture evaluates in the page to produce
 * {@link EdgeBlock}s for {@link judgeEdges}. It runs where the screenshot is taken, on the same DOM at the same width,
 * so the rule reads what the judge's frame shows.
 *
 * What it measures, under `#root`, in CSS px from the card's left edge:
 *
 * - **Text blocks.** Text is grouped by its nearest non-inline element. A block's edge is its first character's
 *   origin, and its extent is the union of its text's line boxes (ink, not the element's box, so stacked text
 *   overlaps and side-by-side columns do not). A marker before the text (an icon or image in the same row) makes it a
 *   hanging marker: `edge` is the marker's, `textEdge` the text's.
 * - **Control groups.** Controls that are not inline (buttons, inputs, `role=button` and the like) group by their
 *   parent. A group is measured at its first control: the border box when the control is bounded (a border or its own
 *   fill), else its text.
 * - **Surfaces.** A non-inline box with a border on at least three sides, its own fill different from what it sits
 *   on, or a shadow. A table is a surface measured at its rule and not descended into.
 * - **Roles.** A list item is `list-item` when its list follows a paragraph (a list in running text); text centred in
 *   a box wider than it, or controls in a centring row, are `centred`.
 *
 * - **Rows, first** (decided 2026-10-01): in a container that sets its items on one line, an item after the first
 *   that holds only one block (a count beside a title, a badge, a meta line or a link at the line's end) belongs to the
 *   row and is not measured; the row is measured at its first item. An item with a stack inside it is a column.
 * - **Ornaments:** text with no letters or digits (a lone symbol, an emoji, a glyph divider) is not measured.
 *
 * Hidden, zero-size and transparent elements are skipped. A frame with no text and no controls is reported as
 * placeholders only. The expression returns a JSON value; {@link parseEdgeProbe} is its typed read.
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
  const x0 = root.getBoundingClientRect().left;
  const px = (v) => Math.round((v - x0) * 2) / 2;
  const CONTROL = 'button,input,select,textarea,[role="button"],[role="tab"],[role="switch"],[role="checkbox"],[role="radio"],[role="option"],[role="link"],a[href]';
  const css = (el) => getComputedStyle(el);
  const clear = (c) => !c || c === 'transparent' || /rgba\([^)]*,\s*0(\.0+)?\)$/.test(c);
  const shown = (el) => {
    const s = css(el);
    if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const inline = (s) => /^inline/.test(s.display) && s.display !== 'inline-block' && s.display !== 'inline-flex' && s.display !== 'inline-grid';
  const isControl = (el) => el.matches(CONTROL) && !inline(css(el));
  const groundOf = (el) => {
    for (let p = el.parentElement; p; p = p.parentElement) { const b = css(p).backgroundColor; if (!clear(b)) return b; }
    return 'rgb(255, 255, 255)';
  };
  const sides = (s) => ['Top', 'Right', 'Bottom', 'Left'].filter((k) => parseFloat(s['border' + k + 'Width']) > 0 && s['border' + k + 'Style'] !== 'none' && !clear(s['border' + k + 'Color'])).length;
  const bounded = (el) => { const s = css(el); return sides(s) >= 1 || (!clear(s.backgroundColor) && s.backgroundColor !== groundOf(el)); };
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
  for (const el of all) if (isSurface(el) && !inTable(el)) surfaces.push(el);
  const ids = new Map();
  const idOf = (el) => { if (!ids.has(el)) ids.set(el, label(el)); return ids.get(el); };
  const blocks = [];
  // The element each measured block stands for (its text's block, or its control group's first control), for rows.
  const owners = [];
  // A surface sits within its nearest surface ancestor; a text or control sits within the surface it is in, itself included.
  const within = (el, self) => { const s = surfaceOf(el, self); return s ? { within: idOf(s) } : {}; };
  // Surfaces.
  for (const s of surfaces) {
    const r = s.getBoundingClientRect();
    owners.push(s);
    blocks.push(Object.assign({ id: idOf(s), kind: 'surface', edge: px(r.left), left: px(r.left), right: px(r.right), top: Math.round(r.top) }, within(s, false), isTable(s) ? { role: 'table' } : {}));
  }
  // Text, grouped by its nearest non-inline element.
  const blockOf = (node) => { for (let p = node.parentElement; p && p !== root; p = p.parentElement) if (!inline(css(p))) return p; return root; };
  const groups = new Map();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!/\S/.test(n.data) || !n.parentElement || n.parentElement.closest('style,script,noscript,template') || !shown(n.parentElement) || inControl(n.parentElement) || inTable(n.parentElement)) continue;
    const b = blockOf(n);
    if (!groups.has(b)) groups.set(b, []);
    groups.get(b).push(n);
  }
  const textRects = (nodes) => {
    const rs = [];
    for (const n of nodes) { const range = document.createRange(); range.selectNodeContents(n); for (const r of range.getClientRects()) if (r.width > 0 && r.height > 0) rs.push(r); }
    return rs;
  };
  const firstChar = (n) => {
    const i = n.data.search(/\S/);
    const range = document.createRange(); range.setStart(n, i); range.setEnd(n, i + 1);
    const r = range.getClientRects()[0];
    return r ? r.left : null;
  };
  const markerBefore = (b, textLeft, lineTop, lineBottom) => {
    const cands = [];
    const scan = (scope) => { for (const m of scope.querySelectorAll('svg,img,[aria-hidden="true"],i')) { if (!shown(m) || (m.textContent || '').trim().length > 2) continue; const r = m.getBoundingClientRect(); if (r.left < textLeft - 2 && r.bottom > lineTop && r.top < lineBottom) cands.push(r.left); } };
    scan(b);
    const p = b.parentElement;
    if (p && p !== root && /flex/.test(css(p).display) && !/column/.test(css(p).flexDirection)) for (const sib of p.children) { if (sib === b) break; if (sib.matches('svg,img,i,[aria-hidden="true"]') || !(sib.textContent || '').trim()) { if (shown(sib)) { const r = sib.getBoundingClientRect(); if (r.left < textLeft - 2 && r.bottom > lineTop && r.top < lineBottom) cands.push(r.left); } } }
    return cands.length ? Math.min.apply(null, cands) : null;
  };
  let texts = 0;
  let ornaments = 0;
  for (const [b, nodes] of groups) {
    const rs = textRects(nodes);
    if (!rs.length) continue;
    // Ornament: a block with no letters or digits (a lone symbol, an emoji, a glyph divider) is not text.
    if (!nodes.some((n) => /[\p{L}\p{N}]/u.test(n.data))) { ornaments += 1; continue; }
    const first = firstChar(nodes[0]);
    if (first === null) continue;
    texts += 1;
    const left = Math.min.apply(null, rs.map((r) => r.left));
    const right = Math.max.apply(null, rs.map((r) => r.right));
    const top = Math.min.apply(null, rs.map((r) => r.top));
    const line = rs[0];
    const marker = markerBefore(b, first, line.top, line.bottom);
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
    owners.push(b);
    blocks.push(Object.assign(block, within(b, true)));
  }
  // Control groups, by parent; measured at the first control.
  const ctlGroups = new Map();
  for (const el of all) { if (!isControl(el) || inTable(el) || (el.parentElement && inControl(el.parentElement))) continue; const p = el.parentElement || root; if (!ctlGroups.has(p)) ctlGroups.set(p, []); ctlGroups.get(p).push(el); }
  let controls = 0;
  for (const [p, els] of ctlGroups) {
    const rs = els.map((e) => e.getBoundingClientRect());
    const topRow = Math.min.apply(null, rs.map((r) => r.top));
    let firstEl = null; let firstR = null;
    els.forEach((e, i) => { const r = rs[i]; if (r.top - topRow < r.height / 2 && (!firstR || r.left < firstR.left)) { firstEl = e; firstR = r; } });
    let edge = firstR.left;
    if (!bounded(firstEl)) { const tw = document.createTreeWalker(firstEl, NodeFilter.SHOW_TEXT); for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/\S/.test(n.data)) { const f = firstChar(n); if (f !== null) edge = f; break; } }
    controls += 1;
    const ps = css(p);
    const centred = ps.justifyContent === 'center' || (ps.textAlign === 'center' && !/flex|grid/.test(ps.display));
    const block = { id: idOf(p) + ' [controls]', kind: 'controls', edge: px(edge), left: px(Math.min.apply(null, rs.map((r) => r.left))), right: px(Math.max.apply(null, rs.map((r) => r.right))), top: Math.round(topRow) };
    if (centred) block.role = 'centred';
    owners.push(firstEl);
    blocks.push(Object.assign(block, within(firstEl, true)));
  }
  // Rows (decided 2026-10-01): items set on one line. An item after the first on its line that holds only one block
  // (one text block or one control) belongs to the row and is not measured; an item with a stack inside is a column.
  const dropped = new Set();
  const lineOf = (a, b) => { const ra = a.getBoundingClientRect(); const rb = b.getBoundingClientRect(); return Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top) > Math.min(ra.height, rb.height) / 2; };
  for (const r of all) {
    const rs = css(r);
    const isRow = (/flex/.test(rs.display) && !/column/.test(rs.flexDirection)) || /grid/.test(rs.display);
    if (!isRow) continue;
    const items = Array.prototype.filter.call(r.children, (c) => shown(c));
    if (items.length < 2) continue;
    for (const item of items) {
      // Only an item that is itself measured opens a row: an icon before a heading is a marker, not a row's first item.
      const measured = (o) => owners.some((el) => el === o || o.contains(el));
      const before = items.filter((o) => o !== item && measured(o) && lineOf(o, item) && o.getBoundingClientRect().left < item.getBoundingClientRect().left - 1);
      if (!before.length) continue;
      const inside = [];
      owners.forEach((el, i) => { if (blocks[i].kind !== 'surface' && (el === item || item.contains(el))) inside.push(i); });
      const surfaceInside = owners.some((el, i) => blocks[i].kind === 'surface' && (el === item || item.contains(el)));
      if (inside.length === 1 && !surfaceInside) dropped.add(inside[0]);
    }
  }
  const kept = blocks.filter((_, i) => !dropped.has(i));
  return { blocks: kept, placeholdersOnly: texts === 0 && controls === 0, skipped: { rowItems: dropped.size, ornaments } };
})()`;

const KINDS: readonly EdgeBlock['kind'][] = ['text', 'controls', 'surface'];
const ROLES: readonly NonNullable<EdgeBlock['role']>[] = ['list-item', 'table', 'centred'];
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
