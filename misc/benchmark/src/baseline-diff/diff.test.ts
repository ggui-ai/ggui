/**
 * Baseline-diff tests. Focus on:
 *   - status transitions (regressed / recovered / added / removed)
 *   - null-safe field diffs
 *   - schema drift tolerance
 *   - bench-added-but-absent-summary graceful degradation
 *
 * All tests drive the pure functions with in-memory bundles — no
 * filesystem.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyStatusChange,
  diffField,
  diffGroupedSummary,
  diffManifests,
  BENCH_DIFF_SPECS,
  type LoadedBundle,
} from './diff.js';
import type {
  BenchBaselineManifest,
  BenchManifestEntry,
} from '../baseline/manifest.js';

function mkEntry(
  overrides: Partial<BenchManifestEntry> = {},
): BenchManifestEntry {
  return {
    benchName: 'slo',
    status: 'success',
    command: 'pnpm bench:slo',
    outputPath: '/abs/slo.json',
    bundlePath: '/bundle/slo.json',
    exitCode: 0,
    summary: { totalRuns: 9 },
    errorExcerpt: null,
    ...overrides,
  };
}

function mkManifest(overrides: Partial<BenchBaselineManifest> = {}): BenchBaselineManifest {
  return {
    schemaVersion: 'bench-baseline.v0',
    baselineId: 'baseline-before',
    timestamp: '2026-04-20T00:00:00Z',
    gitSha: 'before-sha',
    bundleDir: '/before',
    notes: [],
    results: [],
    ...overrides,
  };
}

function mkBundle(
  manifest: BenchBaselineManifest,
  reports: Record<string, unknown> = {},
  loadNotes: Record<string, readonly string[]> = {},
): LoadedBundle {
  const reportsMap = new Map();
  for (const [k, v] of Object.entries(reports)) reportsMap.set(k, v);
  const notesMap = new Map();
  for (const [k, v] of Object.entries(loadNotes)) notesMap.set(k, v);
  return { manifest, reports: reportsMap, loadNotes: notesMap };
}

// ─── classifyStatusChange ──────────────────────────────────────────

describe('classifyStatusChange', () => {
  it('same-success when both sides pass', () => {
    expect(classifyStatusChange('success', 'success')).toBe('same-success');
  });

  it('same-failed when both sides fail', () => {
    expect(classifyStatusChange('failed', 'failed')).toBe('same-failed');
  });

  it('regressed: success → failed', () => {
    expect(classifyStatusChange('success', 'failed')).toBe('regressed');
  });

  it('recovered: failed → success', () => {
    expect(classifyStatusChange('failed', 'success')).toBe('recovered');
  });

  it('added: not in before', () => {
    expect(classifyStatusChange(null, 'success')).toBe('added');
    expect(classifyStatusChange(null, 'failed')).toBe('added');
  });

  it('removed: not in after', () => {
    expect(classifyStatusChange('success', null)).toBe('removed');
    expect(classifyStatusChange('failed', null)).toBe('removed');
  });
});

// ─── diffField — scalar ────────────────────────────────────────────

describe('diffField scalar', () => {
  it('basic numeric delta', () => {
    const d = diffField(100, 120, 'scalar');
    expect(d).toEqual({ kind: 'scalar', before: 100, after: 120, delta: 20 });
  });

  it('null on before → delta null; before/after preserved honestly', () => {
    const d = diffField(null, 120, 'scalar');
    expect(d).toEqual({ kind: 'scalar', before: null, after: 120, delta: null });
  });

  it('null on after → delta null', () => {
    const d = diffField(100, null, 'scalar');
    expect(d).toEqual({ kind: 'scalar', before: 100, after: null, delta: null });
  });

  it('both undefined → "missing" kind', () => {
    const d = diffField(undefined, undefined, 'scalar');
    expect(d.kind).toBe('missing');
  });

  it('non-numeric input → treated as null, surfaces as scalar with null', () => {
    const d = diffField('hello' as unknown, 100, 'scalar');
    expect(d.kind).toBe('scalar');
    if (d.kind === 'scalar') {
      expect(d.before).toBeNull();
      expect(d.after).toBe(100);
      expect(d.delta).toBeNull();
    }
  });
});

// ─── diffField — stat band ─────────────────────────────────────────

describe('diffField stat', () => {
  const beforeBand = { count: 3, nullCount: 0, min: 10, median: 15, max: 20 };
  const afterBand = { count: 3, nullCount: 0, min: 12, median: 18, max: 25 };

  it('computes delta for min/median/max', () => {
    const d = diffField(beforeBand, afterBand, 'stat');
    expect(d.kind).toBe('stat');
    if (d.kind === 'stat') {
      expect(d.deltaMedian).toBe(3);
      expect(d.deltaMin).toBe(2);
      expect(d.deltaMax).toBe(5);
    }
  });

  it('null stat fields propagate null deltas', () => {
    const beforeEmpty = { count: 0, nullCount: 3, min: null, median: null, max: null };
    const d = diffField(beforeEmpty, afterBand, 'stat');
    expect(d.kind).toBe('stat');
    if (d.kind === 'stat') {
      expect(d.deltaMedian).toBeNull();
      expect(d.deltaMin).toBeNull();
      expect(d.deltaMax).toBeNull();
    }
  });

  it('both sides absent → "missing"', () => {
    const d = diffField(undefined, undefined, 'stat');
    expect(d.kind).toBe('missing');
  });

  it('malformed band (string instead of number) → null band', () => {
    const d = diffField({ count: 'bad', nullCount: 0 }, afterBand, 'stat');
    expect(d.kind).toBe('stat');
    if (d.kind === 'stat') {
      expect(d.before).toBeNull();
      expect(d.after).not.toBeNull();
    }
  });
});

// ─── diffGroupedSummary ────────────────────────────────────────────

describe('diffGroupedSummary', () => {
  const sloSpec = BENCH_DIFF_SPECS.slo;

  it('happy path: same keys, deltas populate', () => {
    const beforeReport = {
      summary: [
        { path: 'blueprint_hit', runs: 3, previewObservedCount: 3, previewExpectedButMissingCount: 0 },
      ],
    };
    const afterReport = {
      summary: [
        { path: 'blueprint_hit', runs: 3, previewObservedCount: 3, previewExpectedButMissingCount: 1 },
      ],
    };
    const { diff } = diffGroupedSummary(beforeReport, afterReport, sloSpec);
    expect(diff).not.toBeNull();
    if (diff) {
      expect(diff.kind).toBe('grouped');
      expect(diff.keyField).toBe('path');
      expect(diff.rows).toHaveLength(1);
      const r = diff.rows[0]!;
      expect(r.key).toBe('blueprint_hit');
      expect(r.presence).toBe('both');
      const field = r.fields.previewExpectedButMissingCount!;
      expect(field.kind).toBe('scalar');
      if (field.kind === 'scalar') expect(field.delta).toBe(1);
    }
  });

  it('key added on after side → presence "added"', () => {
    const before = { summary: [{ path: 'blueprint_hit', runs: 3 }] };
    const after = {
      summary: [
        { path: 'blueprint_hit', runs: 3 },
        { path: 'generation_miss', runs: 3 },
      ],
    };
    const { diff } = diffGroupedSummary(before, after, sloSpec);
    expect(diff).toBeDefined();
    const added = diff!.rows.find((r) => r.key === 'generation_miss');
    expect(added?.presence).toBe('added');
  });

  it('key removed on after side → presence "removed"', () => {
    const before = {
      summary: [
        { path: 'blueprint_hit', runs: 3 },
        { path: 'generation_miss', runs: 3 },
      ],
    };
    const after = { summary: [{ path: 'blueprint_hit', runs: 3 }] };
    const { diff } = diffGroupedSummary(before, after, sloSpec);
    expect(diff).toBeDefined();
    const removed = diff!.rows.find((r) => r.key === 'generation_miss');
    expect(removed?.presence).toBe('removed');
  });

  it('stable sort — rows ordered alphabetically by key', () => {
    const before = {
      summary: [
        { path: 'oss_miss' },
        { path: 'blueprint_hit' },
        { path: 'generation_miss' },
      ],
    };
    const after = { summary: [{ path: 'blueprint_hit' }] };
    const { diff } = diffGroupedSummary(before, after, sloSpec);
    expect(diff?.rows.map((r) => r.key)).toEqual([
      'blueprint_hit',
      'generation_miss',
      'oss_miss',
    ]);
  });

  it('missing summary array on before → diff still emits, with note', () => {
    const { diff, notes } = diffGroupedSummary(
      { schemaVersion: 'slo.v0' }, // no summary array
      { summary: [{ path: 'blueprint_hit', runs: 3 }] },
      sloSpec,
    );
    expect(diff).not.toBeNull();
    expect(notes.join(' ')).toContain('before is missing');
    // The after row surfaces as "added" because before was empty.
    expect(diff?.rows[0]!.presence).toBe('added');
  });

  it('missing summary on BOTH sides → null diff with note', () => {
    const { diff, notes } = diffGroupedSummary({}, {}, sloSpec);
    expect(diff).toBeNull();
    expect(notes.join(' ')).toContain('neither bundle');
  });

  it('graceful on fully malformed report', () => {
    const { diff, notes } = diffGroupedSummary('not-an-object', 42, sloSpec);
    expect(diff).toBeNull();
    expect(notes.length).toBeGreaterThan(0);
  });

  it('stat fields in slo spec — timeToFirstPreview diffs correctly', () => {
    const before = {
      summary: [
        {
          path: 'blueprint_hit',
          timeToFirstPreview: { count: 3, nullCount: 0, min: 20, median: 25, max: 30 },
        },
      ],
    };
    const after = {
      summary: [
        {
          path: 'blueprint_hit',
          timeToFirstPreview: { count: 3, nullCount: 0, min: 22, median: 28, max: 35 },
        },
      ],
    };
    const { diff } = diffGroupedSummary(before, after, sloSpec);
    const f = diff!.rows[0]!.fields.timeToFirstPreview!;
    expect(f.kind).toBe('stat');
    if (f.kind === 'stat') expect(f.deltaMedian).toBe(3);
  });
});

// ─── diffManifests ─────────────────────────────────────────────────

describe('diffManifests', () => {
  it('all four transition types in one diff', () => {
    const before = mkBundle(
      mkManifest({
        baselineId: 'b',
        results: [
          mkEntry({ benchName: 'slo', status: 'success' }),
          mkEntry({ benchName: 'multi-sdk', status: 'failed' }),
          mkEntry({ benchName: 'a2ui', status: 'success' }),
          // 'blueprint-negotiation' not in before → will be 'added'
        ],
      }),
    );
    const after = mkBundle(
      mkManifest({
        baselineId: 'a',
        results: [
          mkEntry({ benchName: 'slo', status: 'failed' }), // regressed
          mkEntry({ benchName: 'multi-sdk', status: 'success' }), // recovered
          // 'a2ui' not in after → removed
          mkEntry({ benchName: 'blueprint-negotiation', status: 'success' }), // added
        ],
      }),
    );
    const d = diffManifests({ before, after });

    const byName = new Map(d.benchDiffs.map((e) => [e.benchName, e]));
    expect(byName.get('slo')!.statusChange).toBe('regressed');
    expect(byName.get('multi-sdk')!.statusChange).toBe('recovered');
    expect(byName.get('a2ui')!.statusChange).toBe('removed');
    expect(byName.get('blueprint-negotiation')!.statusChange).toBe('added');
  });

  it('same-success without loadable reports → note present', () => {
    const before = mkBundle(
      mkManifest({
        results: [mkEntry({ benchName: 'slo', status: 'success' })],
      }),
      // Intentionally no reports map entry — simulates unreadable report
    );
    const after = mkBundle(
      mkManifest({
        baselineId: 'a',
        results: [mkEntry({ benchName: 'slo', status: 'success' })],
      }),
    );
    const d = diffManifests({ before, after });
    expect(d.benchDiffs[0]!.statusChange).toBe('same-success');
    expect(d.benchDiffs[0]!.summaryDiff).toBeNull();
    expect(d.benchDiffs[0]!.notes.join(' ')).toContain('unreadable');
  });

  it('schema-version drift between reports produces a note', () => {
    const before = mkBundle(
      mkManifest({
        results: [mkEntry({ benchName: 'slo', status: 'success' })],
      }),
      {
        slo: {
          schemaVersion: 'slo.v0',
          summary: [{ path: 'blueprint_hit', runs: 3 }],
        },
      },
    );
    const after = mkBundle(
      mkManifest({
        baselineId: 'a',
        results: [mkEntry({ benchName: 'slo', status: 'success' })],
      }),
      {
        slo: {
          schemaVersion: 'slo.v1', // drifted
          summary: [{ path: 'blueprint_hit', runs: 3 }],
        },
      },
    );
    const d = diffManifests({ before, after });
    expect(d.benchDiffs[0]!.notes.join(' ')).toContain('schemaVersion drift');
    // Still emits a diff — drift is a warning, not a hard stop.
    expect(d.benchDiffs[0]!.summaryDiff).not.toBeNull();
  });

  it('captures metadata: baselineIds, timestamps, git shas', () => {
    const before = mkBundle(
      mkManifest({
        baselineId: 'b-id',
        timestamp: 'b-ts',
        gitSha: 'b-sha',
      }),
    );
    const after = mkBundle(
      mkManifest({
        baselineId: 'a-id',
        timestamp: 'a-ts',
        gitSha: 'a-sha',
      }),
    );
    const d = diffManifests({ before, after });
    expect(d.beforeBaselineId).toBe('b-id');
    expect(d.afterBaselineId).toBe('a-id');
    expect(d.beforeTimestamp).toBe('b-ts');
    expect(d.afterTimestamp).toBe('a-ts');
    expect(d.beforeGitSha).toBe('b-sha');
    expect(d.afterGitSha).toBe('a-sha');
    expect(d.schemaVersion).toBe('bench-baseline-diff.v0');
  });

  it('bench lists are union + sorted alphabetically', () => {
    const before = mkBundle(
      mkManifest({
        results: [
          mkEntry({ benchName: 'slo', status: 'success' }),
          mkEntry({ benchName: 'a2ui', status: 'success' }),
        ],
      }),
    );
    const after = mkBundle(
      mkManifest({
        baselineId: 'a',
        results: [
          mkEntry({ benchName: 'multi-sdk', status: 'success' }),
          mkEntry({ benchName: 'slo', status: 'success' }),
        ],
      }),
    );
    const d = diffManifests({ before, after });
    expect(d.benchDiffs.map((e) => e.benchName)).toEqual([
      'a2ui',
      'multi-sdk',
      'slo',
    ]);
  });
});

// ─── Per-bench spec sanity ─────────────────────────────────────────

describe('BENCH_DIFF_SPECS', () => {
  it('covers all 4 benches', () => {
    expect(Object.keys(BENCH_DIFF_SPECS).sort()).toEqual([
      'a2ui',
      'blueprint-negotiation',
      'multi-sdk',
      'slo',
    ]);
  });

  it('multi-sdk points at floorSummaries (not summary)', () => {
    expect(BENCH_DIFF_SPECS['multi-sdk'].summaryPath).toBe('floorSummaries');
    expect(BENCH_DIFF_SPECS['multi-sdk'].keyField).toBe('floor');
  });

  it('other three point at summary array', () => {
    expect(BENCH_DIFF_SPECS.slo.summaryPath).toBe('summary');
    expect(BENCH_DIFF_SPECS.a2ui.summaryPath).toBe('summary');
    expect(BENCH_DIFF_SPECS['blueprint-negotiation'].summaryPath).toBe('summary');
  });
});
