#!/usr/bin/env node
/* eslint-disable no-console -- This is a one-shot CLI audit script; console output IS its UI. */
/**
 * WCAG-AA Contrast Audit (one-shot, informational)
 *
 * Walks every registered theme × (light, dark) and flags scale stops or
 * role-pair colors whose contrast against the surface fails WCAG-AA
 * thresholds. The 5 AGENT-DERIVED semantic scales (success / warning /
 * error / info) plus primary/neutral never went through designer review
 * for contrast — this script is the safety net that surfaces stops
 * unsafe for text or UI-component usage.
 *
 * Output is informational. Exit code is set (0 = all pass, 1 = at least
 * one failure) so this can later be folded into CI as a soft check.
 *
 * Math: WCAG 2.x relative luminance + contrast ratio. No deps.
 */

import { getThemeIds, getRawTheme } from '../src/themes/registry.ts';
import { parseTheme } from '../src/themes/parser.ts';
import type { DtcgTheme, DtcgToken, ThemeMode } from '../src/themes/types.ts';

// ── WCAG thresholds (WCAG 2.1) ─────────────────────────────────────
//
// 1.4.3 (Contrast — Minimum):
//   - 4.5 : normal text (AA)
//   - 3.0 : large text  (AA) — 18pt+ or 14pt+ bold (large-text path not
//     yet wired in this auditor; all text failures use the stricter 4.5
//     threshold. Kept here for documentation of the WCAG bar.)
// 1.4.11 (Non-text Contrast):
//   - 3.0 : UI components and graphical objects (AA)
const THRESH_TEXT_NORMAL = 4.5;
const THRESH_UI = 3.0;

// ── ANSI ────────────────────────────────────────────────────────────
const RESET = '\x1b[0m';
const RED = '\x1b[31m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const CHECK = `${GREEN}✓${RESET}`;
const CROSS = `${RED}✗${RESET}`;

// ── Color math ──────────────────────────────────────────────────────

/**
 * Parse a `#RRGGBB` or `#RGB` hex string into `[r, g, b]` (0-255).
 * Returns `null` for any non-hex value (rgba(), keywords, oklch(), etc.)
 * so the auditor can skip non-hex stops without crashing.
 */
function parseHex(input: string): [number, number, number] | null {
  const s = input.trim().replace(/^#/, '');
  if (s.length === 3) {
    const r = parseInt(s[0] + s[0], 16);
    const g = parseInt(s[1] + s[1], 16);
    const b = parseInt(s[2] + s[2], 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  if (s.length === 6) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  // 8-digit hex w/ alpha — strip alpha, audit RGB on opaque assumption.
  if (s.length === 8) {
    const r = parseInt(s.slice(0, 2), 16);
    const g = parseInt(s.slice(2, 4), 16);
    const b = parseInt(s.slice(4, 6), 16);
    if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return null;
    return [r, g, b];
  }
  return null;
}

/** WCAG 2.x relative luminance. */
function luminance([r, g, b]: [number, number, number]): number {
  const channel = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** Contrast ratio per WCAG: (L1 + 0.05) / (L2 + 0.05), L1 >= L2. */
function contrast(a: string, b: string): number | null {
  const ra = parseHex(a);
  const rb = parseHex(b);
  if (!ra || !rb) return null;
  const la = luminance(ra);
  const lb = luminance(rb);
  const [hi, lo] = la >= lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

// ── Token helpers ───────────────────────────────────────────────────

/**
 * Read the string `$value` from a token, returning `null` when the token
 * isn't a string. The audit only operates on string color values.
 */
function tokenValue(token: DtcgToken<unknown> | undefined): string | null {
  if (!token) return null;
  const v = token.$value;
  return typeof v === 'string' ? v : null;
}

// Scale stops to audit per the spec. Primary/neutral ship 50-900;
// semantic scales (success/warning/error/info) ship only these 7.
const SCALE_STOPS = ['50', '100', '200', '500', '600', '700', '800'] as const;
const SCALE_FAMILIES = [
  'primary',
  'neutral',
  'success',
  'warning',
  'error',
  'info',
] as const;

// ── Audit primitives ────────────────────────────────────────────────

interface Failure {
  pair: string; // e.g. "success.500 vs surface"
  fg: string; // hex
  bg: string; // hex
  ratio: number;
  required: number;
  usage: 'text-normal' | 'text-large' | 'ui';
}

interface ThemeAuditResult {
  themeId: string;
  mode: ThemeMode;
  themeName: string;
  totalChecks: number;
  failures: Failure[];
}

/**
 * Evaluate one foreground/background pair against the relevant WCAG
 * threshold. `kind` selects which threshold applies:
 *
 *   - `text-on-color`: the foreground will be used as text on the bg
 *     (4.5:1 minimum, normal body weight).
 *   - `ui`: the color is a UI-component fill / border / state ring
 *     (3.0:1 minimum per 1.4.11).
 *
 * Returns a Failure when below threshold, `null` when passing or when
 * either input isn't hex (non-hex tokens skip silently).
 */
function evaluatePair(
  pair: string,
  fg: string,
  bg: string,
  kind: 'text-on-color' | 'ui',
): Failure | null {
  const ratio = contrast(fg, bg);
  if (ratio === null) return null;
  if (kind === 'text-on-color') {
    if (ratio < THRESH_TEXT_NORMAL) {
      return {
        pair,
        fg,
        bg,
        ratio,
        required: THRESH_TEXT_NORMAL,
        usage: 'text-normal',
      };
    }
    return null;
  }
  if (ratio < THRESH_UI) {
    return { pair, fg, bg, ratio, required: THRESH_UI, usage: 'ui' };
  }
  return null;
}

/**
 * Audit one resolved theme (themeId, mode). Walks scale stops and the
 * role-pair singletons, collecting every WCAG-AA failure.
 *
 * - For scale stops: each hex is checked twice
 *     · against `color.surface` as a UI-fill / state-ring background
 *       (3.0 minimum, WCAG 1.4.11) — captures "is this stop visible at
 *       all as a non-text UI mark on the page background"
 *     · against `color.onSurface` as a text-on-color fg (4.5 minimum,
 *       1.4.3) — captures "could a designer set body text in this hue?"
 * - Role pairs are checked at the strictest applicable threshold:
 *     · `onPrimary` vs `primary.500`, `onError` vs `error.500`,
 *       `onSurfaceVariant` vs `surfaceVariant` → text-on-color (4.5)
 *     · `outline` vs `surface` → UI component (3.0)
 */
function auditTheme(
  themeId: string,
  mode: ThemeMode,
  theme: DtcgTheme,
): ThemeAuditResult {
  const failures: Failure[] = [];
  let totalChecks = 0;

  const surface = tokenValue(theme.color.surface);
  const onSurface = tokenValue(theme.color.onSurface);

  // Scale-stop sweeps. Some themes may not ship every family/stop — we
  // iterate Object.entries to stay tolerant of partial scales.
  for (const family of SCALE_FAMILIES) {
    const scale = theme.color[family];
    if (!scale) continue;
    for (const stop of SCALE_STOPS) {
      const hex = tokenValue(scale[stop]);
      if (!hex) continue;
      // UI-usage: stop color as a fill / mark on the surface bg.
      if (surface) {
        totalChecks += 1;
        const f = evaluatePair(`${family}.${stop} (on surface, ui)`, hex, surface, 'ui');
        if (f) failures.push(f);
      }
      // Text-on-color: stop color as text fg on the surface bg.
      if (surface) {
        totalChecks += 1;
        const f = evaluatePair(
          `${family}.${stop} (on surface, text)`,
          hex,
          surface,
          'text-on-color',
        );
        if (f) failures.push(f);
      }
      // Text-on-color: onSurface text against the stop as a bg
      // (covers "use this stop as a chip / banner bg with onSurface text").
      if (onSurface) {
        totalChecks += 1;
        const f = evaluatePair(
          `onSurface on ${family}.${stop}`,
          onSurface,
          hex,
          'text-on-color',
        );
        if (f) failures.push(f);
      }
    }
  }

  // Role pairs. Each is checked iff both halves resolve to a hex.
  const pairs: Array<{
    name: string;
    fg: string | null;
    bg: string | null;
    kind: 'text-on-color' | 'ui';
  }> = [
    {
      name: 'onPrimary vs primary.500',
      fg: tokenValue(
        'onPrimary' in theme.color ? theme.color.onPrimary : undefined,
      ),
      bg: tokenValue(theme.color.primary?.['500']),
      kind: 'text-on-color',
    },
    {
      name: 'onError vs error.500',
      fg: tokenValue(
        'onError' in theme.color ? theme.color.onError : undefined,
      ),
      bg: tokenValue(theme.color.error?.['500']),
      kind: 'text-on-color',
    },
    {
      name: 'onSurfaceVariant vs surfaceVariant',
      fg: tokenValue(theme.color.onSurfaceVariant),
      bg: tokenValue(theme.color.surfaceVariant),
      kind: 'text-on-color',
    },
    {
      name: 'outline vs surface',
      fg: tokenValue(theme.color.outline),
      bg: tokenValue(theme.color.surface),
      kind: 'ui',
    },
  ];

  for (const p of pairs) {
    if (!p.fg || !p.bg) continue;
    totalChecks += 1;
    const f = evaluatePair(p.name, p.fg, p.bg, p.kind);
    if (f) failures.push(f);
  }

  return {
    themeId,
    mode,
    themeName: theme.$name,
    totalChecks,
    failures,
  };
}

// ── Render ──────────────────────────────────────────────────────────

function fmtRatio(n: number): string {
  return n.toFixed(2);
}

function printThemeResult(r: ThemeAuditResult): void {
  const header = `${BOLD}${r.themeId}${RESET} ${DIM}(${r.mode}) — ${r.themeName}${RESET}`;
  if (r.failures.length === 0) {
    console.log(`${CHECK} ${header} — ${r.totalChecks} checks passed`);
    return;
  }
  console.log(
    `${CROSS} ${header} — ${RED}${r.failures.length}${RESET} of ${r.totalChecks} checks failed`,
  );
  for (const f of r.failures) {
    const ratio = fmtRatio(f.ratio);
    const req = fmtRatio(f.required);
    const tag =
      f.usage === 'text-normal' ? 'TEXT' : f.usage === 'text-large' ? 'LARGE' : 'UI';
    console.log(
      `    ${DIM}·${RESET} ${YELLOW}${tag}${RESET} ${f.pair} — ratio ${RED}${ratio}${RESET} (need >= ${req}) ${DIM}[${f.fg} on ${f.bg}]${RESET}`,
    );
  }
}

// ── Entry ───────────────────────────────────────────────────────────

function main(): number {
  const themeIds = getThemeIds();
  const modes: ThemeMode[] = ['light', 'dark'];

  const allResults: ThemeAuditResult[] = [];
  for (const id of themeIds) {
    for (const mode of modes) {
      const raw = getRawTheme(id, mode);
      if (!raw) continue;
      // Surface obvious parse errors early but don't abort the audit.
      try {
        parseTheme(id, raw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log(
          `${YELLOW}!${RESET} ${id} (${mode}) — parser threw: ${msg} (continuing with raw audit)`,
        );
      }
      allResults.push(auditTheme(id, mode, raw));
    }
  }

  console.log('');
  console.log(`${BOLD}WCAG-AA contrast audit${RESET}`);
  console.log(
    `${DIM}Thresholds: 4.5:1 text-normal · 3.0:1 text-large · 3.0:1 UI (WCAG 2.1)${RESET}`,
  );
  console.log('');

  for (const r of allResults) {
    printThemeResult(r);
  }

  // Aggregate stats + top offenders.
  const totalChecks = allResults.reduce((s, r) => s + r.totalChecks, 0);
  const totalFailures = allResults.reduce((s, r) => s + r.failures.length, 0);
  const passingThemes = allResults.filter((r) => r.failures.length === 0).length;
  const failingThemes = allResults.length - passingThemes;

  console.log('');
  console.log(`${BOLD}Summary${RESET}`);
  console.log(
    `  ${allResults.length} (theme, mode) combos audited · ${passingThemes} clean · ${failingThemes} with failures`,
  );
  console.log(
    `  ${totalChecks} total checks · ${totalFailures} failures (${
      totalChecks === 0 ? '0.0' : ((totalFailures / totalChecks) * 100).toFixed(1)
    }%)`,
  );

  // Top 5 worst-contrast offenders across all themes.
  const allFailures: Array<Failure & { themeId: string; mode: ThemeMode }> = [];
  for (const r of allResults) {
    for (const f of r.failures) {
      allFailures.push({ ...f, themeId: r.themeId, mode: r.mode });
    }
  }
  allFailures.sort((a, b) => a.ratio - b.ratio);
  const top = allFailures.slice(0, 5);
  if (top.length > 0) {
    console.log('');
    console.log(`${BOLD}Top 5 worst-contrast offenders${RESET}`);
    for (const f of top) {
      console.log(
        `  ${RED}${fmtRatio(f.ratio)}${RESET} ${DIM}(need ${fmtRatio(f.required)})${RESET}  ${f.themeId}/${f.mode}  ${f.pair}  ${DIM}[${f.fg} on ${f.bg}]${RESET}`,
      );
    }
  }
  console.log('');

  return totalFailures === 0 ? 0 : 1;
}

process.exit(main());
