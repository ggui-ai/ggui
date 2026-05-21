import type { SpinnerProps } from './types';
import { resolveToneCss } from './color-slots';

/**
 * Spinner - A loading indicator
 */
export function Spinner({
  size = 24,
  tone,
  style,
  className,
}: SpinnerProps) {
  // The Spinner stroke uses `currentColor` for the `'inherit'` slot
  // because SVG `stroke="inherit"` is not a valid value — the
  // `currentColor` keyword is the canonical way to track the parent's
  // CSS `color`. Other tones resolve via the standard slot table.
  const spinnerColor =
    tone === 'inherit'
      ? 'currentColor'
      : tone
        ? resolveToneCss(tone)
        : 'var(--ggui-color-primary-600, #0284c7)';

  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      role="status"
      aria-label="Loading"
      style={{
        animation: 'ggui-spin 1s linear infinite',
        ...style,
      }}
    >
      <style>
        {`@keyframes ggui-spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }`}
      </style>
      <circle
        cx="12"
        cy="12"
        r="10"
        stroke="var(--ggui-color-outlineVariant, #e4e4e7)"
        strokeWidth="3"
        fill="none"
      />
      <path
        d="M12 2a10 10 0 0 1 10 10"
        stroke={spinnerColor}
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}
