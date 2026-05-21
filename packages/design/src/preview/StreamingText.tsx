/**
 * StreamingText — text fragment with an optional blinking caret.
 *
 * Provisional A2UI `Text` components may be re-emitted with longer
 * `text` values as Haiku produces more tokens. When the renderer
 * detects a fragment is actively extending, it sets `streaming` to
 * true and the caret pulses at the tail to signal "still typing";
 * once the stream stabilises the caret is removed.
 *
 * The component doesn't choose the typography — callers render the
 * real `Text` / `Heading` primitive as children and this wrapper just
 * decorates the tail position. That keeps the design system's
 * semantic hierarchy (h1..h6 vs body) intact without duplicating it.
 */
import type { CSSProperties, ReactNode } from 'react';

export interface StreamingTextProps {
  children: ReactNode;
  /**
   * When `true`, a caret is rendered at the tail of the text and
   * animated. When `false`, no caret — used once the fragment
   * finishes streaming or when the renderer hasn't detected active
   * streaming (e.g. for static labels inside a preview).
   */
  streaming?: boolean;
  className?: string;
  style?: CSSProperties;
}

export function StreamingText({
  children,
  streaming = false,
  className,
  style,
}: StreamingTextProps) {
  const wrapper: CSSProperties = {
    display: 'inline',
    ...style,
  };

  // The caret is a thin vertical bar placed inline after the text.
  // Kept visually subtle — the shimmer surface already signals
  // "in progress", so this is a quiet accent rather than a loud
  // indicator.
  const caret: CSSProperties = {
    display: 'inline-block',
    width: '0.5ch',
    height: '1em',
    marginLeft: '0.1em',
    verticalAlign: 'text-bottom',
    borderRight: '0.08em solid currentColor',
    animation: 'ggui-preview-caret 900ms steps(1, end) infinite',
  };

  return (
    <span
      className={className}
      data-ggui-preview-streaming={streaming ? '' : undefined}
      style={wrapper}
    >
      {children}
      {streaming ? <span aria-hidden="true" style={caret} /> : null}
    </span>
  );
}
