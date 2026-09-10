/**
 * Theme-binding conformance — a pure-function catalog (ggui#987).
 *
 * Three contracts the kit grades directly against `@ggui-ai/protocol`, so
 * their breaking-ness is decided by a fixture and not by prose
 * (VERSION-POLICY §2 — the kit is the arbiter):
 *
 *   - `theme-mode-*` — the CLIENT projection of the `themeMode` total
 *     order, `effectiveThemeMode` (`integrations/theme-binding.ts`): the
 *     embedding host owns runtime mode (D4).
 *   - `app-theme-*` — which overlay shapes `appThemeSchema` accepts: both
 *     projections and the attestation required; the v1 one-palette wire and
 *     `base` refused.
 *   - `overlay-hash-*` — `canonicalOverlayHash` against an independently
 *     computed vector.
 *
 * History (the §1.1 receipt): `theme-mode-order`, `app-theme-v1-one-palette`
 * and `app-theme-v1-base` were promoted from the unit pins at the version
 * BEFORE the revision, passed there, and failed when it landed — that is
 * what named the revision breaking. Like `../refusal-envelope-conformance`,
 * the cases are raw JSON under `./cases/` and are NOT registered in
 * `fixturesByContract`; the entry point is the runner below and its test.
 */
import { appThemeSchema, canonicalOverlayHash } from '@ggui-ai/protocol';
import { effectiveThemeMode } from '@ggui-ai/protocol/integrations/theme-binding';

import appThemeV1Base from './cases/app-theme-v1-base.json' with { type: 'json' };
import appThemeV1OnePalette from './cases/app-theme-v1-one-palette.json' with { type: 'json' };
import appThemeV2Accepted from './cases/app-theme-v2-accepted.json' with { type: 'json' };
import appThemeV2MissingDark from './cases/app-theme-v2-missing-dark.json' with { type: 'json' };
import appThemeV2LabelTooLong from './cases/app-theme-v2-label-too-long.json' with { type: 'json' };
import appThemeV2KeyframesAccepted from './cases/app-theme-v2-keyframes-accepted.json' with { type: 'json' };
import appThemeV2KeyframesNotKeyframes from './cases/app-theme-v2-keyframes-not-keyframes.json' with { type: 'json' };
import appThemeV2NoHash from './cases/app-theme-v2-no-hash.json' with { type: 'json' };
import appThemeV2PlatformPin from './cases/app-theme-v2-platform-pin.json' with { type: 'json' };
import overlayHashCanonical from './cases/overlay-hash-canonical.json' with { type: 'json' };
import themeModeAbsence from './cases/theme-mode-absence.json' with { type: 'json' };
import themeModeDefaultWhenSilentHost from './cases/theme-mode-default-when-silent-host.json' with { type: 'json' };
import themeModeOrder from './cases/theme-mode-order.json' with { type: 'json' };

type Opinion = 'light' | 'dark';

export interface ThemeModeCase {
  readonly name: string;
  readonly description: string;
  readonly sources: {
    readonly stamped: Opinion | null;
    readonly sessionSidecar: Opinion | null;
    readonly hostAnnounced: Opinion | null;
  };
  readonly expect: Opinion | null;
}

export interface AppThemeCase {
  readonly name: string;
  readonly description: string;
  readonly theme: unknown;
  readonly expect: 'accepted' | 'refused';
}

export interface OverlayHashCase {
  readonly name: string;
  readonly description: string;
  readonly input: Parameters<typeof canonicalOverlayHash>[0];
  readonly expect: string;
}

const isOpinion = (v: unknown): v is Opinion => v === 'light' || v === 'dark';
const opinionOrNull = (v: unknown, where: string): Opinion | null => {
  if (v === null || isOpinion(v)) return v;
  throw new Error(`theme-binding case: ${where} must be 'light' | 'dark' | null, got ${JSON.stringify(v)}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;
const isVarMap = (v: unknown): v is Record<string, string> =>
  isRecord(v) && Object.values(v).every((x) => typeof x === 'string');

function themeModeCase(raw: unknown): ThemeModeCase {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['description'] !== 'string' || !isRecord(raw['sources']))
    throw new Error('theme-binding case: malformed theme-mode case');
  const src = raw['sources'];
  return {
    name: raw['name'],
    description: raw['description'],
    sources: {
      stamped: opinionOrNull(src['stamped'], 'sources.stamped'),
      sessionSidecar: opinionOrNull(src['sessionSidecar'], 'sources.sessionSidecar'),
      hostAnnounced: opinionOrNull(src['hostAnnounced'], 'sources.hostAnnounced'),
    },
    expect: opinionOrNull(raw['expect'], 'expect'),
  };
}

function appThemeCase(raw: unknown): AppThemeCase {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['description'] !== 'string' || !('theme' in raw))
    throw new Error('theme-binding case: malformed app-theme case');
  const expect = raw['expect'];
  if (expect !== 'accepted' && expect !== 'refused') throw new Error(`theme-binding case: expect must be accepted|refused, got ${JSON.stringify(expect)}`);
  return { name: raw['name'], description: raw['description'], theme: raw['theme'], expect };
}

function overlayHashCase(raw: unknown): OverlayHashCase {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['description'] !== 'string' || typeof raw['expect'] !== 'string' || !isRecord(raw['input']))
    throw new Error('theme-binding case: malformed overlay-hash case');
  const input = raw['input'];
  const overlays = input['overlays'];
  if (!isRecord(overlays) || !isVarMap(overlays['light']) || !isVarMap(overlays['dark']))
    throw new Error('theme-binding case: overlay-hash input needs overlays.light and overlays.dark');
  return {
    name: raw['name'],
    description: raw['description'],
    input: { overlays: { light: overlays['light'], dark: overlays['dark'] } },
    expect: raw['expect'],
  };
}

export const THEME_MODE_CASES: readonly ThemeModeCase[] = [themeModeOrder, themeModeAbsence, themeModeDefaultWhenSilentHost].map(themeModeCase);
export const APP_THEME_CASES: readonly AppThemeCase[] = [appThemeV1OnePalette, appThemeV1Base, appThemeV2Accepted, appThemeV2MissingDark, appThemeV2NoHash, appThemeV2PlatformPin, appThemeV2LabelTooLong, appThemeV2KeyframesAccepted, appThemeV2KeyframesNotKeyframes].map(appThemeCase);
export const OVERLAY_HASH_CASES: readonly OverlayHashCase[] = [overlayHashCanonical].map(overlayHashCase);

export interface ThemeBindingResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const nullable = (v: Opinion | null): Opinion | undefined => (v === null ? undefined : v);

/** Grade every theme-binding case against the protocol's own functions. */
export async function runThemeBindingConformance(): Promise<readonly ThemeBindingResult[]> {
  const results: ThemeBindingResult[] = [];
  for (const c of THEME_MODE_CASES) {
    const got = effectiveThemeMode({
      stamped: nullable(c.sources.stamped),
      sessionSidecar: nullable(c.sources.sessionSidecar),
      hostAnnounced: nullable(c.sources.hostAnnounced),
    });
    const want = nullable(c.expect);
    results.push({ name: c.name, pass: got === want, detail: `effectiveThemeMode(${JSON.stringify(c.sources)}) = ${String(got)}; expected ${String(want)}` });
  }
  for (const c of APP_THEME_CASES) {
    const parsed = appThemeSchema.safeParse(c.theme);
    const got = parsed.success ? 'accepted' : 'refused';
    results.push({ name: c.name, pass: got === c.expect, detail: `appThemeSchema: ${got}; expected ${c.expect}${parsed.success ? '' : ` (${parsed.error.issues.map((i) => i.message).join('; ')})`}` });
  }
  for (const c of OVERLAY_HASH_CASES) {
    const got = await canonicalOverlayHash(c.input);
    results.push({ name: c.name, pass: got === c.expect, detail: `canonicalOverlayHash = ${got}; expected ${c.expect}` });
  }
  return results;
}
