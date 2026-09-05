/**
 * The `GGUI_PUBLIC_APP_*` key grammar — its own module (ggui#819) so the
 * browser entry can carry the regex without the contract schema that
 * embeds it.
 */
/**
 * `App.publicEnv` key regex.
 *
 * Each key in `App.publicEnv` MUST match this pattern. The prefix is
 * the **security boundary** — operators can't accidentally stash
 * sensitive credentials under arbitrary names, and downstream consumers
 * (render gate, bootstrap projection, iframe shim) can rely on the
 * naming convention to mean "public-by-design".
 *
 * Rule: `GGUI_PUBLIC_APP_` prefix, then uppercase letters / digits /
 * underscores, at least one char after the prefix.
 *
 * `GGUI_PUBLIC_USER_*` keys are RESERVED for a future per-user
 * channel. The current regex rejects them so App-side config can't
 * pre-emptively use the namespace.
 *
 * Hoisted above `gadgetDescriptorSchema` so the wrapper's `requires`
 * array can reference it at schema-construction time (TDZ-safe).
 */
export const PUBLIC_ENV_APP_KEY_RE = /^GGUI_PUBLIC_APP_[A-Z0-9_]+$/;
