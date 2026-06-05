/**
 * `StatusBadge` — brand-kit state pill (§06 / Color state tokens).
 *
 * Used for connection status, generation state, cache-hit badges, and
 * anywhere a one-word machine-readable state is worth surfacing. Four
 * tones: `live` (active/success), `draft` (pending/in-progress),
 * `signal` (error/destructive), `ink` (neutral / informational).
 *
 * Decoration is strictly the token border + inline dot — state reads
 * on the color, not on a fill wash. Flat, hairline, no shadow.
 */
import type { ReactElement, ReactNode } from 'react';

export type StatusTone = 'live' | 'draft' | 'signal' | 'ink';

export interface StatusBadgeProps {
  readonly tone: StatusTone;
  readonly children: ReactNode;
  /** Adds the leading 6px filled dot. Defaults to `true`. */
  readonly dot?: boolean;
}

export function StatusBadge({
  tone,
  children,
  dot = true,
}: StatusBadgeProps): ReactElement {
  return (
    <span className={`ggui-status ggui-status--${tone}`}>
      {dot ? <span className="ggui-status__dot" aria-hidden /> : null}
      {children}
    </span>
  );
}

/**
 * Map a connection-status string (the `@ggui-ai/react` `GguiSessionApi`
 * exposes `'connecting' | 'connected' | 'disconnected' | …`) to a
 * brand-kit tone. Centralized so multiple routes agree on the mapping.
 */
export function connectionTone(status: string): StatusTone {
  if (status === 'connected') return 'live';
  if (status === 'connecting') return 'draft';
  return 'signal';
}
