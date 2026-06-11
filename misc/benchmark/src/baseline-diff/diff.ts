/**
 * Baseline-diff logic — pure functions, no IO.
 *
 * IO (reading files, writing diff JSON) lives in the CLI script
 * `core/scripts/bench-baseline-diff.mjs`. Keeping this module pure
 * means tests drive it with in-memory fixtures and the full diff
 * matrix (present/missing/drift/etc.) is covered without mocks.
 */

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  BenchBaselineManifest,
  BenchManifestEntry,
  BenchName,
  BenchStatus,
} from '../baseline/manifest.js';
import type {
  BenchBaselineDiff,
  BenchDiffEntry,
  FieldDelta,
  RowDiff,
  StatBand,
  StatusChange,
  SummaryDiff,
} from './types.js';

// ─── Per-bench diff specs ─────────────────────────────────────────
//
// Each bench's summary is an array of group rows. The spec tells the
// diff where the key lives + which fields to surface. Centralizing
// this here keeps diff.ts the single place to update when a bench
// grows a field.
//
// IMPORTANT: scalar/stat classification is the spec's contract. If a
// field shape drifts (e.g., a scalar becomes a stat band), the diff
// degrades to `{kind: 'missing', reason: ...}` for that field rather
// than crashing. See `diffField` below.

/** One field name the diff should extract + how it's typed. */
export interface BenchFieldSpec {
  readonly name: string;
  readonly kind: 'scalar' | 'stat';
}

export interface BenchDiffSpec {
  /** Location of the grouped-summary array in the report. */
  readonly summaryPath: string;
  /** Field in each row identifying the group (e.g., `'path'`). */
  readonly keyField: string;
  /** Fields the diff surfaces. Others are ignored. */
  readonly fields: readonly BenchFieldSpec[];
}

export const BENCH_DIFF_SPECS: Readonly<Record<BenchName, BenchDiffSpec>> = {
  slo: {
    summaryPath: 'summary',
    keyField: 'path',
    fields: [
      { name: 'runs', kind: 'scalar' },
      { name: 'timeToFirstPreview', kind: 'stat' },
      { name: 'timeToPreviewFinalize', kind: 'stat' },
      { name: 'timeToFinalCompiled', kind: 'stat' },
      { name: 'previewFrames', kind: 'stat' },
      { name: 'previewObservedCount', kind: 'scalar' },
      { name: 'previewExpectedButMissingCount', kind: 'scalar' },
    ],
  },
  a2ui: {
    summaryPath: 'summary',
    keyField: 'intentShape',
    fields: [
      { name: 'runs', kind: 'scalar' },
      { name: 'timeToFirstFrame', kind: 'stat' },
      { name: 'timeToPreviewFinalize', kind: 'stat' },
      { name: 'frameCount', kind: 'stat' },
      { name: 'parsePassRate', kind: 'stat' },
      { name: 'previewExpectedButMissingCount', kind: 'scalar' },
      { name: 'runsWithParseFailures', kind: 'scalar' },
      { name: 'totalParseFailures', kind: 'scalar' },
    ],
  },
  'multi-sdk': {
    // Shape differs — multi-sdk uses `generatorSummaries` (optional
    // on historical reports). The diff falls back to "missing" when
    // the field isn't present; that's not a regression, just a note.
    summaryPath: 'generatorSummaries',
    keyField: 'generator',
    fields: [
      { name: 'runs', kind: 'scalar' },
      { name: 'avgTimeMs', kind: 'scalar' },
      { name: 'avgScore', kind: 'scalar' },
      { name: 'successRate', kind: 'scalar' },
    ],
  },
};

// ─── Bundle read ──────────────────────────────────────────────────

/**
 * One bundle's worth of data — the manifest plus any per-bench
 * reports that were resolvable. Reports are keyed by benchName so
 * diffing can look them up without re-reading the filesystem.
 */
export interface LoadedBundle {
  readonly manifest: BenchBaselineManifest;
  /** Keyed by benchName. Missing entries = report unreadable. */
  readonly reports: ReadonlyMap<BenchName, unknown>;
  /** Per-bench notes populated during load (e.g., "report missing"). */
  readonly loadNotes: ReadonlyMap<BenchName, readonly string[]>;
}

/**
 * Read one bundle directory. The manifest MUST parse — a malformed
 * manifest is a fatal error the caller has to surface as an invalid
 * invocation. Individual per-bench reports are optional; if one
 * fails to parse, the bench's diff entry will carry a note and its
 * `summaryDiff` will be null.
 */
export function loadBundle(bundleDir: string): LoadedBundle {
  const manifestPath = join(bundleDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`manifest.json not found in ${bundleDir}`);
  }
  let manifest: BenchBaselineManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as BenchBaselineManifest;
  } catch (e) {
    throw new Error(
      `manifest.json in ${bundleDir} failed to parse: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    !Array.isArray((manifest as { results?: unknown }).results)
  ) {
    throw new Error(`manifest.json in ${bundleDir} has no results[] array`);
  }

  const reports = new Map<BenchName, unknown>();
  const loadNotes = new Map<BenchName, readonly string[]>();
  for (const entry of manifest.results) {
    // Only attempt report load when the manifest says the bench
    // succeeded — failed benches have `bundlePath: null` so there's
    // nothing to read.
    if (entry.status !== 'success' || !entry.bundlePath) continue;
    try {
      const raw = readFileSync(entry.bundlePath, 'utf8');
      reports.set(entry.benchName, JSON.parse(raw));
    } catch (e) {
      loadNotes.set(entry.benchName, [
        `report copy unreadable: ${e instanceof Error ? e.message : String(e)}`,
      ]);
    }
  }
  return { manifest, reports, loadNotes };
}

// ─── Top-level diff ───────────────────────────────────────────────

export interface DiffManifestsInput {
  readonly before: LoadedBundle;
  readonly after: LoadedBundle;
}

export function diffManifests(input: DiffManifestsInput): BenchBaselineDiff {
  const { before, after } = input;
  const notes: string[] = [];

  // Collect the union of benchNames across both sides so `added` /
  // `removed` benches surface explicitly.
  const allBenches = new Set<BenchName>();
  for (const r of before.manifest.results) allBenches.add(r.benchName);
  for (const r of after.manifest.results) allBenches.add(r.benchName);

  // Sort for stable output. Ordering is not load-bearing for
  // correctness; alphabetical is the most predictable.
  const sortedBenches = [...allBenches].sort();

  const benchDiffs: BenchDiffEntry[] = [];
  for (const benchName of sortedBenches) {
    const beforeEntry = before.manifest.results.find(
      (r) => r.benchName === benchName,
    );
    const afterEntry = after.manifest.results.find(
      (r) => r.benchName === benchName,
    );
    benchDiffs.push(
      diffOneBench({
        benchName,
        beforeEntry,
        afterEntry,
        beforeReport: before.reports.get(benchName),
        afterReport: after.reports.get(benchName),
        beforeLoadNotes: before.loadNotes.get(benchName) ?? [],
        afterLoadNotes: after.loadNotes.get(benchName) ?? [],
      }),
    );
  }

  return {
    schemaVersion: 'bench-baseline-diff.v0',
    beforeBaselineId: before.manifest.baselineId,
    afterBaselineId: after.manifest.baselineId,
    beforeTimestamp: before.manifest.timestamp,
    afterTimestamp: after.manifest.timestamp,
    beforeGitSha: before.manifest.gitSha,
    afterGitSha: after.manifest.gitSha,
    notes,
    benchDiffs,
  };
}

// ─── Per-bench diff ───────────────────────────────────────────────

interface DiffOneBenchInput {
  readonly benchName: BenchName;
  readonly beforeEntry: BenchManifestEntry | undefined;
  readonly afterEntry: BenchManifestEntry | undefined;
  readonly beforeReport: unknown;
  readonly afterReport: unknown;
  readonly beforeLoadNotes: readonly string[];
  readonly afterLoadNotes: readonly string[];
}

function diffOneBench(input: DiffOneBenchInput): BenchDiffEntry {
  const notes: string[] = [];
  for (const n of input.beforeLoadNotes) notes.push(`before: ${n}`);
  for (const n of input.afterLoadNotes) notes.push(`after: ${n}`);

  const beforeStatus = input.beforeEntry?.status ?? null;
  const afterStatus = input.afterEntry?.status ?? null;
  const statusChange = classifyStatusChange(beforeStatus, afterStatus);

  // Summary diff only attempted when BOTH sides succeeded AND both
  // reports were loadable. Every other shape produces null with a
  // note so the reader knows WHY.
  let summaryDiff: SummaryDiff | null = null;
  if (
    beforeStatus === 'success' &&
    afterStatus === 'success' &&
    input.beforeReport !== undefined &&
    input.afterReport !== undefined
  ) {
    const spec = BENCH_DIFF_SPECS[input.benchName];
    const result = diffGroupedSummary(
      input.beforeReport,
      input.afterReport,
      spec,
    );
    summaryDiff = result.diff;
    for (const n of result.notes) notes.push(n);
  } else if (
    statusChange === 'same-success' &&
    (input.beforeReport === undefined || input.afterReport === undefined)
  ) {
    notes.push(
      'both manifests reported success but at least one report was unreadable — summary diff skipped',
    );
  }

  // Surface schema-version drift when both reports are loadable.
  if (input.beforeReport !== undefined && input.afterReport !== undefined) {
    const beforeVer = readString(
      (input.beforeReport as Record<string, unknown>).schemaVersion,
    );
    const afterVer = readString(
      (input.afterReport as Record<string, unknown>).schemaVersion,
    );
    if (
      beforeVer !== undefined &&
      afterVer !== undefined &&
      beforeVer !== afterVer
    ) {
      notes.push(
        `schemaVersion drift: before=${beforeVer} after=${afterVer} — fields may not map 1:1`,
      );
    }
  }

  return {
    benchName: input.benchName,
    beforeStatus,
    afterStatus,
    statusChange,
    summaryDiff,
    notes,
  };
}

export function classifyStatusChange(
  before: BenchStatus | null,
  after: BenchStatus | null,
): StatusChange {
  if (before === null && after === null) {
    // Impossible in practice — the bench wouldn't appear in either
    // manifest. Classify as 'removed' for safety.
    return 'removed';
  }
  if (before === null) return 'added';
  if (after === null) return 'removed';
  if (before === 'success' && after === 'success') return 'same-success';
  if (before === 'failed' && after === 'failed') return 'same-failed';
  if (before === 'success' && after === 'failed') return 'regressed';
  return 'recovered'; // before 'failed', after 'success'
}

// ─── Grouped-summary diff ─────────────────────────────────────────

export interface GroupedSummaryDiffResult {
  readonly diff: SummaryDiff | null;
  readonly notes: readonly string[];
}

export function diffGroupedSummary(
  beforeReport: unknown,
  afterReport: unknown,
  spec: BenchDiffSpec,
): GroupedSummaryDiffResult {
  const notes: string[] = [];
  const beforeRows = readRowArray(beforeReport, spec.summaryPath);
  const afterRows = readRowArray(afterReport, spec.summaryPath);

  if (beforeRows === null && afterRows === null) {
    notes.push(
      `neither bundle has a '${spec.summaryPath}' array — summary diff unavailable`,
    );
    return { diff: null, notes };
  }
  if (beforeRows === null) {
    notes.push(`before is missing '${spec.summaryPath}' — showing after as 'added' rows`);
  }
  if (afterRows === null) {
    notes.push(`after is missing '${spec.summaryPath}' — showing before as 'removed' rows`);
  }

  const beforeMap = new Map<string, Record<string, unknown>>();
  for (const row of beforeRows ?? []) {
    const k = readString(row[spec.keyField]);
    if (k !== undefined) beforeMap.set(k, row);
  }
  const afterMap = new Map<string, Record<string, unknown>>();
  for (const row of afterRows ?? []) {
    const k = readString(row[spec.keyField]);
    if (k !== undefined) afterMap.set(k, row);
  }

  const allKeys = new Set<string>([...beforeMap.keys(), ...afterMap.keys()]);
  const rows: RowDiff[] = [];
  for (const key of [...allKeys].sort()) {
    const b = beforeMap.get(key);
    const a = afterMap.get(key);
    let presence: RowDiff['presence'];
    if (b && a) presence = 'both';
    else if (!b && a) presence = 'added';
    else presence = 'removed';

    const fields: Record<string, FieldDelta> = {};
    for (const f of spec.fields) {
      fields[f.name] = diffField(b?.[f.name], a?.[f.name], f.kind);
    }
    rows.push({ key, presence, fields });
  }

  return {
    diff: { kind: 'grouped', keyField: spec.keyField, rows },
    notes,
  };
}

// ─── Field-level diff ─────────────────────────────────────────────

export function diffField(
  before: unknown,
  after: unknown,
  kind: 'scalar' | 'stat',
): FieldDelta {
  if (kind === 'scalar') {
    const b = readNumberOrNull(before);
    const a = readNumberOrNull(after);
    const delta = b !== null && a !== null ? a - b : null;
    // If BOTH sides were undefined (not the same as `null` value),
    // surface as 'missing' so the reader knows there was no data at
    // all — a scalar that's null on both sides is different from a
    // field the report didn't carry.
    if (before === undefined && after === undefined) {
      return { kind: 'missing', reason: 'field absent on both sides' };
    }
    return { kind: 'scalar', before: b, after: a, delta };
  }
  // kind === 'stat'
  const b = readStatBand(before);
  const a = readStatBand(after);
  if (b === null && a === null && before === undefined && after === undefined) {
    return { kind: 'missing', reason: 'stat band absent on both sides' };
  }
  return {
    kind: 'stat',
    before: b,
    after: a,
    deltaMedian: b?.median !== null && b?.median !== undefined && a?.median !== null && a?.median !== undefined
      ? a.median - b.median
      : null,
    deltaMin:
      b?.min !== null && b?.min !== undefined && a?.min !== null && a?.min !== undefined
        ? a.min - b.min
        : null,
    deltaMax:
      b?.max !== null && b?.max !== undefined && a?.max !== null && a?.max !== undefined
        ? a.max - b.max
        : null,
  };
}

// ─── Readers ──────────────────────────────────────────────────────

function readRowArray(
  report: unknown,
  path: string,
): readonly Record<string, unknown>[] | null {
  if (typeof report !== 'object' || report === null) return null;
  const val = (report as Record<string, unknown>)[path];
  if (!Array.isArray(val)) return null;
  return val.filter(
    (v): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null && !Array.isArray(v),
  );
}

function readString(v: unknown): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readNumberOrNull(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  return null;
}

function readStatBand(v: unknown): StatBand | null {
  if (typeof v !== 'object' || v === null) return null;
  const r = v as Record<string, unknown>;
  const count = readNumberOrNull(r.count);
  const nullCount = readNumberOrNull(r.nullCount);
  if (count === null || nullCount === null) return null;
  return {
    count,
    nullCount,
    min: readNumberOrNull(r.min),
    median: readNumberOrNull(r.median),
    max: readNumberOrNull(r.max),
  };
}
