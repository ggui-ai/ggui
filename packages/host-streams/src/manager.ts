/**
 * Manager factory + lifecycle skeleton.
 *
 * **Scaffold only.** Returns a manager whose methods throw
 * `NotImplementedError` until the runtime port lands. The shape is
 * locked here so dependents can declare deps and write integration
 * tests against the surface ahead of the actual implementation.
 *
 * @public
 */

import type {
  BindIframeOptions,
  HostStreamManager,
  HostStreamManagerConfig,
  UnbindIframe,
} from './types.js';

/**
 * Default polling cadence (ms). Mirrors iframe-runtime's
 * `DEFAULT_IFRAME_POLL_INTERVAL_MS` for parity — when the host-
 * mediated path replaces the iframe-side poller, the user-perceived
 * freshness stays unchanged.
 *
 * Operator override: pass `defaultPollIntervalMs` on the manager
 * config. Per-channel override via `streamSpec[ch].pollIntervalMs`.
 */
export const DEFAULT_HOST_POLL_INTERVAL_MS = 10_000;

class NotImplementedError extends Error {
  constructor(method: string) {
    super(
      `@ggui-ai/host-streams: ${method} is not yet implemented. ` +
        `This package currently ships only the stable public interface; ` +
        `the runtime implementation is not yet wired.`,
    );
    this.name = 'NotImplementedError';
  }
}

/**
 * Construct a {@link HostStreamManager} for the supplied config.
 *
 * **Today**: returns a stub whose methods throw
 * `NotImplementedError`. Callers can wire the manager and write
 * compile-time-only integrations; runtime calls fail loudly so we
 * don't ship a silent no-op that pretends to work.
 *
 * **Once the runtime port lands**: the same factory returns the
 * real manager — no public-surface change.
 */
export function createHostStreamManager(
  _config: HostStreamManagerConfig,
): HostStreamManager {
  return {
    bindIframe(_iframe: HTMLIFrameElement, _options: BindIframeOptions): UnbindIframe {
      throw new NotImplementedError('bindIframe');
    },
    rebindRender(_iframe: HTMLIFrameElement, _sessionId: string): void {
      throw new NotImplementedError('rebindRender');
    },
    dispose(): void {
      throw new NotImplementedError('dispose');
    },
  };
}
