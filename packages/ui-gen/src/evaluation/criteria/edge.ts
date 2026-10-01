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
 * px, so a near miss reads apart from a split. This module measures nothing itself.
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
  readonly role?: 'list-item' | 'table' | 'centred';
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
  const flow = direct.filter((b) => b.kind !== 'surface');
  const parent = flow.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let i = 0; i < flow.length; i += 1) for (let j = i + 1; j < flow.length; j += 1) if (overlaps(flow[i]!, flow[j]!)) parent[find(i)] = find(j);
  const groups = new Map<number, EdgeBlock[]>();
  flow.forEach((b, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), b]));
  const cols = [...groups.values()];
  // A surface joins every column it overlaps (a band over two side-by-side columns is a ground for both); one that
  // overlaps none stands as a column of its own.
  for (const s of direct.filter((b) => b.kind === 'surface')) {
    const hit = cols.filter((c) => c.some((b) => overlaps(b, s)));
    if (hit.length === 0) cols.push([s]);
    else for (const c of hit) c.push(s);
  }
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
  // A column of only list items or only a centred group has no common edge to find; their own checks below still run.
  let best: EdgeOffset[] | null = candidates.length === 0 ? [] : null;
  for (const E of candidates) {
    const allowed = [E, ...grounds];
    const off: EdgeOffset[] = [];
    for (const b of flow) {
      if (blockEdges(b).some((x) => allowed.some((a) => same(x, a)))) continue;
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
  // A centred group: its members share one centre axis.
  const centred = col.filter((b) => b.role === 'centred');
  if (centred.length > 1) {
    const a0 = axis(centred[0]!);
    for (const c of centred.slice(1)) if (!same(axis(c), a0)) offsets.push({ container, block: c.id, at: axis(c), nearest: a0, offPx: Math.abs(axis(c) - a0) });
  }
  return offsets;
}
const sum = (o: readonly EdgeOffset[]): number => o.reduce((s, x) => s + x.offPx, 0);

/**
 * Judge one captured width. `placeholdersOnly`: the frame shows only loading placeholders, so the row is not evaluated.
 */
export function judgeEdges(blocks: readonly EdgeBlock[], opts: { readonly placeholdersOnly?: boolean } = {}): EdgeVerdict {
  if (opts.placeholdersOnly === true) return { verdict: 'n/a', offsets: [], evidence: 'only loading placeholders are shown; not evaluated' };
  if (blocks.length === 0) return { verdict: 'n/a', offsets: [], evidence: 'no blocks were measured' };
  const offsets: EdgeOffset[] = [];
  const containers = [CARD, ...blocks.filter((b) => b.kind === 'surface' && b.role !== 'table').map((b) => b.id)];
  for (const container of containers) {
    const direct = blocks.filter((b) => (b.within ?? CARD) === container);
    for (const col of columns(direct)) offsets.push(...checkColumn(container, col, blocks));
  }
  if (offsets.length === 0) return { verdict: 'pass', offsets, evidence: 'every column shares its edge, or sits on a stacked surface’s content edge, within 2 px' };
  const worst = offsets.reduce((a, b) => (b.offPx > a.offPx ? b : a));
  const lines = offsets.map((o) => `${o.block} at x${round(o.at)} is ${round(o.offPx)} px from x${round(o.nearest)} (in ${o.container})`);
  return { verdict: 'fail', offsets, evidence: `${offsets.length} block(s) off the allowed edges, largest ${round(worst.offPx)} px: ${lines.join('; ')}` };
}
const round = (n: number): string => (Math.round(n * 10) / 10).toString();
