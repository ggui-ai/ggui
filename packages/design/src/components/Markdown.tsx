import type { CSSProperties, ReactNode } from 'react';
import {
  parseInlineRichText,
  parseRichText,
  type RichTextBlock,
  type RichTextInline,
} from '../richtext';
import { Heading } from '../primitives/Heading';
import { Text } from '../primitives/Text';
import { Link } from '../primitives/Link';
import type { MarkdownProps, MarkdownInlineProps } from './types';

export type { MarkdownProps, MarkdownInlineProps } from './types';

/**
 * Markdown — agent-authored rich text inside a generated UI.
 *
 * Renders the conversational markdown subset through the design
 * system's own rich-text model (`../richtext` — ggui-owned; the
 * MCP-native interface layer deliberately carries no dependency on
 * agent-framework projects). The parse + safety policy live there,
 * once: raw HTML has no AST node so it can only ever display as
 * literal text, and `href` is populated only for allowlisted schemes.
 * This component maps the AST onto the design system's primitives;
 * every string lands as React text children (never markup), so
 * nothing here can widen the policy.
 *
 * Streaming-tolerant by construction: any prefix of a longer input
 * parses to a stable AST (unclosed constructs carry `closed: false`
 * and render with their partial content) — re-render with a growing
 * `markdown` on each delta and completed constructs never change shape.
 *
 * Chat transcripts deliberately do NOT use this — chat text stays
 * plain (see the SDK docs); rich presentation belongs to generated
 * interfaces like the surface this component serves.
 *
 * `MarkdownProps` lives in `components/types.ts` — the types files
 * drive the JSDoc → LLM prompt docs, so its docstring THERE is what
 * the generation model reads (promoted in ggui#424 slice 3,
 * benchmark-gated).
 */

const CODE_INLINE: CSSProperties = {
  fontFamily: 'var(--ggui-font-family-mono, ui-monospace, monospace)',
  fontSize: '0.9em',
  background: 'var(--ggui-color-surface-sunken, rgba(0,0,0,0.06))',
  borderRadius: 'var(--ggui-radius-sm, 4px)',
  padding: '0.1em 0.35em',
};

const CODE_FENCE: CSSProperties = {
  fontFamily: 'var(--ggui-font-family-mono, ui-monospace, monospace)',
  fontSize: 'var(--ggui-font-size-sm, 14px)',
  background: 'var(--ggui-color-surface-sunken, rgba(0,0,0,0.06))',
  borderRadius: 'var(--ggui-radius-md, 8px)',
  padding: 'var(--ggui-spacing-sm, 12px)',
  overflowX: 'auto',
  whiteSpace: 'pre',
  margin: 0,
};

/** Link-styled but inert — the scheme failed richtext's allowlist. */
const LINK_INERT: CSSProperties = {
  color: 'var(--ggui-color-primary, #4f46e5)',
  textDecoration: 'none',
};

const LIST: CSSProperties = {
  margin: 0,
  paddingInlineStart: 'var(--ggui-spacing-lg, 24px)',
};

/** A wide table scrolls inside its own box; the surrounding column never widens. */
const TABLE_SCROLL: CSSProperties = { overflowX: 'auto' };

const TABLE: CSSProperties = {
  borderCollapse: 'collapse',
  width: '100%',
  fontSize: 'var(--ggui-font-size-sm, 14px)',
};

const TABLE_CELL: CSSProperties = {
  padding: 'var(--ggui-spacing-xs, 6px) var(--ggui-spacing-sm, 12px)',
  borderBottom: '1px solid var(--ggui-color-outline, rgba(0,0,0,0.15))',
  verticalAlign: 'top',
  textAlign: 'left',
};

const TABLE_HEADER_CELL: CSSProperties = {
  ...TABLE_CELL,
  fontWeight: 'var(--ggui-font-weight-semibold, 600)',
  background: 'var(--ggui-color-surface-sunken, rgba(0,0,0,0.06))',
};

/**
 * Render a run of rich-text inline nodes to React children.
 *
 * Exported for hosts that own their block structure and only need the
 * inline subset — the A2UI provisional renderer feeds
 * `parseInlineRichText(component.text)` through this inside its
 * variant-mapped `Text`/`Heading`, since an A2UI Text component's
 * block level comes from `variant`, not from `#` syntax.
 */
export function renderRichTextInlines(inlines: RichTextInline[]): ReactNode[] {
  return inlines.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'break':
        return <br key={i} />;
      case 'strong':
        return <strong key={i}>{renderRichTextInlines(node.children)}</strong>;
      case 'em':
        return <em key={i}>{renderRichTextInlines(node.children)}</em>;
      case 'code':
        return (
          <code key={i} style={CODE_INLINE}>
            {node.code}
          </code>
        );
      case 'link': {
        const children = renderRichTextInlines(node.children);
        // `href` is the ONLY navigable field (scheme-allowlisted by
        // richtext); rejected targets render link-styled but inert —
        // `rawHref` is audit-only and must never reach the DOM.
        return node.href !== undefined ? (
          <Link key={i} href={node.href} external>
            {children}
          </Link>
        ) : (
          <span key={i} style={LINK_INERT}>
            {children}
          </span>
        );
      }
      default: {
        // A new inline kind is a compile error here, never silent text loss.
        const _exhaustive: never = node;
        return _exhaustive;
      }
    }
  });
}

function renderBlock(block: RichTextBlock, key: number): ReactNode {
  switch (block.type) {
    case 'paragraph':
      return <Text key={key}>{renderRichTextInlines(block.children)}</Text>;
    case 'heading':
      return (
        <Heading key={key} level={block.level}>
          {renderRichTextInlines(block.children)}
        </Heading>
      );
    case 'code-fence':
      return (
        <pre key={key} style={CODE_FENCE} data-lang={block.lang}>
          <code>{block.code}</code>
        </pre>
      );
    case 'list': {
      const items = block.items.map((item, i) => (
        <li key={i}>{renderRichTextInlines(item.children)}</li>
      ));
      return block.ordered ? (
        <ol key={key} start={block.start} style={LIST}>
          {items}
        </ol>
      ) : (
        <ul key={key} style={LIST}>
          {items}
        </ul>
      );
    }
    case 'table': {
      // Column alignment comes from the delimiter row; unaligned columns
      // keep the base (left) so header and body line up.
      const aligned = (base: CSSProperties, col: number): CSSProperties => {
        const align = block.align[col];
        return align === undefined ? base : { ...base, textAlign: align };
      };
      return (
        <div key={key} style={TABLE_SCROLL}>
          <table style={TABLE}>
            <thead>
              <tr>
                {block.header.cells.map((cell, c) => (
                  <th key={c} scope="col" style={aligned(TABLE_HEADER_CELL, c)}>
                    {renderRichTextInlines(cell.children)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, r) => (
                <tr key={r}>
                  {row.cells.map((cell, c) => (
                    <td key={c} style={aligned(TABLE_CELL, c)}>
                      {renderRichTextInlines(cell.children)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    default: {
      // A new block kind is a compile error here, never a block that renders as nothing.
      const _exhaustive: never = block;
      return _exhaustive;
    }
  }
}

export function Markdown({ markdown, className, style }: MarkdownProps) {
  const blocks = parseRichText(markdown);
  return (
    <div
      className={className}
      data-ggui-markdown=""
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 'var(--ggui-spacing-sm, 12px)',
        ...style,
      }}
    >
      {blocks.map(renderBlock)}
    </div>
  );
}

/**
 * Inline-only markdown: parse + render a single run with no block
 * structure. For hosts that already own the block element — the A2UI
 * provisional renderer mounts this inside its variant-mapped
 * `Text`/`Heading` (an A2UI Text component's block level comes from
 * `variant`, not from `#` syntax).
 */
export function MarkdownInline({ markdown }: MarkdownInlineProps) {
  return <>{renderRichTextInlines(parseInlineRichText(markdown))}</>;
}
