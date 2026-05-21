/**
 * No-credentials system-card emitter.
 *
 * When `ggui_push` runs without resolvable LLM credentials AND the
 * server bound a fallback via `GenerationDeps.onNoCredentials`, the
 * push handler appends a {@link SystemStackItem} (kind
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
import type { SystemStackItem } from '@ggui-ai/protocol';

/**
 * Stable wire identifier the iframe-runtime maps to its built-in
 * `NoCredentialsCard` component. Keep aligned with the
 * `SYSTEM_CARD_REGISTRY` key in
 * `packages/iframe-runtime/src/system-cards/index.ts`.
 */
export const NO_CREDENTIALS_SYSTEM_CARD_KIND = 'no-credentials' as const;

/**
 * Build a {@link SystemStackItem} carrying the no-credentials card.
 * The `id` MUST equal the in-flight `stackItemId` — `appendStackItem`
 * upserts by id, so reusing the page id replaces any provisional
 * preview placeholder with the real card in place.
 *
 * `settingsUrl` MUST be absolute (host iframe sandboxes resolve
 * relative URLs against their proxy origin, e.g.
 * `claudemcpcontent.com`). Caller composes from `--public-base-url` +
 * `/settings`.
 */
export function buildNoCredentialsStackItem(args: {
  readonly stackItemId: string;
  readonly intent: string;
  readonly nowIso: string;
  readonly settingsUrl: string;
}): SystemStackItem {
  return {
    id: args.stackItemId,
    type: 'system',
    kind: NO_CREDENTIALS_SYSTEM_CARD_KIND,
    createdAt: args.nowIso,
    props: {
      settingsUrl: args.settingsUrl,
      intent: args.intent,
    },
  };
}
