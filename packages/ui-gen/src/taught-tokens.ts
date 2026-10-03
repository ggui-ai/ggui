// The consumed-token names the generator may TEACH — the manifest minus the names a card may not
// reference yet.
//
// A card is minted by one release and rendered by whichever runtime serves it: during a rolling
// deploy, or after a rollback, that runtime can be the previous release, which neither declares
// nor completes a key derived for the first time in this one. A bare `var(--new-key)` then
// resolves to nothing — a `border` shorthand drops whole — and the no-fallback rule leaves the
// card nothing to fall back on. So a new derived key ships in two steps: the renderers that
// declare and complete it serve first (the design package's own primitives read it behind a
// fallback), and the release AFTER takes it out of this set, in the same change as the prompt
// guidance that teaches it.

import { consumedTokenManifest } from "@ggui-ai/design/themes";

/**
 * Manifest names held back from every surface that teaches the model a name — the free prompt's
 * colour vocabulary and token reference, and the self-check's nearest-name suggestions. The
 * closed-set check still admits them: a card that references one is valid wherever this release
 * renders it.
 *
 * Empty today. The control edges (`controlOutline`, `controlAccentOutline`, ggui#1494) were held here
 * until every serving and rollback runtime declared them; the derivation (`10a0c00f2`) is in every
 * release from tag 17 on, so they are taught from ggui#1697, in the same change as the prompt rule that
 * teaches a control's edge.
 */
export const NOT_YET_TAUGHT_TOKENS: ReadonlySet<string> = new Set<string>([]);

/** The manifest as the model is taught it. */
export const taughtTokenManifest: readonly string[] = consumedTokenManifest.filter(
  (token) => !NOT_YET_TAUGHT_TOKENS.has(token),
);
