/**
 * Theme route — `/theme` (admin-gated).
 *
 * Operator picks a theme preset + light/dark mode for the GENERATED
 * UI (not the console chrome itself), and optionally overrides
 * individual DTCG tokens. Persists to `ggui.json#theme` via the
 * `/ggui/console/theme` plane.
 *
 * Wire shape (sister of `/ggui/console/llm-keys`):
 *
 *   GET /ggui/console/theme
 *     → 200 { current: ThemeConfig | null, writerEnabled: boolean }
 *     → 401 (admin auth missing) → bounce to `/admin-login`
 *
 *   POST /ggui/console/theme
 *     body: ThemeConfig | null    (null clears the field)
 *     → 200 { ok: true, current }
 *     → 400 { error: 'invalid_config', issue }
 *     → 501 { error: 'writer_not_configured', message }
 *     → 500 { error: 'write_failed', message }
 *
 * The preset list AND raw DTCG token trees are owned client-side —
 * `listThemes()` + `getRawTheme()` from `@ggui-ai/design/themes`.
 * Server only ships `current` + `writerEnabled` so it doesn't need
 * to take a `@ggui-ai/design` dep just to render a picker.
 *
 * This page renders the preset grid + light/dark toggle + Save +
 * collapsible DTCG token-override editor (color groups + semantic
 * leaves). Each leaf shows the raw `$value` and accepts a string
 * override; Save merges those into `theme.overrides` on the POST.
 * Per-leaf reset clears that path; "Clear all overrides" wipes the
 * whole map. Unknown override paths are silently ignored at the
 * loader (per `ThemeOverridesSchema` doc), so an accidentally-stale
 * key after a preset rev never fails the next manifest parse.
 *
 * Test contract (data-attrs):
 *   - `data-ggui-theme-grid`              on the preset cards container
 *   - `data-ggui-theme-card={presetId}`   on every preset card
 *   - `data-ggui-theme-mode={light|dark}` on each mode-toggle button
 *   - `data-ggui-theme-save`              on the Save button
 *   - `data-ggui-theme-error`             on the error region
 *   - `data-ggui-theme-overrides`         on the editor section
 *   - `data-ggui-theme-override-leaf`     on each leaf's row, value = path
 *   - `data-ggui-theme-override-input`    on each leaf's input
 *   - `data-ggui-theme-override-reset`    on the per-leaf reset button
 *   - `data-ggui-theme-overrides-clear`   on the global clear-all button
 */
import {
  getRawTheme,
  listThemes,
  parseTheme,
  type DtcgTheme,
  type DtcgToken,
  type ThemeEntry,
  type ThemeMode,
} from '@ggui-ai/design/themes';
import type { ThemeConfig } from '@ggui-ai/project-config';
import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { SectionHead } from '../brand/SectionHead.js';
import { navigateTo } from '../router.js';

interface ThemeStateResponse {
  readonly current: ThemeConfig | null;
  readonly writerEnabled: boolean;
  readonly uploadEnabled?: boolean;
}

type FetchState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'ready'; readonly data: ThemeStateResponse }
  | { readonly kind: 'error'; readonly message: string };

export interface Selection {
  readonly presetId: string;
  readonly mode: ThemeMode;
  readonly fromFile: boolean;
  readonly overrides: Readonly<Record<string, string>>;
}

/**
 * Resolve the currently selected `(presetId, mode, overrides)` triple
 * from the server's parsed `ThemeConfig`. Four branches mirror the
 * discriminated union shape:
 *
 *   - `null`              → default theme, light, no overrides
 *   - `string`            → preset shorthand, light, no overrides
 *   - `{ preset, … }`     → preset object form (carries overrides if set)
 *   - `{ file, mode? }`   → file form (no preset id; UI lands on
 *                            default + a banner explaining the picker
 *                            can't represent file mode yet)
 *
 * Exported for unit tests — internal callsites are restricted to this
 * module.
 */
export function readSelection(
  current: ThemeConfig | null,
  defaultPresetId: string,
): Selection {
  if (current === null) {
    return { presetId: defaultPresetId, mode: 'light', fromFile: false, overrides: {} };
  }
  if (typeof current === 'string') {
    return { presetId: current, mode: 'light', fromFile: false, overrides: {} };
  }
  if ('file' in current) {
    return {
      presetId: defaultPresetId,
      mode: current.mode ?? 'light',
      fromFile: true,
      overrides: {},
    };
  }
  return {
    presetId: current.preset,
    mode: current.mode ?? 'light',
    fromFile: false,
    overrides: current.overrides ?? {},
  };
}

/**
 * Build the `ThemeConfig` body to POST when the operator hits Save.
 * Object form (not the string shorthand) so the body always carries
 * the resolved mode — server stores what the operator saw, not a
 * shape that re-resolves to a different mode on subsequent reads.
 *
 * Empty overrides map → omit the field entirely so the persisted
 * shape stays minimal (`{ preset, mode }` instead of
 * `{ preset, mode, overrides: {} }`).
 */
export function buildPostBody(
  presetId: string,
  mode: ThemeMode,
  overrides: Readonly<Record<string, string>>,
): ThemeConfig {
  const keys = Object.keys(overrides);
  if (keys.length === 0) {
    return { preset: presetId, mode };
  }
  // Re-build the record with deterministic key order so a no-op save
  // round-trips byte-stable through `JSON.stringify` (the writer
  // re-serialises the manifest on every save, so a stable key order
  // avoids spurious diffs in `git status`).
  keys.sort();
  const sorted: Record<string, string> = {};
  for (const k of keys) sorted[k] = overrides[k]!;
  return { preset: presetId, mode, overrides: sorted };
}

export function Theme(): ReactElement {
  const presets = useMemo<readonly ThemeEntry[]>(() => listThemes(), []);
  const defaultPresetId = presets[0]?.id ?? 'ggui';

  const [state, setState] = useState<FetchState>({ kind: 'loading' });
  const [presetId, setPresetId] = useState<string>(defaultPresetId);
  const [mode, setMode] = useState<ThemeMode>('light');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [fromFile, setFromFile] = useState(false);
  // Override state is keyed by the same dot-paths the server persists.
  // We seed from `current.overrides` on refresh and then mutate locally
  // until Save POSTs. A change to `presetId` doesn't auto-clear the
  // map: leaf paths that survive across presets (e.g. `color.primary.500`)
  // SHOULD carry over so the operator can compare two presets without
  // losing their tweak. Unknown paths after a preset switch are silently
  // ignored at load time per the loader contract.
  const [overrides, setOverrides] = useState<Record<string, string>>({});

  const refresh = async (): Promise<void> => {
    setState((prev) => (prev.kind === 'ready' ? prev : { kind: 'loading' }));
    try {
      const res = await fetch('/ggui/console/theme', {
        credentials: 'include',
        headers: { accept: 'application/json' },
      });
      if (res.status === 401) {
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/theme')}`);
        return;
      }
      if (!res.ok) {
        setState({ kind: 'error', message: `server returned ${res.status}` });
        return;
      }
      const body = (await res.json()) as ThemeStateResponse;
      setState({ kind: 'ready', data: body });
      const sel = readSelection(body.current, defaultPresetId);
      setPresetId(sel.presetId);
      setMode(sel.mode);
      setFromFile(sel.fromFile);
      setOverrides({ ...sel.overrides });
    } catch (e) {
      setState({ kind: 'error', message: String(e) });
    }
  };

  useEffect(() => {
    void refresh();
  }, []);

  const setOverride = (path: string, value: string | null): void => {
    setOverrides((prev) => {
      const next = { ...prev };
      if (value === null || value === '') {
        delete next[path];
      } else {
        next[path] = value;
      }
      return next;
    });
  };

  const clearAllOverrides = (): void => {
    setOverrides({});
  };

  /**
   * Read a `.json` file the operator picked, validate it parses as
   * JSON, and POST to the upload endpoint. The server re-validates
   * (DTCG schema) and writes both the file and the manifest.
   *
   * On 200: refresh state — the picker lands in file-form (the
   * "current selection is a file-form theme" warning surfaces on the
   * sidebar so the operator knows clicking a preset will replace).
   * On 400: surface the validation message inline so they know what's
   * wrong with their JSON without reading server logs.
   */
  const uploadFile = async (file: File): Promise<void> => {
    if (state.kind !== 'ready') return;
    setErr(null);
    setBusy(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        setErr(`upload failed — file is not valid JSON: ${String(e)}`);
        return;
      }

      // Sanitise filename to the same alphabet the server enforces, so
      // operators get a client-side hint before the round-trip when
      // their OS path slipped through (rare, but cheap to catch).
      const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '-');
      const filename = /\.json$/i.test(safeName) ? safeName : `${safeName}.json`;

      const res = await fetch('/ggui/console/theme/upload', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify({ filename, content: parsed, mode }),
      });
      if (res.status === 401) {
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/theme')}`);
        return;
      }
      if (res.status === 400) {
        const body = (await res.json()) as {
          readonly error?: string;
          readonly message?: string;
          readonly issue?: unknown;
        };
        setErr(
          body.message
            ?? `upload rejected — ${body.error ?? 'invalid_content'}: ${JSON.stringify(body.issue)}`,
        );
        return;
      }
      if (res.status === 501) {
        const body = (await res.json()) as { readonly message?: string };
        setErr(
          body.message
            ?? 'Theme uploads need the CLI’s themeFileUploader — launch via `ggui serve`.',
        );
        return;
      }
      if (!res.ok) {
        setErr(`upload failed — server returned ${res.status}`);
        return;
      }
      await refresh();
    } catch (e) {
      setErr(`upload failed — ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  const save = async (): Promise<void> => {
    if (state.kind !== 'ready') return;
    setErr(null);
    setBusy(true);
    try {
      const res = await fetch('/ggui/console/theme', {
        method: 'POST',
        credentials: 'include',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(buildPostBody(presetId, mode, overrides)),
      });
      if (res.status === 401) {
        navigateTo(`/admin-login?next=${encodeURIComponent('/admin/theme')}`);
        return;
      }
      if (res.status === 501) {
        const body = (await res.json()) as { readonly message?: string };
        setErr(
          body.message
            ?? 'Theme writes need the CLI’s themeWriter — launch via `ggui serve`.',
        );
        return;
      }
      if (!res.ok) {
        setErr(`save failed — server returned ${res.status}`);
        return;
      }
      await refresh();
    } catch (e) {
      setErr(`save failed — ${String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="ggui-section">
      <SectionHead
        num="01 / theme"
        title="Pick a theme for your generated UI."
        mute="Persists to ggui.json#theme. Affects every UI the LLM emits — not the console chrome you’re looking at."
        intro={
          <>
            Each preset ships a complete DTCG token tree (color, type,
            spacing, motion). Light + dark variants are independent —
            presets that haven’t shipped a dark mode fall back to light
            on selection. The chosen theme writes to{' '}
            <code className="ggui-code">ggui.json</code> and takes
            effect on the next generation.
          </>
        }
      />

      {state.kind === 'loading' ? (
        <p className="ggui-muted" style={{ margin: 0, padding: 12 }}>
          Loading themes…
        </p>
      ) : state.kind === 'error' ? (
        <p
          className="ggui-muted"
          style={{ margin: 0, padding: 12 }}
          data-ggui-theme-error
        >
          Couldn’t load theme state — {state.message}
        </p>
      ) : (
        <ThemePicker
          presets={presets}
          selectedPresetId={presetId}
          mode={mode}
          writerEnabled={state.data.writerEnabled}
          uploadEnabled={state.data.uploadEnabled ?? false}
          fromFile={fromFile}
          busy={busy}
          err={err}
          overrides={overrides}
          onSelectPreset={setPresetId}
          onSelectMode={setMode}
          onSetOverride={setOverride}
          onClearAllOverrides={clearAllOverrides}
          onSave={() => {
            void save();
          }}
          onUploadFile={(file) => {
            void uploadFile(file);
          }}
        />
      )}
    </section>
  );
}

interface ThemePickerProps {
  readonly presets: readonly ThemeEntry[];
  readonly selectedPresetId: string;
  readonly mode: ThemeMode;
  readonly writerEnabled: boolean;
  readonly uploadEnabled: boolean;
  readonly fromFile: boolean;
  readonly busy: boolean;
  readonly err: string | null;
  readonly overrides: Readonly<Record<string, string>>;
  readonly onSelectPreset: (id: string) => void;
  readonly onSelectMode: (mode: ThemeMode) => void;
  readonly onSetOverride: (path: string, value: string | null) => void;
  readonly onClearAllOverrides: () => void;
  readonly onSave: () => void;
  readonly onUploadFile: (file: File) => void;
}

function ThemePicker({
  presets,
  selectedPresetId,
  mode,
  writerEnabled,
  uploadEnabled,
  fromFile,
  busy,
  err,
  overrides,
  onSelectPreset,
  onSelectMode,
  onSetOverride,
  onClearAllOverrides,
  onSave,
  onUploadFile,
}: ThemePickerProps): ReactElement {
  const selected = presets.find((p) => p.id === selectedPresetId);
  const darkAvailable = selected?.modes.includes('dark') ?? false;

  // Effective mode — if the operator selected dark on a light-only
  // preset, the server resolves it back to light. Surface the
  // fallback in the UI so the operator isn't surprised.
  const effectiveMode: ThemeMode = mode === 'dark' && !darkAvailable ? 'light' : mode;

  // Raw token tree for the active (preset, effectiveMode). Drives the
  // editor below — operator types over `$value` literals, the picker
  // diffs them against the tree to compute the override map.
  // `getRawTheme` returns `undefined` when `presetId` is unregistered;
  // the editor renders an "unknown preset" hint in that case rather
  // than crashing. (Can happen mid-render after a `presetId` switch
  // when the operator typed a custom id into a future schema field;
  // not a normal interaction path, but cheap to guard.)
  const rawTheme = getRawTheme(selectedPresetId, effectiveMode);

  return (
    <div
      data-ggui-theme-layout
      style={{
        display: 'flex',
        gap: 16,
        alignItems: 'flex-start',
      }}
    >
      {/* ── Left sidebar: controls ──────────────────────────────── */}
      <aside
        aria-label="theme picker controls"
        style={{
          flex: '0 0 360px',
          minWidth: 320,
          maxWidth: 400,
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
          position: 'sticky',
          top: 16,
        }}
      >
        {/* Mode toggle — always-visible at top of sidebar */}
        <div
          className="ggui-stack__head"
          style={{ display: 'flex', alignItems: 'center', gap: 8 }}
        >
          <span className="ggui-stack__num">THM</span>
          <span className="ggui-stack__label">mode</span>
          <span style={{ marginLeft: 'auto', display: 'inline-flex', gap: 8 }}>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              data-ggui-theme-mode="light"
              onClick={() => onSelectMode('light')}
              {...(effectiveMode === 'light' ? { 'aria-pressed': true } : {})}
              style={effectiveMode === 'light' ? { fontWeight: 600 } : undefined}
            >
              ◐ Light
            </button>
            <button
              type="button"
              className="ggui-btn ggui-btn--ghost"
              data-ggui-theme-mode="dark"
              onClick={() => onSelectMode('dark')}
              disabled={!darkAvailable}
              title={
                darkAvailable
                  ? 'Switch to dark variant'
                  : 'This preset hasn’t shipped a dark variant yet'
              }
              {...(effectiveMode === 'dark' ? { 'aria-pressed': true } : {})}
              style={effectiveMode === 'dark' ? { fontWeight: 600 } : undefined}
            >
              ◑ Dark
            </button>
          </span>
        </div>

        {fromFile ? (
          <p className="ggui-muted" style={{ margin: 0, fontSize: 12 }}>
            ⚠ Current selection is a file-form theme (
            <code className="ggui-code">{'{ file: "..." }'}</code>). Saving
            a preset below will replace it.
          </p>
        ) : null}

        {!writerEnabled ? (
          <p className="ggui-muted" style={{ margin: 0, fontSize: 12 }}>
            Read-only — launch via <code className="ggui-code">ggui serve</code>{' '}
            to enable saves.
          </p>
        ) : null}

        {/* Preset list — vertical stack of compact cards. The grid
            from the C4-ui slice is rotated to a list so the sidebar
            stays narrow; the right pane carries the gestalt now via
            <ThemePreview>. */}
        <div
          data-ggui-theme-grid
          style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
        >
          {presets.map((preset) => (
            <ThemeCard
              key={preset.id}
              preset={preset}
              selected={preset.id === selectedPresetId}
              mode={effectiveMode}
              onSelect={() => onSelectPreset(preset.id)}
            />
          ))}
        </div>

        {/* Save row — sticky at the bottom of the sidebar visually,
            stays in normal flow so it scrolls with the override
            editor when the operator's working a long preset. */}
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
            paddingTop: 4,
            borderTop: '1px solid currentColor',
            marginTop: 4,
            opacity: 0.95,
          }}
        >
          <button
            type="button"
            className="ggui-btn"
            data-ggui-theme-save
            disabled={busy || !writerEnabled}
            onClick={onSave}
            style={{ flex: 1 }}
          >
            <span className="ggui-btn__dot" aria-hidden />
            {busy ? 'saving…' : 'Save to ggui.json'}
          </button>
        </div>
        <p
          className="ggui-muted"
          style={{ margin: 0, fontSize: 11, lineHeight: 1.4 }}
        >
          <code className="ggui-code">{selectedPresetId}</code>{' '}
          · <code className="ggui-code">{effectiveMode}</code>
          {Object.keys(overrides).length > 0 ? (
            <>
              {' '}
              · <code className="ggui-code">
                +{Object.keys(overrides).length} override
                {Object.keys(overrides).length === 1 ? '' : 's'}
              </code>
            </>
          ) : null}
          {effectiveMode !== mode ? (
            <>
              {' '}
              · requested <code className="ggui-code">{mode}</code>, fell back
            </>
          ) : null}
        </p>

        {/* Custom-theme escape hatch — operators with a brand kit JSON
            shouldn't have to edit each token by hand in the override
            editor. The upload button writes a `theme.json` next to
            ggui.json and points the manifest at it; the docs link
            walks devs through baking a preset into the bundle. */}
        <CustomThemeRow
          uploadEnabled={uploadEnabled}
          busy={busy}
          onUploadFile={onUploadFile}
        />

        {err ? (
          <p
            className="ggui-muted"
            style={{ margin: 0, color: '#c0392b', fontSize: 12 }}
            data-ggui-theme-error
          >
            {err}
          </p>
        ) : null}

        {/* Override editor — bottom of sidebar so the operator's eye
            naturally lands on preset → mode → save → tweaks (in
            decreasing-frequency order). */}
        {rawTheme ? (
          <ThemeOverridesEditor
            rawTheme={rawTheme}
            overrides={overrides}
            onSetOverride={onSetOverride}
            onClearAll={onClearAllOverrides}
          />
        ) : (
          <p className="ggui-muted" style={{ margin: 0, fontSize: 12 }}>
            ⚠ <code className="ggui-code">{selectedPresetId}</code> isn’t
            registered on this build. Saving still writes the manifest;
            overrides require a recognised preset.
          </p>
        )}
      </aside>

      {/* ── Right pane: live preview of the selected (preset, mode, overrides) ── */}
      <main
        aria-label="theme preview"
        style={{
          flex: 1,
          minWidth: 0,
          // Match the sidebar's vertical rhythm so they baseline-align
          // at the section title line.
          display: 'flex',
          flexDirection: 'column',
          gap: 12,
        }}
      >
        {rawTheme ? (
          <ThemePreview
            presetId={selectedPresetId}
            mode={effectiveMode}
            rawTheme={rawTheme}
            overrides={overrides}
          />
        ) : (
          <div className="ggui-card">
            <div className="ggui-card__head">
              <span className="ggui-card__title">preview unavailable</span>
              <span className="ggui-card__num">PRV / 00</span>
            </div>
            <div className="ggui-card__body">
              <p className="ggui-muted" style={{ margin: 0 }}>
                <code className="ggui-code">{selectedPresetId}</code> isn’t a
                registered preset on this build, so there’s no token tree to
                paint from. Pick another preset on the left.
              </p>
            </div>
          </div>
        )}
      </main>
    </div>
  );
}

interface ThemeCardProps {
  readonly preset: ThemeEntry;
  readonly selected: boolean;
  readonly mode: ThemeMode;
  readonly onSelect: () => void;
}

export interface LeafGroup {
  /** Display label for the section header. */
  readonly label: string;
  /** Diagnostic dot-path prefix (`color.primary`, `font.size`, etc.). */
  readonly prefix: string;
  /** Each leaf is `{ path, $value }` — `path` is the dot-path
   * `color.primary.500`, `$value` is the resolved token value. */
  readonly leaves: readonly { readonly path: string; readonly value: string }[];
}

/**
 * Walk a {@link DtcgTheme} into render-ready groups for the editor.
 *
 * Strategy: surface the leaves an operator most often wants to tweak —
 * color tokens (primary + neutral ladders, plus the eight semantic
 * roles), shape (radius + shadow), and typography (size + weight). The
 * full tree is large (~150 leaves); we deliberately omit motion +
 * canvas + font.lineHeight from the editor surface for v1 because
 * those almost never get hand-tuned. A "show full tree" affordance
 * could come in a follow-up.
 *
 * Skip rules:
 *
 *   - Ladders with NO entries collapse to nothing (defensive — every
 *     shipping preset has primary + neutral, but a future custom
 *     preset might not).
 *   - Tokens whose `$value` isn't a string serialise via
 *     `JSON.stringify`. Only `canvas.colors` and a handful of others
 *     are non-string in practice; the editor section we emit doesn't
 *     include them, so this branch is mostly defensive.
 */
export function flattenLeaves(theme: DtcgTheme): readonly LeafGroup[] {
  const stringify = (token: DtcgToken | DtcgToken<unknown>): string => {
    const v = token.$value;
    return typeof v === 'string' ? v : JSON.stringify(v);
  };

  const ladderLeaves = (
    prefix: string,
    record: Record<string, DtcgToken>,
  ): readonly { path: string; value: string }[] => {
    const keys = Object.keys(record).sort((a, b) => {
      // Numeric stops (`50`, `100`, …, `950`) sort numerically; text
      // labels fall through to alphabetical.
      const an = Number(a);
      const bn = Number(b);
      if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      return a.localeCompare(b);
    });
    return keys.map((k) => ({
      path: `${prefix}.${k}`,
      value: stringify(record[k]!),
    }));
  };

  const groups: LeafGroup[] = [];

  // color.primary ladder
  groups.push({
    label: 'Color · Primary',
    prefix: 'color.primary',
    leaves: ladderLeaves('color.primary', theme.color.primary),
  });
  // color.neutral ladder
  groups.push({
    label: 'Color · Neutral',
    prefix: 'color.neutral',
    leaves: ladderLeaves('color.neutral', theme.color.neutral),
  });
  // Semantic color scales (success/warning/error/info — 50..800 ladders).
  groups.push({
    label: 'Color · Success',
    prefix: 'color.success',
    leaves: ladderLeaves('color.success', theme.color.success),
  });
  groups.push({
    label: 'Color · Warning',
    prefix: 'color.warning',
    leaves: ladderLeaves('color.warning', theme.color.warning),
  });
  groups.push({
    label: 'Color · Error',
    prefix: 'color.error',
    leaves: ladderLeaves('color.error', theme.color.error),
  });
  groups.push({
    label: 'Color · Info',
    prefix: 'color.info',
    leaves: ladderLeaves('color.info', theme.color.info),
  });
  // Material 3 semantic role pairs (8 leaves).
  groups.push({
    label: 'Color · Roles',
    prefix: 'color',
    leaves: [
      { path: 'color.surface', value: stringify(theme.color.surface) },
      { path: 'color.onSurface', value: stringify(theme.color.onSurface) },
      { path: 'color.surfaceVariant', value: stringify(theme.color.surfaceVariant) },
      { path: 'color.onSurfaceVariant', value: stringify(theme.color.onSurfaceVariant) },
      { path: 'color.container', value: stringify(theme.color.container) },
      { path: 'color.onContainer', value: stringify(theme.color.onContainer) },
      { path: 'color.outline', value: stringify(theme.color.outline) },
      { path: 'color.outlineVariant', value: stringify(theme.color.outlineVariant) },
    ],
  });
  // shape.radius
  groups.push({
    label: 'Shape · Radius',
    prefix: 'shape.radius',
    leaves: ladderLeaves('shape.radius', theme.shape.radius),
  });
  // shape.shadow
  groups.push({
    label: 'Shape · Shadow',
    prefix: 'shape.shadow',
    leaves: ladderLeaves('shape.shadow', theme.shape.shadow),
  });
  // font.family (always sans, optionally mono)
  const familyLeaves: { path: string; value: string }[] = [
    { path: 'font.family.sans', value: stringify(theme.font.family.sans) },
  ];
  if (theme.font.family.mono) {
    familyLeaves.push({
      path: 'font.family.mono',
      value: stringify(theme.font.family.mono),
    });
  }
  groups.push({
    label: 'Font · Family',
    prefix: 'font.family',
    leaves: familyLeaves,
  });
  // font.size (numeric stops common: xs/sm/md/lg/xl)
  groups.push({
    label: 'Font · Size',
    prefix: 'font.size',
    leaves: ladderLeaves('font.size', theme.font.size),
  });
  // font.weight
  groups.push({
    label: 'Font · Weight',
    prefix: 'font.weight',
    leaves: ladderLeaves('font.weight', theme.font.weight),
  });
  // spacing scale
  groups.push({
    label: 'Spacing',
    prefix: 'spacing',
    leaves: ladderLeaves('spacing', theme.spacing),
  });

  return groups.filter((g) => g.leaves.length > 0);
}

interface ThemeOverridesEditorProps {
  readonly rawTheme: DtcgTheme;
  readonly overrides: Readonly<Record<string, string>>;
  readonly onSetOverride: (path: string, value: string | null) => void;
  readonly onClearAll: () => void;
}

/**
 * Sidebar row that surfaces the two custom-theme escape hatches:
 *
 *   1. **Upload** — operator picks a `.json` file with a DTCG token tree.
 *      We POST it to `/ggui/console/theme/upload`; on success the server
 *      writes the file next to ggui.json and switches the manifest to
 *      `{ file: './<name>.json', mode }`. The override editor doesn't
 *      apply when sourced from a file — `fromFile` warning above
 *      handles communicating that.
 *
 *   2. **Docs link** — for the dev-track path (register a baked-in
 *      preset). Opens the CUSTOM_THEMES.md doc in a new tab.
 *
 * The upload button hides when the server signals `uploadEnabled:false`
 * (e.g. a host bound `createGguiServer` directly without supplying a
 * `themeFileUploader`); the docs link is always visible since it's a
 * static external URL.
 */
interface CustomThemeRowProps {
  readonly uploadEnabled: boolean;
  readonly busy: boolean;
  readonly onUploadFile: (file: File) => void;
}

const CUSTOM_THEMES_DOC_URL =
  'https://github.com/ggui-ai/ggui/blob/main/design/CUSTOM_THEMES.md';

function CustomThemeRow({
  uploadEnabled,
  busy,
  onUploadFile,
}: CustomThemeRowProps): ReactElement {
  return (
    <div
      data-ggui-theme-custom-row
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        paddingTop: 8,
        marginTop: 4,
        borderTop: '1px dashed currentColor',
        opacity: 0.95,
      }}
    >
      {uploadEnabled ? (
        <label
          className="ggui-btn ggui-btn--ghost"
          data-ggui-theme-upload
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 8,
            cursor: busy ? 'not-allowed' : 'pointer',
            justifyContent: 'center',
          }}
        >
          <input
            type="file"
            accept=".json,application/json"
            disabled={busy}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file !== undefined) onUploadFile(file);
              // Reset so picking the SAME file twice still fires onChange
              e.target.value = '';
            }}
            style={{
              position: 'absolute',
              width: 1,
              height: 1,
              padding: 0,
              margin: -1,
              overflow: 'hidden',
              clip: 'rect(0,0,0,0)',
              whiteSpace: 'nowrap',
              border: 0,
            }}
          />
          ↑ Upload theme.json
        </label>
      ) : null}
      <a
        href={CUSTOM_THEMES_DOC_URL}
        target="_blank"
        rel="noreferrer noopener"
        data-ggui-theme-docs
        className="ggui-muted"
        style={{
          fontSize: 11,
          textDecoration: 'underline',
          textAlign: 'center',
          opacity: 0.85,
        }}
      >
        Roll your own theme →
      </a>
    </div>
  );
}

function ThemeOverridesEditor({
  rawTheme,
  overrides,
  onSetOverride,
  onClearAll,
}: ThemeOverridesEditorProps): ReactElement {
  // Memoize the flattened leaf groups by raw theme identity. Switching
  // preset/mode reallocates the tree so the cache key flips naturally;
  // typing into an override field doesn't invalidate it.
  const groups = useMemo(() => flattenLeaves(rawTheme), [rawTheme]);
  const overrideCount = Object.keys(overrides).length;

  return (
    <div
      data-ggui-theme-overrides
      className="ggui-stack"
      style={{ marginTop: 16 }}
      aria-label="theme token overrides"
    >
      <div className="ggui-stack__head">
        <span className="ggui-stack__num">DTCG</span>
        <span className="ggui-stack__label">overrides</span>
        <span className="ggui-stack__count">
          {overrideCount} {overrideCount === 1 ? 'override' : 'overrides'}
        </span>
        {overrideCount > 0 ? (
          <button
            type="button"
            className="ggui-btn ggui-btn--ghost"
            data-ggui-theme-overrides-clear
            onClick={onClearAll}
            style={{ marginLeft: 'auto' }}
          >
            Clear all
          </button>
        ) : null}
      </div>
      <p className="ggui-muted" style={{ margin: '8px 0', fontSize: 12 }}>
        Tweak individual DTCG tokens on top of the selected preset. Each
        leaf shows the preset’s shipped <code className="ggui-code">$value</code>;
        type a CSS-valid replacement to override it. Per-leaf{' '}
        <em>reset</em> clears that path; saving with no overrides writes
        the bare <code className="ggui-code">{'{ preset, mode }'}</code>{' '}
        shape (no <code className="ggui-code">overrides</code> field).
      </p>
      {groups.map((group) => (
        <details
          key={group.prefix}
          // signature + claudic primary ladders are the most-tweaked
          // sets; default-open them. Everything else stays collapsed
          // so the page renders short on first paint. Operators can
          // expand as needed.
          {...(group.prefix === 'color.primary' ? { open: true } : {})}
          style={{ marginTop: 8 }}
        >
          <summary
            style={{
              cursor: 'pointer',
              padding: '6px 0',
              fontSize: 13,
              fontWeight: 500,
              userSelect: 'none',
            }}
          >
            {group.label}{' '}
            <span className="ggui-muted" style={{ fontSize: 11 }}>
              ({group.leaves.length}
              {group.leaves.some((l) => l.path in overrides)
                ? `, +${group.leaves.filter((l) => l.path in overrides).length} overridden`
                : ''}
              )
            </span>
          </summary>
          <div
            style={{
              display: 'grid',
              gap: 6,
              gridTemplateColumns: 'auto 1fr auto',
              padding: '8px 0 8px 12px',
              alignItems: 'center',
              fontSize: 12,
            }}
          >
            {group.leaves.map((leaf) => (
              <ThemeOverrideRow
                key={leaf.path}
                path={leaf.path}
                presetValue={leaf.value}
                overrideValue={overrides[leaf.path] ?? null}
                onChange={onSetOverride}
              />
            ))}
          </div>
        </details>
      ))}
    </div>
  );
}

interface ThemeOverrideRowProps {
  readonly path: string;
  readonly presetValue: string;
  readonly overrideValue: string | null;
  readonly onChange: (path: string, value: string | null) => void;
}

function ThemeOverrideRow({
  path,
  presetValue,
  overrideValue,
  onChange,
}: ThemeOverrideRowProps): ReactElement {
  const overridden = overrideValue !== null;
  // Visible value: the override (when set) OR the preset's $value as
  // a placeholder — but operators can edit either way without losing
  // the preset reference (placeholder hangs around as a hint).
  const inputValue = overrideValue ?? '';
  return (
    <div
      data-ggui-theme-override-leaf={path}
      style={{
        display: 'contents',
      }}
    >
      <code
        className="ggui-code"
        style={{ fontSize: 11, opacity: 0.85, padding: '2px 6px' }}
      >
        {path}
      </code>
      <input
        type="text"
        data-ggui-theme-override-input
        value={inputValue}
        placeholder={presetValue}
        onChange={(e) => {
          const v = e.target.value;
          onChange(path, v.length === 0 ? null : v);
        }}
        spellCheck={false}
        autoComplete="off"
        style={{
          fontSize: 12,
          fontFamily: 'var(--ggui-font-mono, ui-monospace, monospace)',
          padding: '4px 8px',
          border: '1px solid currentColor',
          borderRadius: 4,
          background: 'transparent',
          color: 'inherit',
          opacity: overridden ? 1 : 0.85,
          outline: overridden ? '1px solid currentColor' : 'none',
        }}
        aria-label={`override ${path}`}
      />
      <button
        type="button"
        className="ggui-btn ggui-btn--ghost"
        data-ggui-theme-override-reset
        onClick={() => onChange(path, null)}
        disabled={!overridden}
        style={{
          fontSize: 11,
          padding: '2px 8px',
          opacity: overridden ? 1 : 0.4,
          cursor: overridden ? 'pointer' : 'default',
        }}
        title={
          overridden
            ? 'Reset this leaf to the preset value'
            : 'No override set on this leaf'
        }
      >
        reset
      </button>
    </div>
  );
}

function ThemeCard({ preset, selected, mode, onSelect }: ThemeCardProps): ReactElement {
  const supportsDark = preset.modes.includes('dark');
  // Two-swatch preview — reads each preset's primary-500 + surface
  // direct from the registry. Quick way for an operator to scan the
  // sidebar list and pick by colour-feel before clicking.
  const swatchTheme = getRawTheme(preset.id, mode);
  const primary = swatchTheme?.color.primary['500']?.$value;
  const surface = swatchTheme?.color.surface.$value;
  return (
    <button
      type="button"
      data-ggui-theme-card={preset.id}
      onClick={onSelect}
      aria-pressed={selected}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        textAlign: 'left',
        cursor: 'pointer',
        border: selected
          ? '2px solid currentColor'
          : '1px solid currentColor',
        borderRadius: 6,
        background: 'transparent',
        color: 'inherit',
        opacity: selected ? 1 : 0.85,
      }}
    >
      <span
        aria-hidden
        style={{
          display: 'inline-flex',
          flexShrink: 0,
          width: 28,
          height: 28,
          borderRadius: 4,
          overflow: 'hidden',
          border: '1px solid currentColor',
        }}
      >
        <span style={{ flex: 1, background: primary ?? '#ccc' }} />
        <span style={{ flex: 1, background: surface ?? '#fff' }} />
      </span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: 'block',
            fontSize: 13,
            fontWeight: selected ? 600 : 500,
          }}
        >
          {preset.name}
        </span>
        <span
          className="ggui-muted"
          style={{
            display: 'block',
            fontSize: 11,
            opacity: 0.75,
          }}
        >
          {preset.id === 'claudic' ? 'claude.ai · ' : ''}
          {supportsDark ? 'Light · Dark' : 'Light only'}
        </span>
      </span>
    </button>
  );
}

// =============================================================================
// Live preview — paints sample primitives with the (preset, mode, overrides)
// CSS variables. Built from `parseTheme(presetId, applyOverrides(rawTheme,
// overrides))` so the operator sees their tweaks reflected in real time.
// =============================================================================

interface ThemePreviewProps {
  readonly presetId: string;
  readonly mode: ThemeMode;
  readonly rawTheme: DtcgTheme;
  readonly overrides: Readonly<Record<string, string>>;
}

/**
 * Deep-clone the raw `DtcgTheme` and walk each override's dot-path
 * to mutate the `$value` leaf. Mirrors `theme-loader::applyOverrides`
 * (server-side) — both must agree on path resolution so the preview
 * reflects what the next `getTheme(preset, mode)` will produce after
 * Save + restart.
 *
 * Unknown paths silently drop, matching `ThemeOverridesSchema`'s
 * documented behaviour. `$value` is mutated in-place on the clone.
 */
function applyOverridesToRawTheme(
  raw: DtcgTheme,
  overrides: Readonly<Record<string, string>>,
): DtcgTheme {
  if (Object.keys(overrides).length === 0) return raw;
  const cloned = structuredClone(raw) as unknown as Record<string, unknown>;
  for (const [path, value] of Object.entries(overrides)) {
    const segs = path.split('.');
    let cursor: Record<string, unknown> = cloned;
    let valid = true;
    for (let i = 0; i < segs.length - 1; i += 1) {
      const seg = segs[i];
      if (seg === undefined) {
        valid = false;
        break;
      }
      const next = cursor[seg];
      if (next === undefined || next === null || typeof next !== 'object') {
        valid = false;
        break;
      }
      cursor = next as Record<string, unknown>;
    }
    if (!valid) continue;
    const lastSeg = segs[segs.length - 1];
    if (lastSeg === undefined) continue;
    const leaf = cursor[lastSeg];
    if (leaf === null || typeof leaf !== 'object') continue;
    (leaf as { $value: string }).$value = value;
  }
  return cloned as unknown as DtcgTheme;
}

function ThemePreview({
  presetId,
  mode,
  rawTheme,
  overrides,
}: ThemePreviewProps): ReactElement {
  // Stable scope class — a leading letter guarantees CSS-identifier
  // legality. Reused across re-renders so the injected `<style>` block's
  // selector stays stable; React's `<style>` element gets keyed off it
  // implicitly (same string → same element).
  const scopeClass = useMemo(
    () => `ggui-theme-preview-${presetId}-${mode}`,
    [presetId, mode],
  );

  // Apply overrides → parseTheme → cssVariables. The variables block
  // ships `:root { ... }`; we rewrite to `.scope { ... }` so the
  // preview's tokens don't leak into the console chrome (which has
  // its own `:root`-scoped tokens).
  const css = useMemo(() => {
    const merged = applyOverridesToRawTheme(rawTheme, overrides);
    const parsed = parseTheme(presetId, merged);
    const scoped = parsed.cssVariables.replace(
      /^:root\s*\{/,
      `.${scopeClass} {`,
    );
    return `${scoped}\n${parsed.cssKeyframes}`;
  }, [rawTheme, overrides, presetId, scopeClass]);

  return (
    <>
      {/* Inject scoped CSS as a sibling style tag. React mounts +
          replaces the textContent in place when `css` changes; no
          flicker. */}
      <style data-ggui-theme-preview-style={scopeClass}>{css}</style>
      <div
        data-ggui-theme-preview
        className={scopeClass}
        style={{
          // Surface the preset's surface + onSurface as the local
          // background + text. The preview is a "what your generated
          // UI would look like" mock, so it should NOT inherit the
          // console's chrome colors.
          background: 'var(--ggui-color-surface)',
          color: 'var(--ggui-color-onSurface)',
          fontFamily: 'var(--ggui-font-family-sans)',
          padding: 'var(--ggui-spacing-lg, 24px)',
          borderRadius: 'var(--ggui-shape-radius-lg, 12px)',
          border: '1px solid var(--ggui-color-outline)',
          boxShadow: 'var(--ggui-shape-shadow-md)',
          display: 'flex',
          flexDirection: 'column',
          gap: 'var(--ggui-spacing-lg, 24px)',
        }}
      >
        <PreviewHeader presetName={rawTheme.$name} mode={mode} />
        <PreviewTypography />
        <PreviewButtons />
        <PreviewCard />
        <PreviewColorRamps theme={rawTheme} overrides={overrides} />
        <PreviewSemantic />
      </div>
    </>
  );
}

function PreviewHeader({
  presetName,
  mode,
}: {
  readonly presetName: string;
  readonly mode: ThemeMode;
}): ReactElement {
  return (
    <header
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'baseline',
        gap: 12,
        flexWrap: 'wrap',
        borderBottom: '1px solid var(--ggui-color-outlineVariant)',
        paddingBottom: 'var(--ggui-spacing-md, 16px)',
      }}
    >
      <span
        style={{
          fontSize: 'var(--ggui-font-size-2xl, 1.5rem)',
          fontWeight: 'var(--ggui-font-weight-semibold, 600)',
        }}
      >
        {presetName}
      </span>
      <span
        style={{
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          color: 'var(--ggui-color-onSurfaceVariant)',
          fontFamily: 'var(--ggui-font-family-mono)',
        }}
      >
        {mode}
      </span>
    </header>
  );
}

function PreviewTypography(): ReactElement {
  return (
    <section
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <h3
        style={{
          margin: 0,
          fontSize: 'var(--ggui-font-size-xl, 1.25rem)',
          fontWeight: 'var(--ggui-font-weight-semibold, 600)',
          lineHeight: 'var(--ggui-font-lineHeight-tight, 1.25)',
        }}
      >
        Typography reads naturally
      </h3>
      <p
        style={{
          margin: 0,
          fontSize: 'var(--ggui-font-size-base, 1rem)',
          lineHeight: 'var(--ggui-font-lineHeight-normal, 1.5)',
        }}
      >
        The body paragraph is what generated UIs use for prose. Inline{' '}
        <code
          style={{
            fontFamily: 'var(--ggui-font-family-mono)',
            fontSize: '0.9em',
            background: 'var(--ggui-color-surfaceVariant)',
            color: 'var(--ggui-color-onSurfaceVariant)',
            padding: '0.1em 0.4em',
            borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
          }}
        >
          code
        </code>{' '}
        and a{' '}
        <a
          href="#preview"
          style={{
            color: 'var(--ggui-color-primary-600)',
            textDecorationColor: 'var(--ggui-color-primary-400)',
          }}
          onClick={(e) => e.preventDefault()}
        >
          link
        </a>{' '}
        sit alongside.
      </p>
      <p
        className="ggui-muted"
        style={{
          margin: 0,
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          color: 'var(--ggui-color-onSurfaceVariant)',
        }}
      >
        Caption text — softer contrast for secondary info.
      </p>
    </section>
  );
}

function PreviewButtons(): ReactElement {
  return (
    <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
      <button
        type="button"
        onClick={(e) => e.preventDefault()}
        style={{
          padding: '8px 16px',
          background: 'var(--ggui-color-primary-500)',
          color: 'var(--ggui-color-surface)',
          border: 'none',
          borderRadius: 'var(--ggui-shape-radius-md, 8px)',
          fontFamily: 'var(--ggui-font-family-sans)',
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          fontWeight: 'var(--ggui-font-weight-medium, 500)',
          cursor: 'pointer',
          boxShadow: 'var(--ggui-shape-shadow-sm)',
        }}
      >
        Primary
      </button>
      <button
        type="button"
        onClick={(e) => e.preventDefault()}
        style={{
          padding: '8px 16px',
          background: 'transparent',
          color: 'var(--ggui-color-primary-600)',
          border: '1px solid var(--ggui-color-primary-500)',
          borderRadius: 'var(--ggui-shape-radius-md, 8px)',
          fontFamily: 'var(--ggui-font-family-sans)',
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          fontWeight: 'var(--ggui-font-weight-medium, 500)',
          cursor: 'pointer',
        }}
      >
        Outline
      </button>
      <button
        type="button"
        onClick={(e) => e.preventDefault()}
        style={{
          padding: '8px 16px',
          background: 'transparent',
          color: 'var(--ggui-color-onSurfaceVariant)',
          border: 'none',
          borderRadius: 'var(--ggui-shape-radius-md, 8px)',
          fontFamily: 'var(--ggui-font-family-sans)',
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          cursor: 'pointer',
        }}
      >
        Ghost
      </button>
    </section>
  );
}

function PreviewCard(): ReactElement {
  return (
    <section
      style={{
        background: 'var(--ggui-color-container)',
        color: 'var(--ggui-color-onContainer)',
        padding: 'var(--ggui-spacing-md, 16px)',
        borderRadius: 'var(--ggui-shape-radius-lg, 12px)',
        boxShadow: 'var(--ggui-shape-shadow-lg)',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
      }}
    >
      <strong
        style={{
          fontSize: 'var(--ggui-font-size-lg, 1.125rem)',
          fontWeight: 'var(--ggui-font-weight-semibold, 600)',
        }}
      >
        Container card
      </strong>
      <span style={{ fontSize: 'var(--ggui-font-size-sm, 0.875rem)' }}>
        Painted with <code style={{ fontFamily: 'var(--ggui-font-family-mono)' }}>
          color.container
        </code>{' '}
        + <code style={{ fontFamily: 'var(--ggui-font-family-mono)' }}>
          color.onContainer
        </code>{' '}
        — the role pair generated UIs reach for to highlight
        primary-tinted content.
      </span>
      <input
        type="text"
        defaultValue="Form input — focus to see border"
        onChange={() => {}}
        style={{
          padding: '6px 10px',
          background: 'var(--ggui-color-surface)',
          color: 'var(--ggui-color-onSurface)',
          border: '1px solid var(--ggui-color-outline)',
          borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
          fontFamily: 'var(--ggui-font-family-sans)',
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          outline: 'none',
        }}
      />
    </section>
  );
}

function PreviewColorRamps({
  theme,
  overrides,
}: {
  readonly theme: DtcgTheme;
  readonly overrides: Readonly<Record<string, string>>;
}): ReactElement {
  // Apply overrides locally so the swatches reflect tweaks without
  // re-deriving from `var()` (the CSS-vars approach works for the
  // semantic roles above but for the ladder strip we want the literal
  // hex visible inline as a tooltip).
  const merged = useMemo(
    () => applyOverridesToRawTheme(theme, overrides),
    [theme, overrides],
  );
  const renderRamp = (
    label: string,
    record: Record<string, DtcgToken>,
    sortNumeric: boolean,
  ): ReactElement => {
    const keys = Object.keys(record).sort((a, b) => {
      if (sortNumeric) {
        const an = Number(a);
        const bn = Number(b);
        if (Number.isFinite(an) && Number.isFinite(bn)) return an - bn;
      }
      return a.localeCompare(b);
    });
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span
          style={{
            width: 64,
            fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
            color: 'var(--ggui-color-onSurfaceVariant)',
          }}
        >
          {label}
        </span>
        <div
          style={{
            display: 'flex',
            flex: 1,
            borderRadius: 'var(--ggui-shape-radius-sm, 4px)',
            overflow: 'hidden',
            border: '1px solid var(--ggui-color-outlineVariant)',
          }}
        >
          {keys.map((k) => {
            const t = record[k];
            if (!t) return null;
            return (
              <span
                key={k}
                title={`${label.toLowerCase()}.${k} · ${t.$value}`}
                style={{
                  flex: 1,
                  height: 24,
                  background: t.$value,
                }}
              />
            );
          })}
        </div>
      </div>
    );
  };
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <strong
        style={{
          fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
          color: 'var(--ggui-color-onSurfaceVariant)',
          textTransform: 'uppercase',
          letterSpacing: '0.06em',
        }}
      >
        Color ramps
      </strong>
      {renderRamp('Primary', merged.color.primary, true)}
      {renderRamp('Neutral', merged.color.neutral, true)}
    </section>
  );
}

function PreviewSemantic(): ReactElement {
  const dot = (color: string, label: string): ReactElement => (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 'var(--ggui-font-size-sm, 0.875rem)',
      }}
    >
      <span
        aria-hidden
        style={{
          width: 12,
          height: 12,
          borderRadius: '50%',
          background: color,
          border: '1px solid var(--ggui-color-outline)',
        }}
      />
      <span style={{ color: 'var(--ggui-color-onSurfaceVariant)' }}>
        {label}
      </span>
    </span>
  );
  return (
    <section style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
      {dot('var(--ggui-color-success)', 'success')}
      {dot('var(--ggui-color-warning)', 'warning')}
      {dot('var(--ggui-color-error)', 'error')}
      {dot('var(--ggui-color-info)', 'info')}
    </section>
  );
}
