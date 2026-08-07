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
 * `text` on each delta and completed constructs never change shape.
 *
 * Chat transcripts deliberately do NOT use this — chat text stays
 * plain (see the SDK docs); rich presentation belongs to generated
 * interfaces like the surface this component serves.
 *
 * Generation-triad gating: `MarkdownProps` intentionally lives HERE,
 * not in `components/types.ts` — the types files drive the JSDoc →
 * LLM prompt docs, so the model is not yet told to reach for this
 * component (the auto-generated validator allowlist does include it,
 * which is harmless). Promoting it into the prompt docs is the
 * benchmark-gated triad slice (ggui#424 slice 3); do not move the
 * props type before running that slice's benchmarks.
 */
export interface MarkdownProps {
  /**
   * Markdown source — the conversational subset (bold / italic /
   * inline code / fenced code blocks / lists / headings / links).
   * May be a mid-stream prefix; parsing fails soft. Raw HTML displays
   * as literal text, never markup.
   */
  markdown: string;
  className?: string;
  style?: CSSProperties;
}

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
export function MarkdownInline({ markdown }: { markdown: string }) {
  return <>{renderRichTextInlines(parseInlineRichText(markdown))}</>;
}
