/**
 * ProvisionalRenderer — placeholder surface shown while a render's
 * `componentCode` is still being generated.
 *
 * `<GguiSessionRenderer>` routes renders with empty `componentCode`
 * here; the component paints the caller's `fallback` (or a centred
 * Spinner) until the authoritative component code lands and the
 * renderer swaps in the final component.
 *
 * The live A2UI preview pipeline (`_ggui:preview` envelope reduction
 * over an ambient StreamBus) lives in `@ggui-ai/iframe-runtime`'s
 * provisional renderer, which runs inside the sandboxed view where
 * the channel actually terminates. This host-side component has no
 * live channel and stays static.
 */
import { type ReactNode } from 'react';
import { Spinner } from '@ggui-ai/design/primitives';

export interface ProvisionalRendererProps {
  /**
   * When `true`, the placeholder is hidden. Consumers set this once
   * the authoritative render takes over (e.g. `componentCode` lands on
   * the render and the renderer has swapped in the final component).
   */
  suspended?: boolean;

  /**
   * Content shown while the render is pending. Defaults to a centred
   * Spinner.
   */
  fallback?: ReactNode;
}

/** Default loading fallback. */
function DefaultFallback(): ReactNode {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        minHeight: 80,
      }}
    >
      <Spinner />
    </div>
  );
}

/**
 * Paints the pending-render placeholder. Hidden when `suspended` is
 * set; renders `fallback` (or a centred Spinner) otherwise.
 */
export function ProvisionalRenderer({
  suspended = false,
  fallback,
}: ProvisionalRendererProps = {}) {
  if (suspended) return null;
  return <>{fallback ?? <DefaultFallback />}</>;
}
