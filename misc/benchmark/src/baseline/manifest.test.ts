/**
 * Baseline manifest tests — cover the pure functions only.
 * Orchestration IO is tested by running the actual script.
 */

import { describe, expect, it } from 'vitest';
import {
  buildBaselineManifest,
  extractA2uiSummary,
  extractMultiSdkSummary,
  extractSloSummary,
  type BenchManifestEntry,
} from './manifest.js';

function mkEntry(overrides: Partial<BenchManifestEntry> = {}): BenchManifestEntry {
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

describe('buildBaselineManifest', () => {
  it('schemaVersion pinned; notes embedded', () => {
    const m = buildBaselineManifest({
      baselineId: 'baseline-2026-04-20T00-00-00Z',
      timestamp: '2026-04-20T00:00:00Z',
      gitSha: 'abc123',
      bundleDir: '/tmp/baseline',
      results: [],
    });
    expect(m.schemaVersion).toBe('bench-baseline.v0');
    expect(m.notes.length).toBeGreaterThan(0);
    // Honesty note about individual benches remaining authoritative.
    expect(m.notes.join(' ').toLowerCase()).toContain('snapshot');
  });

  it('preserves results order — partial-failure mix', () => {
    const m = buildBaselineManifest({
      baselineId: 'b',
      timestamp: 't',
      gitSha: null,
      bundleDir: '/x',
      results: [
        mkEntry({ benchName: 'slo', status: 'success' }),
        mkEntry({
          benchName: 'multi-sdk',
          status: 'failed',
          exitCode: 1,
          outputPath: null,
          bundlePath: null,
          summary: null,
          errorExcerpt: 'ANTHROPIC_API_KEY not set',
        }),
        mkEntry({ benchName: 'a2ui', status: 'success' }),
      ],
    });
    expect(m.results.map((r) => r.benchName)).toEqual([
      'slo',
      'multi-sdk',
      'a2ui',
    ]);
    expect(m.results[1]!.status).toBe('failed');
    expect(m.results[1]!.errorExcerpt).toContain('ANTHROPIC');
  });

  it('null git sha is honest', () => {
    const m = buildBaselineManifest({
      baselineId: 'b',
      timestamp: 't',
      gitSha: null,
      bundleDir: '/x',
      results: [],
    });
    expect(m.gitSha).toBeNull();
  });
});

// ─── Summary extractors ────────────────────────────────────────────

describe('extractSloSummary', () => {
  it('pulls totalRuns from results + shapes headline per path', () => {
    const s = extractSloSummary({
      schemaVersion: 'slo.v0',
      results: [{}, {}, {}],
      summary: [
        { path: 'blueprint_hit', runs: 3, previewObservedCount: 3, previewExpectedButMissingCount: 0 },
        { path: 'oss_miss', runs: 3, previewObservedCount: 0, previewExpectedButMissingCount: 0 },
      ],
    });
    expect(s.totalRuns).toBe(3);
    expect(s.headline).toContain('blueprint_hit');
    expect(s.headline).toContain('oss_miss');
  });

  it('degrades gracefully on unparseable report', () => {
    expect(extractSloSummary(null)).toEqual({});
    expect(extractSloSummary('broken')).toEqual({});
    expect(extractSloSummary({ unrelated: true })).toEqual({
      totalRuns: undefined,
      headline: undefined,
    });
  });
});

describe('extractA2uiSummary', () => {
  it('includes parseFails count per shape', () => {
    const s = extractA2uiSummary({
      results: [{}, {}],
      summary: [
        { intentShape: 'form', runs: 3, totalParseFailures: 0 },
        { intentShape: 'list', runs: 3, totalParseFailures: 1 },
      ],
    });
    expect(s.headline).toContain('form: 3r, parseFails=0');
    expect(s.headline).toContain('list: 3r, parseFails=1');
  });
});

describe('extractMultiSdkSummary', () => {
  it('uses floorSummaries when present', () => {
    const s = extractMultiSdkSummary({
      meta: { totalRuns: 6 },
      floorSummaries: [
        { floor: 'oss', runs: 3, avgTimeMs: 30000, avgScore: 76.0, predefinedToolCallRate: 0 },
        { floor: 'hosted', runs: 3, avgTimeMs: 42500, avgScore: 78.0, predefinedToolCallRate: 0.89 },
      ],
    });
    expect(s.totalRuns).toBe(6);
    expect(s.headline).toContain('oss: 3r t=30.0s s=76.0 tool=0%');
    expect(s.headline).toContain('hosted: 3r t=42.5s s=78.0 tool=89%');
  });

  it('handles reports without floorSummaries (pre-floor-split reports)', () => {
    const s = extractMultiSdkSummary({
      meta: { totalRuns: 3 },
    });
    expect(s.totalRuns).toBe(3);
    expect(s.headline).toBeUndefined();
  });

  it('negative avgScore → "n/a" (convention from multi-sdk reporter)', () => {
    const s = extractMultiSdkSummary({
      meta: { totalRuns: 1 },
      floorSummaries: [
        { floor: 'oss', runs: 1, avgTimeMs: 0, avgScore: -1, predefinedToolCallRate: 0 },
      ],
    });
    expect(s.headline).toContain('s=n/a');
  });
});
