import { z } from 'zod';

/**
 * The generator PROFILE slot on an app's `generation` section (ggui#991;
 * the D7 mechanism of ggui#987 — "chosen at generation time, like layout").
 *
 * Four members of free text the app's operator writes and the generator
 * reads when it composes a component: `styling` is the brief (voice,
 * mood, references), `density` and `layout` are one line each, and
 * `direction` (2026-09-11, ggui#1027 follower) is the COMPOSITION
 * direction of one variant — what leads (a hero panel, rows with arrows,
 * a compact row of chips, a split panel), what is left out (icons,
 * helper text, status lines), motion or none — one short paragraph, so
 * a family of variants is one draft under one judge with the direction
 * as the only arm. The slot
 * is a GENERATION-TIME input: it is not a theme-document field, not a
 * consumed token, and MUST never be projected into the `--ggui-*`
 * vocabulary the card reads. An absent or empty profile MUST leave the
 * generator's prompts byte-identical to today's.
 *
 * Parties and obligations:
 *   - WRITERS (an operator console, `ggui deploy`) send the object below
 *     through the app-config write door; the door trims, bounds each
 *     member at {@link APP_GENERATION_PROFILE_BOUNDS} and refuses control
 *     characters other than tab, newline and carriage return, answering
 *     `invalid_app_config` with {@link appGenerationProfileRefusalBodySchema}
 *     in the transport's refusal slot (REST 422 body, AppSync `errorInfo`,
 *     MCP `structuredContent`).
 *   - READERS (`@ggui-ai/ui-gen` behind the server's render path) cap
 *     defensively at the SAME numbers — a value over the bound is a door
 *     defect, never a second rule — and treat absent and empty alike.
 *
 * Observable violation: a profile that reaches the generator unbounded, or
 * a profile name surfacing as a `--ggui-*` token, is non-conformant.
 */
export const APP_GENERATION_PROFILE_BOUNDS = {
  styling: 2000,
  density: 200,
  layout: 200,
  direction: 600,
} as const;

export type AppGenerationProfileMember = keyof typeof APP_GENERATION_PROFILE_BOUNDS;

/**
 * True when the text carries a C0 control character other than tab (0x09),
 * newline (0x0A) or carriage return (0x0D), or DEL (0x7F). Written as a
 * code-point walk on purpose: the intent is explicit, and no control
 * character has to appear in source.
 */
function hasForbiddenControlChars(text: string): boolean {
  for (const ch of text) {
    const c = ch.codePointAt(0) ?? 0;
    if (c === 0x7f) return true;
    if (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d) return true;
  }
  return false;
}

function profileText(member: AppGenerationProfileMember) {
  const max = APP_GENERATION_PROFILE_BOUNDS[member];
  return z
    .string()
    .trim()
    .max(max, `generation.profile.${member} exceeds ${max} characters`)
    .refine((s) => !hasForbiddenControlChars(s), `generation.profile.${member} contains control characters`);
}

export const appGenerationProfileSchema = z
  .object({
    styling: profileText('styling').optional(),
    density: profileText('density').optional(),
    layout: profileText('layout').optional(),
    direction: profileText('direction').optional(),
  })
  .strict();

export type AppGenerationProfile = z.infer<typeof appGenerationProfileSchema>;

/** Why the door refused one member — one reason per member, at least one member named. */
export const appGenerationProfileRefusalReasonSchema = z.enum(['too-long', 'not-text', 'control-chars']);
export type AppGenerationProfileRefusalReason = z.infer<typeof appGenerationProfileRefusalReasonSchema>;

export const appGenerationProfileRefusalBodySchema = z
  .object({
    profile: z
      .object({
        styling: appGenerationProfileRefusalReasonSchema.optional(),
        density: appGenerationProfileRefusalReasonSchema.optional(),
        layout: appGenerationProfileRefusalReasonSchema.optional(),
        direction: appGenerationProfileRefusalReasonSchema.optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'a profile refusal names at least one member'),
  })
  .strict();

export type AppGenerationProfileRefusalBody = z.infer<typeof appGenerationProfileRefusalBodySchema>;
