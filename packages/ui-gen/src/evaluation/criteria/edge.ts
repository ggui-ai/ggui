/**
 * `space.edge` as an instrument (#1663): the alignment rule applied to measured blocks, never to a model's estimate.
 *
 * The rule (docs/design/direction/visual-criteria.md, "The edge rule, measurable"): in each column of a card, the things
 * that stack start on one edge. A block may start in only two other places — inside a box, on the box's inner edge,
 * which everything inside the box then shares; or next to a box or a band, on the box's own outer edge or on the edge
 * of the text inside it. Same edge means within 2 px. A card fails if any captured width fails; this function judges one
 * width.
 *
 * Levels that are allowed: a hanging marker (a block with two edges, the marker's and its text's); a list inside
 * running text (list items share an edge of their own); a table (measured at its rule, its cells not re-checked);
 * columns side by side (each with its own edge); a centred group (one centre axis). A frame that shows only loading
 * placeholders is not evaluated.
 *
 * Input is the measured block list (a DOM probe at capture produces it); output is the verdict plus every offset in
 * px, so a near miss reads apart from a split. This module measures nothing itself. *
 * **Validated instrument (#1663, 2026-10-02):** this file as of `cec465319` (with `7bb4da13e`) passed a fresh sealed
 * blind draw at the registered bar (27/30, κ 0.76), stricter than the design lead's reading on its disagreements. Any
 * later change to what this file measures or decides is a new instrument until another fresh sealed draw.
 */

/** The rule's tolerance: two edges within this many px are the same edge. */
export const EDGE_TOLERANCE_PX = 2;

/** One block of a captured card, at one canvas width. All x in CSS px from the card's left. */
export interface EdgeBlock {
  /** A stable label for evidence (a DOM path in production, a name in tests). */
  readonly id: string;
  /** A text block, a control group (measured at its first control), or a surface (a box: border or its own fill). */
  readonly kind: 'text' | 'controls' | 'surface';
  /**
   * The block's edge: a text's first-character origin, a bounded control's or a surface's border box, an unbounded
   * control's text. For a hanging marker, the marker's edge.
   */
  readonly edge: number;
  /** Horizontal extent, for telling side-by-side columns apart. */
  readonly left: number;
  readonly right: number;
  /** Vertical position, for finding a surface's first text. */
  readonly top: number;
  /** The surface this block sits inside, by id; absent at the card's own level. */
  readonly within?: string;
  /** A hanging marker's text edge: what stacks with the block may line up with this or with `edge`. */
  readonly textEdge?: number;
  /** Structure the DOM names: a list item, a table (measured at its rule), a member of a centred group. */
  readonly role?: 'list-item' | 'table' | 'centred' | 'placeholder';
}

export interface EdgeOffset {
  /** The container checked: the card, or a surface's id. */
  readonly container: string;
  /** The block that sits off every allowed edge. */
  readonly block: string;
  /** Its edge, and the nearest edge the rule allowed it, in px. */
  readonly at: number;
  readonly nearest: number;
  readonly offPx: number;
  /** Why the block is off when it is not plain distance (a centred block among edge-aligned ones). */
  readonly reason?: string;
}

export interface EdgeVerdict {
  readonly verdict: 'pass' | 'fail' | 'n/a';
  /** Every block that sits off the allowed edges, with its offset; empty on a pass. */
  readonly offsets: readonly EdgeOffset[];
  readonly evidence: string;
}

const CARD = 'card';
const same = (a: number, b: number): boolean => Math.abs(a - b) <= EDGE_TOLERANCE_PX;
const overlaps = (a: EdgeBlock, b: EdgeBlock): boolean => a.left < b.right && b.left < a.right;
const axis = (b: EdgeBlock): number => (b.left + b.right) / 2;

/** A surface's content edge: where its first text starts (its topmost text block's edge), or undefined if it has none. */
function contentEdge(surface: EdgeBlock, blocks: readonly EdgeBlock[]): number | undefined {
  const texts = blocks.filter((b) => b.within === surface.id && b.kind !== 'surface' && b.role !== 'centred');
  if (texts.length === 0) return undefined;
  const first = texts.reduce((a, b) => (b.top < a.top ? b : a));
  return first.textEdge ?? first.edge;
}

/** Columns among a container's direct blocks: non-surface blocks that overlap horizontally, transitively. */
function columns(direct: readonly EdgeBlock[]): EdgeBlock[][] {
  const all = direct.filter((b) => b.kind !== 'surface');
  // A block that spans two columns side by side (it overlaps two blocks that do not overlap each other) belongs to
  // their parent column, never to either (decided 2026-10-02): it must not chain them into one.
  const bridges = (b: EdgeBlock): boolean => {
    const under = all.filter((x) => x !== b && overlaps(x, b));
    return under.some((x, i) => under.slice(i + 1).some((y) => !overlaps(x, y)));
  };
  const flow = all.filter((b) => !bridges(b));
  const parentPool: EdgeBlock[] = all.filter((b) => bridges(b));
  const parent = flow.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < flow.length; i += 1) for (let j = i + 1; j < flow.length; j += 1) if (overlaps(flow[i]!, flow[j]!)) parent[find(i)] = find(j);
  const groups = new Map<number, EdgeBlock[]>();
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
  const lgroups = new Map<number, EdgeBlock[]>();
  parentPool.forEach((b, i) => lgroups.set(lfind(i), [...(lgroups.get(lfind(i)) ?? []), b]));
  cols.push(...lgroups.values());
  return cols;
}

/** One column's check: one edge, or a stacked surface's content edge (the surface is then a ground). */
function checkColumn(container: string, col: readonly EdgeBlock[], blocks: readonly EdgeBlock[]): EdgeOffset[] {
  const surfaces = col.filter((b) => b.kind === 'surface');
  const grounds = surfaces.flatMap((s) => {
    const c = s.role === 'table' ? undefined : contentEdge(s, blocks);
    return c === undefined ? [] : [c];
  });
  const flow = col.filter((b) => b.kind !== 'surface' && b.role !== 'centred' && b.role !== 'list-item');
  const listItems = col.filter((b) => b.role === 'list-item');
  // Every edge a flow block or a surface offers; the common edge E must sit on one of them.
  const candidates = [...flow.flatMap((b) => [b.edge, ...(b.textEdge !== undefined ? [b.textEdge] : [])]), ...surfaces.flatMap((s) => [s.edge]), ...grounds];
  const blockEdges = (b: EdgeBlock): number[] => [b.edge, ...(b.textEdge !== undefined ? [b.textEdge] : [])];
  // The end edges another block of the column offers: its boxes' and its other control sets'.
  const endEdgesBesides = (b: EdgeBlock): number[] => [...surfaces.map((s) => s.right), ...flow.filter((x) => x !== b && x.kind === 'controls').map((x) => x.right)];
  // A column of only list items or only a centred group has no common edge to find; their own checks below still run.
  let best: EdgeOffset[] | null = candidates.length === 0 ? [] : null;
  for (const E of candidates) {
    const allowed = [E, ...grounds];
    const off: EdgeOffset[] = [];
    for (const b of flow) {
      if (blockEdges(b).some((x) => allowed.some((a) => same(x, a)))) continue;
      // A control set alone on its line may END on the end edge its column's boxes or other controls share.
      if (b.kind === 'controls' && endEdgesBesides(b).some((r) => same(b.right, r))) continue;
      const nearest = allowed.reduce((n, a) => (Math.abs(a - b.edge) < Math.abs(n - b.edge) ? a : n));
      off.push({ container, block: b.id, at: b.edge, nearest, offPx: Math.abs(b.edge - nearest) });
    }
    for (const s of surfaces) {
      const c = s.role === 'table' ? undefined : contentEdge(s, blocks);
      if (same(s.edge, E) || (c !== undefined && same(c, E))) continue;
      const nearest = c !== undefined && Math.abs(c - E) < Math.abs(s.edge - E) ? c : s.edge;
      off.push({ container, block: s.id, at: nearest, nearest: E, offPx: Math.abs(nearest - E) });
    }
    if (best === null || off.length < best.length || (off.length === best.length && sum(off) < sum(best))) best = off;
    if (best.length === 0) break;
  }
  const offsets = best ?? [];
  // A list inside running text: its items share an edge of their own.
  if (listItems.length > 1) {
    const e0 = listItems[0]!.edge;
    for (const li of listItems.slice(1)) if (!same(li.edge, e0)) offsets.push({ container, block: li.id, at: li.edge, nearest: e0, offPx: Math.abs(li.edge - e0) });
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
    for (const c of centred) offsets.push({ container, block: c.id, at: c.edge, nearest: E, offPx: Math.abs(c.edge - E), reason: 'a centred block in an edge-aligned column' });
  } else if (centred.length > 1) {
    const a0 = axis(centred[0]!);
    for (const c of centred.slice(1)) if (!same(axis(c), a0)) offsets.push({ container, block: c.id, at: axis(c), nearest: a0, offPx: Math.abs(axis(c) - a0) });
  }
  return offsets;
}
const sum = (o: readonly EdgeOffset[]): number => o.reduce((s, x) => s + x.offPx, 0);

/**
 * Judge one captured width. `placeholdersOnly`: the frame shows only loading placeholders, so the row is not evaluated.
 */
export function judgeEdges(measured: readonly EdgeBlock[], opts: { readonly placeholdersOnly?: boolean } = {}): EdgeVerdict {
  if (opts.placeholdersOnly === true) return { verdict: 'n/a', offsets: [], evidence: 'only loading placeholders are shown; not evaluated' };
  let blocks = measured;
  // A placeholder (a box with nothing in it, shown while content loads) is not a block, and the rule needs two blocks to
  // compare: with fewer than two once placeholders are set aside, the frame is not evaluated (decided 2026-10-02).
  // The two blocks are content, text or controls: a box holds them and is not one of them for this count.
  const kept = blocks.filter((b) => b.role !== 'placeholder');
  const content = kept.filter((b) => b.kind !== 'surface').length;
  if (content < 2) return { verdict: 'n/a', offsets: [], evidence: kept.length === 0 ? 'no blocks were measured' : 'fewer than two blocks once placeholders are set aside; not evaluated' };
  blocks = kept;
  const offsets: EdgeOffset[] = [];
  const containers = [CARD, ...blocks.filter((b) => b.kind === 'surface' && b.role !== 'table').map((b) => b.id)];
  for (const container of containers) {
    const direct = blocks.filter((b) => (b.within ?? CARD) === container);
    for (const col of columns(direct)) offsets.push(...checkColumn(container, col, blocks));
  }
  if (offsets.length === 0) return { verdict: 'pass', offsets, evidence: 'every column shares its edge, or sits on a stacked surface’s content edge, within 2 px' };
  const worst = offsets.reduce((a, b) => (b.offPx > a.offPx ? b : a));
  const lines = offsets.map((o) => `${o.block} at x${round(o.at)} is ${round(o.offPx)} px from x${round(o.nearest)} (in ${o.container}${o.reason !== undefined ? `; ${o.reason}` : ''})`);
  return { verdict: 'fail', offsets, evidence: `${offsets.length} block(s) off the allowed edges, largest ${round(worst.offPx)} px: ${lines.join('; ')}` };
}
const round = (n: number): string => (Math.round(n * 10) / 10).toString();
