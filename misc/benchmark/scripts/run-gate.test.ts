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

  // #766: the image commit changes on every rebuild (pnpm-lock churn), but
  // "an update exists" means the triad/runner SOURCE changed.
  it('skips a lock-only rebuild: image version differs but the source hash is unchanged', () => {
    const d = decideBenchRun(
      args({ imageVersion: 'def5678', imageSourceHash: 'src-aaa', latestSourceHash: 'src-aaa' }),
    );
    expect(d.run).toBe(false);
    expect(d.reason).toContain('src-aaa');
  });

  it('runs when the source hash differs, whatever the version says', () => {
    const d = decideBenchRun(
      args({ imageVersion: 'abc1234', imageSourceHash: 'src-bbb', latestSourceHash: 'src-aaa' }),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toContain('src-bbb');
  });

  it('falls back to the version compare when either side lacks a source hash', () => {
    // Image carries a hash, the last published row predates the field → version rules.
    expect(decideBenchRun(args({ imageVersion: 'def5678', imageSourceHash: 'src-aaa' })).run).toBe(true);
    expect(decideBenchRun(args({ imageSourceHash: 'src-aaa' })).run).toBe(false);
    // The other direction: an older image at :latest, a row that carries a hash.
    expect(decideBenchRun(args({ imageVersion: 'def5678', latestSourceHash: 'src-aaa' })).run).toBe(true);
    expect(decideBenchRun(args({ latestSourceHash: 'src-aaa' })).run).toBe(false);
  });

  it('treats an empty or sentinel ("dev"/"local") source hash as ABSENT — never as a real hash', () => {
    // A failed bake must not mint a spurious run ('' ≠ 'src-aaa') nor a
    // forever-skip ('dev' === 'dev'); both fall back to the version compare.
    const empty = decideBenchRun(args({ imageVersion: 'def5678', imageSourceHash: '', latestSourceHash: 'src-aaa' }));
    expect(empty.run).toBe(true);
    expect(empty.reason).toContain('image def5678 ≠');
    const dev = decideBenchRun(args({ imageVersion: 'def5678', imageSourceHash: 'dev', latestSourceHash: 'dev' }));
    expect(dev.run).toBe(true);
    expect(dev.reason).toContain('image def5678 ≠');
  });

  it('the skip reason mentions an unrelated rebuild only when the image commit actually differs', () => {
    const same = decideBenchRun(args({ imageSourceHash: 'src-aaa', latestSourceHash: 'src-aaa' }));
    expect(same.run).toBe(false);
    expect(same.reason).not.toContain('rebuilt');
    const rebuilt = decideBenchRun(
      args({ imageVersion: 'def5678', imageSourceHash: 'src-aaa', latestSourceHash: 'src-aaa' }),
    );
    expect(rebuilt.run).toBe(false);
    expect(rebuilt.reason).toContain('rebuilt');
  });

  it('long-stop still fires on an unchanged source hash', () => {
    const d = decideBenchRun(
      args({
        imageVersion: 'def5678',
        imageSourceHash: 'src-aaa',
        latestSourceHash: 'src-aaa',
        latestDate: '2026-07-24',
        today: '2026-08-21',
      }),
    );
    expect(d.run).toBe(true);
    expect(d.reason).toContain('long-stop');
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
