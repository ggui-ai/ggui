/**
 * Rich-text block model for agent-authored text inside generated UIs.
 *
 * Agents emit markdown (`**bold**`, lists, headings); this module owns
 * ggui's answer to "what does that text MEAN to a renderer" — a typed
 * block/inline AST for the conversational subset, with the safety
 * policy built into the parse:
 *
 *  - Raw HTML is NEVER interpreted — no HTML node type exists in the
 *    AST, so `<script>` in model output can only ever be literal text.
 *  - Link `href` is populated ONLY for http/https/mailto targets;
 *    everything else (javascript:, data:, relative paths) parses as a
 *    link whose `href` is `undefined` — styled text, nothing navigable.
 *  - STREAMING-TOLERANT: any prefix of a longer input parses without
 *    throwing to a stable AST that fails SOFT — unclosed constructs
 *    carry `closed: false` and their partial content; completed
 *    constructs never change shape as more input arrives.
 *
 * Rendering rule for consumers: every string in this AST (`text`,
 * `code`) is literal content — render as text children, NEVER markup.
 *
 * Deliberately OUT of the v1 subset (parse as plain text): images,
 * tables, blockquotes, strikethrough, autolinked bare URLs, nested
 * lists, block content inside list items, setext headings. ggui owns
 * this subset's evolution — extend HERE (with tests) as generated-UI
 * surfaces need more, independent of any upstream.
 *
 * Forked from `@silverprotocol/richtext` 0.4.1 (MIT — Copyright (c)
 * silverprotocol contributors; see the MIT license text in that
 * package). Vendored so the MCP-native interface layer carries no
 * dependency on agent-framework-normalization projects; the two
 * subsets may diverge deliberately from here.
 */
/** Inline content. `closed: false` marks a construct still open mid-stream. */
export type RichTextInline =
  | { type: "text"; text: string }
  /** Explicit line break — a single newline inside a paragraph/heading/item.
   *  Chat prose is line-broken; hosts map this to <br/> / "\n", never a space. */
  | { type: "break" }
  | { type: "strong"; children: RichTextInline[]; closed: boolean }
  | { type: "em"; children: RichTextInline[]; closed: boolean }
  | { type: "code"; code: string; closed: boolean }
  | {
      type: "link";
      children: RichTextInline[];
      /**
       * The navigable target — populated ONLY when the written target passed
       * the scheme allowlist (http:, https:, mailto:). `undefined` means
       * "style as a link if you like, but there is nothing safe to open".
       */
      href: string | undefined;
      /**
       * The target VERBATIM as written (lossless — may be a partial mid-stream
       * fragment or a rejected scheme). NEVER navigate to this; it exists for
       * audit/debug display only. `href` is the only navigable field.
       */
      rawHref: string;
      closed: boolean;
    };

export type RichTextListItem = { children: RichTextInline[] };

/** Block content. Order is the render order. */
export type RichTextBlock =
  | { type: "paragraph"; children: RichTextInline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: RichTextInline[] }
  | {
      type: "code-fence";
      code: string;
      /** The info string's first word (```ts → "ts"), if any. */
      lang: string | undefined;
      closed: boolean;
    }
  | {
      type: "list";
      ordered: boolean;
      /** First item's number for an ordered list (1. / 3. …), else undefined. */
      start: number | undefined;
      items: RichTextListItem[];
    };

// ─── safety policy: link scheme allowlist ─────────────────────────────────────

// http/https/mailto ONLY. Case-insensitive; whitespace and control characters
// in the written target disqualify rather than get cleaned (a target that
// needs cleaning is not a target the model wrote cleanly).
// eslint-disable-next-line no-control-regex -- rejecting control chars in hrefs is the security intent, not an accident
const SAFE_HREF = /^(?:https?:\/\/|mailto:)[^\s\x00-\x1f]+$/i;

/** The one place the navigable-target decision is made (workspace#8 policy). */
function safeHref(raw: string): string | undefined {
  return SAFE_HREF.test(raw) ? raw : undefined;
}

// ─── inline parser ────────────────────────────────────────────────────────────
// Recursive descent with an explicit closer stack. `closers` is innermost-
// first; a delimiter that matches ANY active closer unwinds to that frame —
// the frames it skips over close as `closed: false` (fail-soft: `**a *b** c`
// closes the strong; the dangling em inside it stays open-but-stable).

type Closer = "**" | "__" | "*" | "_" | "]";

interface InlineResult {
  children: RichTextInline[];
  /** Index into `closers` of the OUTERMOST frame the ending delimiter run closed, or -1 for end-of-input. */
  closedBy: number;
  /**
   * Every `closers` index the run closed (a *** run can close an em AND its
   * strong at once) — each unwind level reads its own frame's flag from here.
   */
  closedIdxs: ReadonlySet<number>;
  /** Run characters consumed by those closes — the outermost consumer advances past them. */
  runConsumed: number;
  pos: number;
}

/** Shift a closer-index set down one stack level (drop this frame's own slot). */
function shiftIdxs(idxs: ReadonlySet<number>): Set<number> {
  const out = new Set<number>();
  for (const i of idxs) if (i > 0) out.add(i - 1);
  return out;
}

function isWs(ch: string | undefined): boolean {
  return ch === undefined || ch === " " || ch === "\t" || ch === "\n";
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

// Flanking rules — the pragmatic subset of CommonMark's:
//  *  opens when followed by non-space; closes when preceded by non-space.
//  _  additionally must sit at a word BOUNDARY on its outer side, so
//     snake_case_identifiers in prose never italicize (the reason CommonMark
//     has the rule; agents emit identifiers constantly).
function canOpen(marker: Closer, prev: string | undefined, next: string | undefined): boolean {
  if (isWs(next)) return false;
  if (marker === "_" || marker === "__") return !isWordChar(prev);
  return true;
}
function canClose(marker: Closer, prev: string | undefined, next: string | undefined): boolean {
  if (isWs(prev)) return false;
  if (marker === "_" || marker === "__") return !isWordChar(next);
  return true;
}

// Backslash escapes: exactly ASCII punctuation (CommonMark's set) — `\*` is a
// literal asterisk; `\n` (the letter n) is just "\" + "n".
const ESCAPABLE = new Set("!\"#$%&'()*+,-./:;<=>?@[\\]^_`{|}~");

function parseInlineFrom(src: string, start: number, closers: Closer[]): InlineResult {
  const children: RichTextInline[] = [];
  let buf = "";
  const flush = (): void => {
    if (buf.length > 0) {
      children.push({ type: "text", text: buf });
      buf = "";
    }
  };

  let pos = start;
  while (pos < src.length) {
    const ch = src[pos];
    if (ch === undefined) break;

    // Backslash escape.
    if (ch === "\\") {
      const next = src[pos + 1];
      if (next !== undefined && ESCAPABLE.has(next)) {
        buf += next;
        pos += 2;
        continue;
      }
      buf += ch;
      pos += 1;
      continue;
    }

    // Explicit line break (paragraph lines are joined with "\n" upstream).
    if (ch === "\n") {
      flush();
      children.push({ type: "break" });
      pos += 1;
      continue;
    }

    // Inline code span — verbatim until the closing backtick (newlines
    // included: a span the stream hasn't closed yet swallows softly, and a
    // genuine multi-line span renders fine under code styling). No nested
    // markdown inside.
    if (ch === "`") {
      flush();
      const end = src.indexOf("`", pos + 1);
      if (end === -1) {
        children.push({ type: "code", code: src.slice(pos + 1), closed: false });
        pos = src.length;
        continue;
      }
      children.push({ type: "code", code: src.slice(pos + 1, end), closed: true });
      pos = end + 1;
      continue;
    }

    // Emphasis delimiters. Closing is checked BEFORE opening so `**bold**`'s
    // second ** seals rather than re-opens.
    if (ch === "*" || ch === "_") {
      const two = src.slice(pos, pos + 2);
      const double: Closer | undefined = two === "**" || two === "__" ? (two as Closer) : undefined;
      const single = ch as Closer;
      const prev = pos > 0 ? src[pos - 1] : undefined;

      // Measure the whole delimiter run, then walk the open frames OUTERMOST-
      // first (link brackets bound the walk — emphasis never closes across a
      // `[`), spending the run's characters on every closeable frame: a **
      // run seals the strong (its inner em dangles soft — `**a *b** c`), a
      // *** run seals the em AND the strong. The closure SET rides the unwind
      // so every level marks its own `closed` flag accurately.
      let runLen = 1;
      while (src[pos + runLen] === ch) runLen++;
      const nextAfterRun = src[pos + runLen];
      const bracket = closers.indexOf("]");
      const bound = bracket === -1 ? closers.length - 1 : bracket - 1;
      const closedIdxs = new Set<number>();
      let budget = runLen;
      for (let ci = bound; ci >= 0; ci--) {
        const m = closers[ci];
        if (m === undefined || m[0] !== ch) continue;
        if (m.length > budget) continue;
        if (!canClose(m, prev, nextAfterRun)) continue;
        closedIdxs.add(ci);
        budget -= m.length;
        if (budget === 0) break;
      }
      if (closedIdxs.size > 0) {
        flush();
        return {
          children,
          closedBy: Math.max(...closedIdxs),
          closedIdxs,
          runConsumed: runLen - budget,
          pos,
        };
      }

      // Opening reads the longest marker (** before *); a double that cannot
      // open stays a literal double, never a half-open single.
      const marker: Closer = double ?? single;
      const next = src[pos + marker.length];
      if (canOpen(marker, prev, next)) {
        flush();
        const inner = parseInlineFrom(src, pos + marker.length, [marker, ...closers]);
        const node: RichTextInline =
          marker === "**" || marker === "__"
            ? { type: "strong", children: inner.children, closed: inner.closedIdxs.has(0) }
            : { type: "em", children: inner.children, closed: inner.closedIdxs.has(0) };
        children.push(node);
        if (inner.closedBy === 0) {
          // This frame is the OUTERMOST one the run closed — consume the
          // run's whole closed span here.
          pos = inner.pos + inner.runConsumed;
          continue;
        }
        if (inner.closedBy === -1) {
          // End of input — everything is flushed; this frame ends open too.
          pos = inner.pos;
          continue;
        }
        // The run reached an OUTER frame: keep unwinding (shift the set past
        // this frame's own stack slot).
        return {
          children,
          closedBy: inner.closedBy - 1,
          closedIdxs: shiftIdxs(inner.closedIdxs),
          runConsumed: inner.runConsumed,
          pos: inner.pos,
        };
      }
      buf += marker;
      pos += marker.length;
      continue;
    }

    // Link: [children](target). `[text]` followed by anything but "(" is the
    // literal bracket text it always was; `[text]` at END of input stays an
    // open link — the "(url)" may still be in flight (fail-soft, documented).
    if (ch === "[") {
      const inner = parseInlineFrom(src, pos + 1, ["]", ...closers]);
      if (inner.closedBy > 0) {
        // An outer delimiter fired inside the bracket — the bracket is literal.
        buf += "[";
        pos += 1;
        continue;
      }
      if (inner.closedBy === -1) {
        // Input ended inside [ … — an open link with no target yet.
        flush();
        children.push({ type: "link", children: inner.children, href: undefined, rawHref: "", closed: false });
        pos = inner.pos;
        continue;
      }
      const afterBracket = inner.pos + 1;
      const paren = src[afterBracket];
      if (paren === "(") {
        const close = src.indexOf(")", afterBracket + 1);
        if (close === -1) {
          // Target still streaming — style the text, expose NO href yet.
          const partial = src.slice(afterBracket + 1);
          flush();
          children.push({ type: "link", children: inner.children, href: undefined, rawHref: partial, closed: false });
          pos = src.length;
          continue;
        }
        // `(url "title")` tolerance: the target is the first whitespace-run-
        // delimited word; anything after it inside the parens is ignored.
        const rawHref = (src.slice(afterBracket + 1, close).trim().split(/\s+/)[0] ?? "");
        flush();
        children.push({ type: "link", children: inner.children, href: safeHref(rawHref), rawHref, closed: true });
        pos = close + 1;
        continue;
      }
      if (paren === undefined) {
        // Input ended exactly at `[text]` — the "(" may still arrive.
        flush();
        children.push({ type: "link", children: inner.children, href: undefined, rawHref: "", closed: false });
        pos = afterBracket;
        continue;
      }
      // `[text]` followed by something else — literal brackets.
      buf += "[";
      pos += 1;
      continue;
    }

    // "]" only matters when a link frame is open.
    if (ch === "]" && closers.includes("]")) {
      const closerIdx = closers.indexOf("]");
      flush();
      return { children, closedBy: closerIdx, closedIdxs: new Set([closerIdx]), runConsumed: 1, pos };
    }

    buf += ch;
    pos += 1;
  }

  flush();
  return { children, closedBy: -1, closedIdxs: new Set(), runConsumed: 0, pos };
}

/**
 * Parse a single run of inline content (no block structure). Useful when a
 * host renders one-line strings (labels, list items it assembled itself).
 */
export function parseInlineRichText(text: string): RichTextInline[] {
  return parseInlineFrom(text, 0, []).children;
}

// ─── block parser ─────────────────────────────────────────────────────────────

const FENCE_OPEN = /^```+\s*(\S*)\s*$/;
const FENCE_CLOSE = /^```+\s*$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
// Leading indent is ACCEPTED and flattened (nested lists are a documented
// future addition, not silent structure loss — the items are all kept, in
// order, in the one open list).
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*(\d{1,9})[.)]\s+(.*)$/;

/**
 * Parse a chat text block into the rich-text AST. Pure and total: any string
 * (including any prefix of a longer one) parses without throwing.
 */
export function parseRichText(text: string): RichTextBlock[] {
  const blocks: RichTextBlock[] = [];
  const lines = text.split("\n");

  // Accumulators for the (single) open block.
  let para: string[] = [];
  let list: { ordered: boolean; start: number | undefined; items: RichTextListItem[] } | undefined;

  const flushPara = (): void => {
    if (para.length > 0) {
      blocks.push({ type: "paragraph", children: parseInlineFrom(para.join("\n"), 0, []).children });
      para = [];
    }
  };
  const flushList = (): void => {
    if (list !== undefined) {
      blocks.push({ type: "list", ordered: list.ordered, start: list.start, items: list.items });
      list = undefined;
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;

    // Fenced code — verbatim until the closing fence (or end of input:
    // closed:false, content-so-far intact).
    const fence = line.match(FENCE_OPEN);
    if (fence !== null) {
      flushPara();
      flushList();
      const lang = fence[1] !== undefined && fence[1].length > 0 ? fence[1] : undefined;
      const body: string[] = [];
      let closed = false;
      let j = i + 1;
      for (; j < lines.length; j++) {
        const l = lines[j];
        if (l !== undefined && FENCE_CLOSE.test(l)) {
          closed = true;
          break;
        }
        body.push(l ?? "");
      }
      blocks.push({ type: "code-fence", code: body.join("\n"), lang, closed });
      i = j;
      continue;
    }

    if (line.trim().length === 0) {
      flushPara();
      flushList();
      continue;
    }

    const heading = line.match(HEADING);
    if (heading !== null && heading[1] !== undefined) {
      flushPara();
      flushList();
      const level = heading[1].length as 1 | 2 | 3 | 4 | 5 | 6;
      blocks.push({ type: "heading", level, children: parseInlineFrom(heading[2] ?? "", 0, []).children });
      continue;
    }

    const ordered = line.match(ORDERED);
    const bullet = ordered === null ? line.match(BULLET) : null;
    if (ordered !== null || bullet !== null) {
      flushPara();
      const isOrdered = ordered !== null;
      const content = (isOrdered ? ordered[2] : bullet?.[1]) ?? "";
      // A same-orderedness item continues the open list; a switch (1. → -)
      // closes it and opens the other kind.
      if (list !== undefined && list.ordered !== isOrdered) flushList();
      if (list === undefined) {
        list = {
          ordered: isOrdered,
          start: isOrdered && ordered[1] !== undefined ? parseInt(ordered[1], 10) : undefined,
          items: [],
        };
      }
      list.items.push({ children: parseInlineFrom(content, 0, []).children });
      continue;
    }

    // Plain prose. A non-bullet line after a list ENDS the list (predictable
    // for chat; lazy continuation is not part of the v1 subset).
    flushList();
    para.push(line);
  }

  flushPara();
  flushList();
  return blocks;
}

export default parseRichText;
