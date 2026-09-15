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

/**
 * The effort level (ggui#1058, founder's A2): ONE name over the reader's
 * dials (model tier × turn cap × eval rounds × visual bar × judge model).
 * The wire carries only the name; the name → dials table is the reader's
 * (versioned by it), so a price line can move without a wire change.
 * Absent ⇒ the deployment's default level, which MUST equal today's fixed
 * options. A level the deployment has not enabled is REFUSED at the write
 * door (`{ profile: { effort: 'unavailable' } }`) — never downgraded.
 */
export const APP_GENERATION_PROFILE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'ultra'] as const;
export type AppGenerationProfileEffort = (typeof APP_GENERATION_PROFILE_EFFORTS)[number];

/** Catalogue entry ids are slugs: trace-line and path safe, 2–64 chars. */
export const APP_GENERATION_AESTHETIC_ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
/** A preset content version: no whitespace, ≤ 32 chars. */
export const APP_GENERATION_AESTHETIC_VERSION_RE = /^[A-Za-z0-9._-]{1,32}$/;

/**
 * A reference INTO the aesthetic/variance catalogue (data, kept by the
 * deployment, never inside the generator): `id` is the catalogue entry — the
 * same slug a draft carries as its variance `aesthetic` when both are
 * present — and `version` pins the preset's content so a preset can be
 * re-authored without re-keying served takes. The door validates GRAMMAR
 * only; resolution happens at read, and an unresolvable reference is
 * NON-FATAL: the generator proceeds without the aesthetic section and
 * reports `profile_aesthetic_unresolved`.
 */
export const appGenerationAestheticRefSchema = z
  .object({
    id: z.string().regex(APP_GENERATION_AESTHETIC_ID_RE, 'aesthetic id must be a slug (2–64 chars, lowercase, digits, dashes)'),
    version: z.string().regex(APP_GENERATION_AESTHETIC_VERSION_RE, 'aesthetic version: 1–32 chars, no whitespace').optional(),
  })
  .strict();
export type AppGenerationAestheticRef = z.infer<typeof appGenerationAestheticRefSchema>;

export const appGenerationProfileSchema = z
  .object({
    styling: profileText('styling').optional(),
    density: profileText('density').optional(),
    layout: profileText('layout').optional(),
    direction: profileText('direction').optional(),
    effort: z.enum(APP_GENERATION_PROFILE_EFFORTS).optional(),
    aesthetic: appGenerationAestheticRefSchema.optional(),
  })
  .strict();

export type AppGenerationProfile = z.infer<typeof appGenerationProfileSchema>;

/**
 * The READ-door variant of {@link appGenerationProfileSchema} (ggui#1105).
 *
 * The write door is strict and MUST stay so — it is what bounds each member
 * and refuses control characters before a profile is stored. A READ door has
 * the opposite job: a stored profile written by a LATER release carries a
 * member this one cannot name, and refusing it there does not protect
 * anything — it destroys a mint. Today the same stored profile is read two
 * ways: the mint parses it strictly and THROWS (the mint dies), while the
 * judge hand-rolls a `.strip()`. One document, two postures, diverging on
 * exactly the member a later release adds.
 *
 * Third instance of one posture — see `schemas/app-theme.ts`
 * (`parseAppThemeAtReadDoor`) and `schemas/data-contract.ts`
 * (`parseDataContractAtReadDoor`). The rule they share:
 *
 *   **a read whose purpose is to INTERPRET state strips unknown members and
 *   names what it stripped; a read whose purpose is to REPRODUCE state must
 *   not strip at all.**
 *
 * This is an INTERPRET door. Only members this release does not NAME are
 * stripped — never members it finds INVALID: a bound, a control character or
 * a level outside the vocabulary is refused exactly as the write door refuses
 * it.
 */
export const appGenerationProfileReadSchema = z.object(appGenerationProfileSchema.shape);

export type AppGenerationProfileReadDoorResult =
  | { readonly ok: true; readonly profile: AppGenerationProfile; readonly stripped: readonly string[] }
  | { readonly ok: false; readonly issues: readonly string[] };

/**
 * Parse a stored generation profile at a READ door: `ok` with the profile and
 * the top-level members that were stripped (payload order, `[]` when none), or
 * the issues in `path: message` form when the profile is refused for a reason
 * the write door would also refuse.
 *
 * Every reader of a STORED profile should use this — the mint and the judge
 * reading one document two ways is the defect ggui#1105 exists for, and one
 * exported door is how that stops being possible rather than being noticed.
 */
export function parseAppGenerationProfileAtReadDoor(
  input: unknown,
): AppGenerationProfileReadDoorResult {
  const parsed = appGenerationProfileReadSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, issues: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`) };
  }
  const known = new Set(Object.keys(appGenerationProfileSchema.shape));
  const stripped =
    typeof input === 'object' && input !== null && !Array.isArray(input)
      ? Object.keys(input).filter((k) => !known.has(k))
      : [];
  return { ok: true, profile: parsed.data, stripped };
}

/** Why the door refused one member — one reason per member, at least one member named. */
export const appGenerationProfileRefusalReasonSchema = z.enum(['too-long', 'not-text', 'control-chars', 'unavailable']);
export type AppGenerationProfileRefusalReason = z.infer<typeof appGenerationProfileRefusalReasonSchema>;

export const appGenerationProfileRefusalBodySchema = z
  .object({
    profile: z
      .object({
        styling: appGenerationProfileRefusalReasonSchema.optional(),
        density: appGenerationProfileRefusalReasonSchema.optional(),
        layout: appGenerationProfileRefusalReasonSchema.optional(),
        direction: appGenerationProfileRefusalReasonSchema.optional(),
        effort: appGenerationProfileRefusalReasonSchema.optional(),
        aesthetic: appGenerationProfileRefusalReasonSchema.optional(),
      })
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'a profile refusal names at least one member'),
  })
  .strict();

export type AppGenerationProfileRefusalBody = z.infer<typeof appGenerationProfileRefusalBodySchema>;
