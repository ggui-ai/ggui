import { describe, it, expect } from 'vitest';
import { decideBenchRun } from './run-gate.mjs';

/** Baseline args: image matches the latest published run, published today. */
function args(overrides: Partial<Parameters<typeof decideBenchRun>[0]> = {}) {
  return {
    imageVersion: 'abc1234',
    latestVersion: 'abc1234',
    latestDate: '2026-08-21',
    today: '2026-08-21',
    force: false,
    ...overrides,
  };
}

describe('decideBenchRun (change-triggered cadence)', () => {
  it('skips when the image version matches the latest published run', () => {
    const d = decideBenchRun(args());
    expect(d.run).toBe(false);
    expect(d.reason).toContain('abc1234');
  });

  it('runs when a bench-relevant update exists (version differs)', () => {
    const d = decideBenchRun(args({ imageVersion: 'def5678' }));
    expect(d.run).toBe(true);
  });

  it('always runs on force (manual dispatch)', () => {
    expect(decideBenchRun(args({ force: true })).run).toBe(true);
  });

  it('runs when no run was ever published', () => {
    const d = decideBenchRun(args({ latestVersion: undefined, latestDate: undefined }));
    expect(d.run).toBe(true);
  });

  it('runs when the latest run predates version stamping (no version in index)', () => {
    const d = decideBenchRun(args({ latestVersion: undefined }));
    expect(d.run).toBe(true);
  });

  it('long-stop: runs anyway once the latest run is maxAgeDays old', () => {
    const d = decideBenchRun(args({ latestDate: '2026-07-24', today: '2026-08-21' }));
    expect(d.run).toBe(true);
    expect(d.reason).toContain('long-stop');
  });

  it('does not long-stop the day before the cutoff', () => {
    // 27 days old with an unchanged image → still a skip.
    const d = decideBenchRun(args({ latestDate: '2026-07-25', today: '2026-08-21' }));
    expect(d.run).toBe(false);
  });

  it('skips while a main-hold is set — even when an update exists (#684)', () => {
    const d = decideBenchRun(
      args({
        imageVersion: 'def5678',
        hold: { issues: [{ number: 690, title: 'hold: triad escape 702549c89' }] },
      }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('HOLD');
    expect(d.reason).toContain('#690');
  });

  it('force overrides a main-hold with an explicit reason naming the hold', () => {
    const d = decideBenchRun(
      args({ force: true, hold: { issues: [{ number: 690, title: 'hold: triad escape' }] } }),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toContain('#690');
  });

  it('a hold marker with no issues listed is not a hold', () => {
    const d = decideBenchRun(args({ imageVersion: 'def5678', hold: { issues: [] } }));
    expect(d.run).toBe(true);
  });

  it('runs uncontainerized (no image version) — the gate never blocks dev', () => {
    expect(decideBenchRun(args({ imageVersion: undefined })).run).toBe(true);
    expect(decideBenchRun(args({ imageVersion: 'local' })).run).toBe(true);
  });
});
