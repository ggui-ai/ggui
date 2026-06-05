/**
 * No-credentials system-card emitter.
 *
 * When `ggui_render` runs without resolvable LLM credentials AND the
 * server bound a fallback via `GenerationDeps.onNoCredentials`, the
 * render handler commits a {@link SystemGguiSession} (kind
 * `'no-credentials'`) instead of the generic error envelope. The
 * runtime resolves that kind against its built-in
 * `SYSTEM_CARD_REGISTRY` and renders a real React component bundled
 * inside `@ggui-ai/iframe-runtime` — no ESM source emission, no
 * `React.createElement` template strings on the server.
 *
 * The actual visual lives in
 * `packages/iframe-runtime/src/system-cards/NoCredentialsCard.tsx`.
 * This server-side module contributes only the typed payload + the
 * settings-URL composition (an absolute URL is required because host
 * iframes resolve relative paths against their sandbox origin, e.g.
 * `claudemcpcontent.com`).
 */
import type { SystemGguiSession } from '@ggui-ai/protocol';

/**
 * Stable wire identifier the iframe-runtime maps to its built-in
 * `NoCredentialsCard` component. Keep aligned with the
 * `SYSTEM_CARD_REGISTRY` key in
 * `packages/iframe-runtime/src/system-cards/index.ts`.
 */
export const NO_CREDENTIALS_SYSTEM_CARD_KIND = 'no-credentials' as const;

/**
 * Build a {@link SystemGguiSession} carrying the no-credentials card.
 * The `id` MUST equal the in-flight `sessionId` so a subsequent
 * `renderStore.commit({render})` upserts in place over any
 * provisional preview placeholder.
 *
 * `settingsUrl` MUST be absolute (host iframe sandboxes resolve
 * relative URLs against their proxy origin, e.g.
 * `claudemcpcontent.com`). Caller composes from `--public-base-url` +
 * `/settings`.
 */
export function buildNoCredentialsGguiSession(args: {
  readonly sessionId: string;
  readonly appId: string;
  readonly intent: string;
  readonly nowEpochMs: number;
  readonly expiresAt: number;
  readonly settingsUrl: string;
}): SystemGguiSession {
  return {
    id: args.sessionId,
    appId: args.appId,
    type: 'system',
    kind: NO_CREDENTIALS_SYSTEM_CARD_KIND,
    createdAt: args.nowEpochMs,
    lastActivityAt: args.nowEpochMs,
    expiresAt: args.expiresAt,
    eventSequence: 0,
    props: {
      settingsUrl: args.settingsUrl,
      intent: args.intent,
    },
  };
}
