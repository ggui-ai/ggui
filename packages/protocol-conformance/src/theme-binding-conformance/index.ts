/**
 * Theme-binding conformance — a pure-function catalog (ggui#987).
 *
 * Two contracts the kit grades directly against `@ggui-ai/protocol`, so
 * their breaking-ness is decided by a fixture and not by prose
 * (VERSION-POLICY §2 — the kit is the arbiter):
 *
 *   - `theme-mode-*` — the CLIENT projection of the `themeMode` total
 *     order, `effectiveThemeMode` (`integrations/theme-binding.ts`).
 *   - `app-theme-*` — which overlay shapes `appThemeSchema` accepts.
 *
 * Like `../refusal-envelope-conformance`, the cases are raw JSON under
 * `./cases/` and are NOT registered in `fixturesByContract` (they need
 * no server); the entry point is the programmatic runner below and the
 * test beside it.
 */
import { appThemeSchema } from '@ggui-ai/protocol';
import { effectiveThemeMode } from '@ggui-ai/protocol/integrations/theme-binding';

import appThemeV1Base from './cases/app-theme-v1-base.json' with { type: 'json' };
import appThemeV1OnePalette from './cases/app-theme-v1-one-palette.json' with { type: 'json' };
import themeModeAbsence from './cases/theme-mode-absence.json' with { type: 'json' };
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

const isOpinion = (v: unknown): v is Opinion => v === 'light' || v === 'dark';
const opinionOrNull = (v: unknown, where: string): Opinion | null => {
  if (v === null || isOpinion(v)) return v;
  throw new Error(`theme-binding case: ${where} must be 'light' | 'dark' | null, got ${JSON.stringify(v)}`);
};
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Narrow a raw JSON case to {@link ThemeModeCase} — a malformed case fails loudly at load. */
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

/** Narrow a raw JSON case to {@link AppThemeCase}. */
function appThemeCase(raw: unknown): AppThemeCase {
  if (!isRecord(raw) || typeof raw['name'] !== 'string' || typeof raw['description'] !== 'string' || !('theme' in raw))
    throw new Error('theme-binding case: malformed app-theme case');
  const expect = raw['expect'];
  if (expect !== 'accepted' && expect !== 'refused') throw new Error(`theme-binding case: expect must be accepted|refused, got ${JSON.stringify(expect)}`);
  return { name: raw['name'], description: raw['description'], theme: raw['theme'], expect };
}

export const THEME_MODE_CASES: readonly ThemeModeCase[] = [themeModeOrder, themeModeAbsence].map(themeModeCase);
export const APP_THEME_CASES: readonly AppThemeCase[] = [appThemeV1OnePalette, appThemeV1Base].map(appThemeCase);

export interface ThemeBindingResult {
  readonly name: string;
  readonly pass: boolean;
  readonly detail: string;
}

const nullable = (v: Opinion | null): Opinion | undefined => (v === null ? undefined : v);

/** Grade every theme-binding case against the protocol's own functions. */
export function runThemeBindingConformance(): readonly ThemeBindingResult[] {
  const results: ThemeBindingResult[] = [];
  for (const c of THEME_MODE_CASES) {
    const got = effectiveThemeMode({
      stamped: nullable(c.sources.stamped),
      sessionSidecar: nullable(c.sources.sessionSidecar),
      hostAnnounced: nullable(c.sources.hostAnnounced),
    });
    const want = nullable(c.expect);
    results.push({
      name: c.name,
      pass: got === want,
      detail: `effectiveThemeMode(${JSON.stringify(c.sources)}) = ${String(got)}; expected ${String(want)}`,
    });
  }
  for (const c of APP_THEME_CASES) {
    const parsed = appThemeSchema.safeParse(c.theme);
    const got = parsed.success ? 'accepted' : 'refused';
    results.push({
      name: c.name,
      pass: got === c.expect,
      detail: `appThemeSchema: ${got}; expected ${c.expect}${parsed.success ? '' : ` (${parsed.error.issues.map((i) => i.message).join('; ')})`}`,
    });
  }
  return results;
}
