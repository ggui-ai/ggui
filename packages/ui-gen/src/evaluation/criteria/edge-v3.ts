/**
 * `space.edge.v3` (#1765): the v2 rule (`edge-v2.ts`, frozen at the judge's `6decf702c`) with the three changes the
 * design lead ruled on the sealed v2 draw, pre-registered on the row before any v3 value was read. Nothing else moves.
 * 1. A surface that bleeds to the card's edges is judged by its content's own edge (`contentEdge()`), against the card's
 *    content edge like any block (rule 6); v2 judged it at its CSS padding box, so a centred title over a full-width
 *    board was never compared to the board. A bleed with no non-centred text keeps its padding box.
 * 2. A block off every allowed edge is off by the SMALLEST distance from any of its edges (`edge`, `textEdge`) to any
 *    allowed edge, and the evidence names which edge that was; v2 measured from `edge` alone, so a ghost control's
 *    label was reported when its arrow sat nearer.
 * 3. What paints is decided by the probe (`edge-probe-v3.ts`, three doors with floors); this module reads the result.
 * Evidence names, for each offset, the edge measured from and the paint of the box it sits in, and lists the boxes v2
 * counted as painting that open no v3 door.
 *
 * Input is the measured block list from `edge-probe-v3.ts`; this module measures nothing itself.
 */
import { EDGE_TOLERANCE_PX, type EdgeOffset, type EdgeVerdict } from './edge.js';
import type { CardContentBox, EdgeBlockV2 } from './edge-v2.js';

/** What one of a block's edges is: its box, its first visible character, a marker before its text, an icon, a field's padding edge. */
export type EdgeKindV3 = 'box' | 'first character' | 'marker' | 'icon' | 'field';

/** One block as the v3 probe measures it: v2's fields, plus what its edges are and (surfaces, controls) how it paints. */
export interface EdgeBlockV3 extends EdgeBlockV2 {
  readonly edgeIs: EdgeKindV3;
  readonly textEdgeIs?: EdgeKindV3;
  /** Surfaces and control sets: every door read, both measures, and which door and measure opened it (or none). */
  readonly paint?: string;
}

/** A box v2 counted as painting (by `v2`: border, fill, shadow, joined by +) that opens no v3 door. */
export interface UnpaintedBox {
  readonly id: string;
  readonly paint: string;
  readonly v2: string;
}

/** An offset, with the edge of the block it was measured from. */
export interface EdgeOffsetV3 extends EdgeOffset {
  readonly from: string;
}

export { EDGE_TOLERANCE_PX };
export type { CardContentBox, EdgeOffset, EdgeVerdict };

// ── v2's column logic (itself v1's, from `edge.ts` at `cec465319`), copied from `edge-v2.ts`; change 2 marked below ──
const CARD = 'card';
const same = (a: number, b: number): boolean => Math.abs(a - b) <= EDGE_TOLERANCE_PX;
const overlaps = (a: EdgeBlockV3, b: EdgeBlockV3): boolean => a.left < b.right && b.left < a.right;
const axis = (b: EdgeBlockV3): number => (b.left + b.right) / 2;

/** A surface's content edge: where its first text starts (its topmost text block's edge), or undefined if it has none. */
function contentEdge(surface: EdgeBlockV3, blocks: readonly EdgeBlockV3[]): number | undefined {
  const texts = blocks.filter((b) => b.within === surface.id && b.kind !== 'surface' && b.role !== 'centred');
  if (texts.length === 0) return undefined;
  const first = texts.reduce((a, b) => (b.top < a.top ? b : a));
  return first.textEdge ?? first.edge;
}

/** Columns among a container's direct blocks: non-surface blocks that overlap horizontally, transitively. */
function columns(direct: readonly EdgeBlockV3[]): EdgeBlockV3[][] {
  const all = direct.filter((b) => b.kind !== 'surface');
  // A block that spans two columns side by side (it overlaps two blocks that do not overlap each other) belongs to
  // their parent column, never to either (decided 2026-10-02): it must not chain them into one.
  const bridges = (b: EdgeBlockV3): boolean => {
    const under = all.filter((x) => x !== b && overlaps(x, b));
    return under.some((x, i) => under.slice(i + 1).some((y) => !overlaps(x, y)));
  };
  const flow = all.filter((b) => !bridges(b));
  const parentPool: EdgeBlockV3[] = all.filter((b) => bridges(b));
  const parent = flow.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < flow.length; i += 1) for (let j = i + 1; j < flow.length; j += 1) if (overlaps(flow[i]!, flow[j]!)) parent[find(i)] = find(j);
  const groups = new Map<number, EdgeBlockV3[]>();
  flow.forEach((b, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), b]));
  const cols = [...groups.values()];
  // A surface joins the one column whose text or controls it overlaps. One that overlaps two or more columns spans
  // them and goes to their parent, like a spanning text block; one that overlaps none stands with the other
  // unclaimed blocks. Only flow blocks decide, so a surface never chains another surface into a column.
  for (const s of direct.filter((b) => b.kind === 'surface')) {
    const hit = cols.filter((c) => c.some((b) => b.kind !== 'surface' && overlaps(b, s)));
    if (hit.length === 1) hit[0]!.push(s);
    else parentPool.push(s);
  }
  // The parent's blocks and the unclaimed surfaces form columns among themselves: blocks that overlap stack.
  const lp = parentPool.map((_, i) => i);
  const lfind = (i: number): number => (lp[i] === i ? i : (lp[i] = lfind(lp[i]!)));
  for (let i = 0; i < parentPool.length; i += 1) for (let j = i + 1; j < parentPool.length; j += 1) if (overlaps(parentPool[i]!, parentPool[j]!)) lp[lfind(i)] = lfind(j);
  const lgroups = new Map<number, EdgeBlockV3[]>();
  parentPool.forEach((b, i) => lgroups.set(lfind(i), [...(lgroups.get(lfind(i)) ?? []), b]));
  cols.push(...lgroups.values());
  return cols;
}

/** One column's check: one edge, or a stacked surface's content edge (the surface is then a ground). */
function checkColumn(container: string, col: readonly EdgeBlockV3[], blocks: readonly EdgeBlockV3[]): EdgeOffsetV3[] {
  const surfaces = col.filter((b) => b.kind === 'surface');
  const grounds = surfaces.flatMap((s) => {
    const c = s.role === 'table' ? undefined : contentEdge(s, blocks);
    return c === undefined ? [] : [c];
  });
  const flow = col.filter((b) => b.kind !== 'surface' && b.role !== 'centred' && b.role !== 'list-item');
  const listItems = col.filter((b) => b.role === 'list-item');
  // Every edge a flow block or a surface offers; the common edge E must sit on one of them.
  const candidates = [...flow.flatMap((b) => [b.edge, ...(b.textEdge !== undefined ? [b.textEdge] : [])]), ...surfaces.flatMap((s) => [s.edge]), ...grounds];
  const blockEdges = (b: EdgeBlockV3): number[] => [b.edge, ...(b.textEdge !== undefined ? [b.textEdge] : [])];
  // The end edges another block of the column offers: its boxes' and its other control sets'.
  const endEdgesBesides = (b: EdgeBlockV3): number[] => [...surfaces.map((s) => s.right), ...flow.filter((x) => x !== b && x.kind === 'controls').map((x) => x.right)];
  // A column of only list items or only a centred group has no common edge to find; their own checks below still run.
  let best: EdgeOffsetV3[] | null = candidates.length === 0 ? [] : null;
  for (const E of candidates) {
    const allowed = [E, ...grounds];
    const off: EdgeOffsetV3[] = [];
    for (const b of flow) {
      if (blockEdges(b).some((x) => allowed.some((a) => same(x, a)))) continue;
      // A control set alone on its line may END on the end edge its column's boxes or other controls share.
      if (b.kind === 'controls' && endEdgesBesides(b).some((r) => same(b.right, r))) continue;
      // v3 change 2: the smallest distance from ANY of the block's edges to any allowed edge, naming the edge.
      const own: { at: number; from: string }[] = [{ at: b.edge, from: b.edgeIs }, ...(b.textEdge !== undefined ? [{ at: b.textEdge, from: b.textEdgeIs ?? 'first character' }] : [])];
      let pick = { at: own[0]!.at, from: own[0]!.from, nearest: allowed[0]!, d: Infinity };
      for (const o of own) for (const a of allowed) if (Math.abs(o.at - a) < pick.d) pick = { at: o.at, from: o.from, nearest: a, d: Math.abs(o.at - a) };
      off.push({ container, block: b.id, at: pick.at, nearest: pick.nearest, offPx: pick.d, from: pick.from });
    }
    for (const s of surfaces) {
      const c = s.role === 'table' ? undefined : contentEdge(s, blocks);
      if (same(s.edge, E) || (c !== undefined && same(c, E))) continue;
      const nearest = c !== undefined && Math.abs(c - E) < Math.abs(s.edge - E) ? c : s.edge;
      off.push({ container, block: s.id, at: nearest, nearest: E, offPx: Math.abs(nearest - E), from: c !== undefined && nearest === c ? 'content' : 'box' });
    }
    if (best === null || off.length < best.length || (off.length === best.length && sum(off) < sum(best))) best = off;
    if (best.length === 0) break;
  }
  const offsets = best ?? [];
  // A list inside running text: its items share an edge of their own.
  if (listItems.length > 1) {
    const e0 = listItems[0]!.edge;
    for (const li of listItems.slice(1)) if (!same(li.edge, e0)) offsets.push({ container, block: li.id, at: li.edge, nearest: e0, offPx: Math.abs(li.edge - e0), from: li.edgeIs });
  }
  // A centred group: its members share one centre axis, and it must be the whole content of its column. A column is
  // edge-aligned or centred, never both (decided 2026-10-02).
  const centred = col.filter((b) => b.role === 'centred');
  // A centred group of two or more may follow a label or heading when nothing edge-aligned follows it (an empty state
  // under its section label). One centred block among edge-aligned ones, or a column that returns to an edge after
  // the group, fails (decided 2026-10-02).
  const edgeAligned = col.filter((b) => b.role !== 'centred');
  const groupTop = centred.length > 0 ? Math.min(...centred.map((c) => c.top)) : 0;
  const groupEndsColumn = centred.length > 1 && edgeAligned.every((b) => b.top < groupTop);
  if (centred.length > 0 && edgeAligned.some((b) => b.kind !== 'surface') && !groupEndsColumn) {
    const E = flow[0]?.edge ?? edgeAligned[0]!.edge;
    for (const c of centred) offsets.push({ container, block: c.id, at: c.edge, nearest: E, offPx: Math.abs(c.edge - E), reason: 'a centred block in an edge-aligned column', from: c.edgeIs });
  } else if (centred.length > 1) {
    const a0 = axis(centred[0]!);
    for (const c of centred.slice(1)) if (!same(axis(c), a0)) offsets.push({ container, block: c.id, at: axis(c), nearest: a0, offPx: Math.abs(axis(c) - a0), from: 'centre' });
  }
  return offsets;
}
const sum = (o: readonly EdgeOffsetV3[]): number => o.reduce((s, x) => s + x.offPx, 0);

// ── v2's judge, with v3's changes 1 and 2 marked ──

/** Rule 2: a block in a row item after the row's leader is measured with its own item, never against its container. */
const follower = (b: EdgeBlockV3): boolean => b.follows !== undefined;
const vOverlap = (a: EdgeBlockV3, b: EdgeBlockV3): boolean => Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1;

/**
 * Judge one captured width under the v3 rule. `cardContent` is the card's own content box from the probe;
 * `placeholdersOnly`: the frame shows only loading placeholders, so the row is not evaluated; `unpainted`: the boxes v2
 * counted as painting that open no v3 door, named in the evidence.
 */
export function judgeEdgesV3(
  measured: readonly EdgeBlockV3[],
  opts: { readonly cardContent: CardContentBox; readonly placeholdersOnly?: boolean; readonly unpainted?: readonly UnpaintedBox[] },
): EdgeVerdict {
  if (opts.placeholdersOnly === true) return { verdict: 'n/a', offsets: [], evidence: 'only loading placeholders are shown; not evaluated' };
  const content = measured.filter((b) => b.role !== 'placeholder' && (b.kind === 'text' || b.kind === 'controls')).length;
  if (content < 2) return { verdict: 'n/a', offsets: [], evidence: measured.length === 0 ? 'no blocks were measured' : 'fewer than two blocks once placeholders are set aside; not evaluated' };
  const byId = new Map(measured.map((b) => [b.id, b]));
  const containerOf = (b: EdgeBlockV3): string => b.within ?? CARD;
  const contentBoxOf = (container: string): CardContentBox | undefined => {
    if (container === CARD) return opts.cardContent;
    const s = byId.get(container);
    return s?.contentLeft !== undefined && s.contentRight !== undefined ? { left: s.contentLeft, right: s.contentRight } : undefined;
  };
  // A placeholder leads its row when a block of its container follows it on its line; otherwise it is not a block (v1).
  const leadsARow = (p: EdgeBlockV3): boolean => measured.some((b) => b !== p && containerOf(b) === containerOf(p) && follower(b) && b.left >= p.right - 1 && vOverlap(b, p));
  // Rule 4 (re-registered): media is a painted image, or a painted box with no control inside, that is the only block
  // on its line in its container; it may centre in its column, and its own content may centre inside it.
  const holdsControl = (s: EdgeBlockV3): boolean => {
    const inside = (b: EdgeBlockV3): boolean => { for (let w = b.within; w !== undefined; w = byId.get(w)?.within) if (w === s.id) return true; return false; };
    return measured.some((b) => b.kind === 'controls' && inside(b));
  };
  const aloneOnItsLine = (m: EdgeBlockV3): boolean =>
    !measured.some((b) => b !== m && containerOf(b) === containerOf(m) && b.role !== 'placeholder' && vOverlap(b, m));
  // Centred, and narrower than its column: a box that starts on its container's content edge is full width, not centred.
  const centredInContainer = (m: EdgeBlockV3): boolean => {
    const box = contentBoxOf(containerOf(m));
    return box !== undefined && same((m.left + m.right) / 2, (box.left + box.right) / 2) && !same(m.left, box.left);
  };
  const mediaKind = (b: EdgeBlockV3): boolean => b.kind === 'media' || (b.kind === 'surface' && b.role !== 'table' && !holdsControl(b));
  const blocks = measured.filter((b) => {
    if (b.role === 'placeholder') return leadsARow(b);
    if (b.kind === 'media' && centredInContainer(b)) return false;
    return true;
  });

  // A surface that bleeds to the card's own edge (x0, full width): its outer edge is the card's, not a content edge,
  // so it is compared by its content edge alone (the design lead, c.6263664713: the root's content edge against every
  // bleeding surface's content).
  const bleeds = (b: EdgeBlockV3): boolean => b.kind === 'surface' && containerOf(b) === CARD && b.left <= EDGE_TOLERANCE_PX && b.right >= opts.cardContent.right - EDGE_TOLERANCE_PX;
  // v3 change 1 (rule 6): a bleed is judged by its content's own edge; one with no non-centred text keeps its padding box.
  const judged = blocks.map((b): EdgeBlockV3 => {
    if (!bleeds(b)) return b;
    const c = contentEdge(b, blocks);
    if (c !== undefined) return { ...b, edge: c };
    return b.contentLeft !== undefined ? { ...b, edge: b.contentLeft } : b;
  });
  // Rule 2, trailing: a block alone on its line that ends on its container's right content edge is right-anchored.
  // A trailing item trails: it starts in the right half of its container's content box, and is never a bleed.
  const rightAnchored = (b: EdgeBlockV3): boolean => {
    const box = contentBoxOf(containerOf(b));
    const ends = (r: number | undefined): boolean => r !== undefined && same(b.right, r);
    return (ends(box?.right) || ends(b.parentRight)) && box !== undefined && b.left >= (box.left + box.right) / 2 && !bleeds(b);
  };
  const offsets: EdgeOffsetV3[] = [];
  const containers = [CARD, ...judged.filter((b) => b.kind === 'surface' && b.role !== 'table').map((b) => b.id)];
  for (const container of containers) {
    const inContainer = judged.filter((b) => containerOf(b) === container);
    // The container's own column: its blocks that lead (or are not in) a row, less right-anchored trailing items.
    const direct = inContainer.filter((b) => !follower(b) && !rightAnchored(b));
    for (const col of columns(direct)) {
      // Rule 4: media alone in its column, centred in its container, may centre (the design lead, c.6282971546). A
      // lone block of any kind passes its own column; this only exempts the media from its NEIGHBOURS' column, which
      // is how a centred cover beside or above edge-aligned text reaches a column at all.
      const only = col.length === 1 ? col[0]! : undefined;
      if (only !== undefined && mediaKind(only) && aloneOnItsLine(only) && centredInContainer(only)) continue;
      offsets.push(...checkColumn(container, col, judged));
    }
    // Each row item after a leader is its own column group, measured among its own blocks.
    const items = new Map<string, EdgeBlockV3[]>();
    for (const b of inContainer.filter(follower)) items.set(b.item ?? b.id, [...(items.get(b.item ?? b.id) ?? []), b]);
    for (const [item, group] of items) for (const col of columns(group)) offsets.push(...checkColumn(`${container} › ${item}`, col, judged));
  }
  const lost = opts.unpainted !== undefined && opts.unpainted.length > 0
    ? ` | painting nothing under v3 though v2 counted it: ${opts.unpainted.map((u) => `${u.id} (v2: ${u.v2}; ${u.paint})`).join(' | ')}`
    : '';
  if (offsets.length === 0) return { verdict: 'pass', offsets, evidence: `every column shares its content edge, every row item after its leader shares its own, within 2 px${lost}` };
  const worst = offsets.reduce((a, b) => (b.offPx > a.offPx ? b : a));
  const paintOf = (container: string): string => {
    const surface = byId.get(container.split(' › ')[0]!);
    return surface?.paint !== undefined ? `; it ${surface.paint}` : '';
  };
  const lines = offsets.map((o) => `${o.block} at x${round(o.at)} (its ${o.from}) is ${round(o.offPx)} px from x${round(o.nearest)} (in ${o.container}${paintOf(o.container)}${o.reason !== undefined ? `; ${o.reason}` : ''})`);
  return { verdict: 'fail', offsets, evidence: `${offsets.length} block(s) off the allowed edges, largest ${round(worst.offPx)} px: ${lines.join('; ')}${lost}` };
}
const round = (n: number): string => (Math.round(n * 10) / 10).toString();
