/**
 * RichTextInlines — RN renderer for the design system's rich-text
 * INLINE subset (`@ggui-ai/design/richtext` — ggui-owned, headless,
 * DOM-free). Twin-in-spirit of the web `renderRichTextInlines`: the
 * parse + safety policy live in that one module (raw HTML has no AST
 * node; `href` is populated only for allowlisted schemes), and every
 * string lands as RN `<Text>` children — never markup.
 *
 * Preview-internal: the provisional renderer mounts this inside its
 * variant-mapped `<Text>` (an A2UI Text component's block level comes
 * from `variant`, not `#` syntax). The provisional preview is
 * non-interactive by design, so links render link-styled but never
 * navigate — the real interactive render arrives via `<McpAppIframe>`.
 *
 * Streaming-safe: prefixes parse to stable ASTs (unclosed constructs
 * carry their partial content), so re-emitting a longer `text` only
 * extends the tail.
 */
import React from 'react';
import { Text, type StyleProp, type TextStyle } from 'react-native';
import { parseInlineRichText, type RichTextInline } from '@ggui-ai/design/richtext';

const STYLES: Record<string, StyleProp<TextStyle>> = {
  strong: { fontWeight: 'bold' },
  em: { fontStyle: 'italic' },
  code: {
    fontFamily: 'Menlo',
    fontSize: 13,
    backgroundColor: 'rgba(0,0,0,0.06)',
  },
  // Link-styled, never navigable here (non-interactive preview).
  link: { color: '#4f46e5', textDecorationLine: 'underline' },
};

function renderNodes(inlines: RichTextInline[]): React.ReactNode[] {
  return inlines.map((node, i) => {
    switch (node.type) {
      case 'text':
        return node.text;
      case 'break':
        return '\n';
      case 'strong':
        return (
          <Text key={i} style={STYLES.strong}>
            {renderNodes(node.children)}
          </Text>
        );
      case 'em':
        return (
          <Text key={i} style={STYLES.em}>
            {renderNodes(node.children)}
          </Text>
        );
      case 'code':
        return (
          <Text key={i} style={STYLES.code}>
            {node.code}
          </Text>
        );
      case 'link':
        // `rawHref` is audit-only; nothing here navigates either way.
        return (
          <Text key={i} style={STYLES.link}>
            {renderNodes(node.children)}
          </Text>
        );
    }
  });
}

export function RichTextInlines({ markdown }: { markdown: string }): React.JSX.Element {
  return <>{renderNodes(parseInlineRichText(markdown))}</>;
}
