/**
 * Shared shell components, icons, and utilities.
 *
 * These building blocks are used by ChatShell and FullscreenShell to avoid
 * duplication. They are internal to the shells module and not exported
 * from the SDK's public API.
 */

import React from 'react';
import { rgba } from './theme';

/* ── Icons ── */

export function SendIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="22" y1="2" x2="11" y2="13" />
      <polygon points="22 2 15 22 11 13 2 9 22 2" />
    </svg>
  );
}

export function ChatIcon({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

export function ExpandIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 3 21 3 21 9" />
      <polyline points="9 21 3 21 3 15" />
      <line x1="21" y1="3" x2="14" y2="10" />
      <line x1="3" y1="21" x2="10" y2="14" />
    </svg>
  );
}

export function CloseIcon({ size = 16 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

/* ── TypingIndicator ── */

export function TypingIndicator({ r, g, b, compact = false }: { r: number; g: number; b: number; compact?: boolean }) {
  const dotSize = compact ? 6 : 7;
  const gap = compact ? 4 : 5;
  const pad = compact ? '2px 4px' : '4px 6px';
  return (
    <div style={{ display: 'flex', gap, padding: pad }}>
      {[0, 0.2, 0.4].map((delay, i) => (
        <span key={i} style={{
          width: dotSize, height: dotSize, borderRadius: '50%',
          backgroundColor: rgba(r, g, b, 0.5),
          animation: 'ggui-typing-bounce 1.4s infinite ease-in-out',
          animationDelay: `${delay}s`,
        }} />
      ))}
    </div>
  );
}

/* ── ConnectionDot ── */

export function ConnectionDot({ isConnected }: { isConnected: boolean }) {
  return (
    <span style={{
      display: 'inline-block', width: 6, height: 6, borderRadius: '50%',
      backgroundColor: isConnected ? '#22c55e' : '#f59e0b',
      marginRight: 4,
    }} />
  );
}

/* ── Markdown ── */

function processInlineMarkdown(text: string): React.ReactNode[] {
  const inlineRegex = /(\*\*(.+?)\*\*)|(\*(.+?)\*)|(``?([^`]+?)``?)/g;
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  let key = 0;

  while ((match = inlineRegex.exec(text)) !== null) {
    if (match.index > lastIndex) parts.push(text.slice(lastIndex, match.index));
    if (match[1]) {
      parts.push(<strong key={`b${key++}`}>{match[2]}</strong>);
    } else if (match[3]) {
      parts.push(<em key={`i${key++}`}>{match[4]}</em>);
    } else if (match[5]) {
      parts.push(
        <code key={`c${key++}`} style={{
          fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
          backgroundColor: 'rgba(255,255,255,0.1)', padding: '1px 5px', borderRadius: 4, fontSize: '0.9em',
        }}>{match[6]}</code>
      );
    }
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) parts.push(text.slice(lastIndex));
  return parts.length > 0 ? parts : [text];
}

/**
 * Convert a markdown string to React elements.
 * Handles: bold, italic, inline code, code blocks, bullet lists, numbered lists.
 */
export function renderMarkdown(text: string): React.ReactNode {
  if (!text) return null;

  // Split by triple-backtick code blocks first
  const codeBlockRegex = /```(?:\w*)\n?([\s\S]*?)```/g;
  const segments: { type: 'text' | 'codeblock'; content: string }[] = [];
  let lastIdx = 0;
  let cbMatch: RegExpExecArray | null;

  while ((cbMatch = codeBlockRegex.exec(text)) !== null) {
    if (cbMatch.index > lastIdx) segments.push({ type: 'text', content: text.slice(lastIdx, cbMatch.index) });
    segments.push({ type: 'codeblock', content: cbMatch[1] });
    lastIdx = cbMatch.index + cbMatch[0].length;
  }
  if (lastIdx < text.length) segments.push({ type: 'text', content: text.slice(lastIdx) });

  const elements: React.ReactNode[] = [];
  let segKey = 0;

  for (const seg of segments) {
    if (seg.type === 'codeblock') {
      elements.push(
        <pre key={`seg${segKey++}`} style={{
          backgroundColor: '#1e1e1e', color: '#d4d4d4', padding: 12,
          borderRadius: 8, overflowX: 'auto', margin: '8px 0', fontSize: 13, lineHeight: '1.5',
        }}>
          <code>{seg.content}</code>
        </pre>
      );
      continue;
    }

    const lines = seg.content.split('\n');
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // Bullet list
      if (line.startsWith('- ')) {
        const items: React.ReactNode[] = [];
        while (i < lines.length && lines[i].startsWith('- ')) {
          items.push(<li key={`li${segKey++}`}>{processInlineMarkdown(lines[i].slice(2))}</li>);
          i++;
        }
        elements.push(<ul key={`seg${segKey++}`} style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ul>);
        continue;
      }

      // Numbered list
      if (/^\d+\.\s/.test(line)) {
        const items: React.ReactNode[] = [];
        while (i < lines.length && /^\d+\.\s/.test(lines[i])) {
          items.push(<li key={`oli${segKey++}`}>{processInlineMarkdown(lines[i].replace(/^\d+\.\s/, ''))}</li>);
          i++;
        }
        elements.push(<ol key={`seg${segKey++}`} style={{ margin: '4px 0', paddingLeft: 20 }}>{items}</ol>);
        continue;
      }

      // Regular line
      if (line === '') {
        elements.push(<br key={`seg${segKey++}`} />);
      } else {
        elements.push(
          <React.Fragment key={`seg${segKey++}`}>
            {processInlineMarkdown(line)}
            {i < lines.length - 1 && <br />}
          </React.Fragment>
        );
      }
      i++;
    }
  }

  return <>{elements}</>;
}

/* ── Shared keyframe CSS ── */

export const TYPING_BOUNCE_CSS = `
  @keyframes ggui-typing-bounce {
    0%, 60%, 100% { transform: translateY(0); opacity: 0.4; }
    30% { transform: translateY(-5px); opacity: 1; }
  }
`;

export const SPIN_CSS = `
  @keyframes spin { to { transform: rotate(360deg); } }
`;

export const SHIMMER_CSS = `
  @keyframes ggui-shimmer {
    0% { background-position: 200% 0; }
    100% { background-position: -200% 0; }
  }
`;
