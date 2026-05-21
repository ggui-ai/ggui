/**
 * Default reporter implementation for `runConformance()`.
 *
 * Prints a scorecard-style report to stdout as fixtures complete,
 * then a summary block at the end grouped by contract slug. The
 * output groups results by the protocol/contract criterion each
 * fixture exercises so adopters can see at a glance which obligations
 * their implementation satisfies.
 *
 * The default reporter is `process.stdout`-bound. Third-party
 * consumers wanting programmatic access should implement
 * {@link ConformanceReporter} directly against their own sink (JSON,
 * vitest, CI annotations, etc.) and pass it via `runConformance()`'s
 * `reporter` config.
 */
import { fixturesByContract } from './fixtures/index.js';
import type {
  ConformanceFailure,
  ConformanceReporter,
  ConformanceResult,
  SkippedFixture,
} from './run-conformance.js';

// =============================================================================
// Public: the default stdout reporter
// =============================================================================

export interface DefaultReporterOptions {
  /**
   * Destination for all output. Defaults to
   * `process.stdout.write`-bound. Tests swap this for capture.
   */
  readonly write?: (line: string) => void;
  /**
   * If `true`, emit one line per fixture as it completes (streaming).
   * If `false`, only emit the final summary block. Default `true`.
   */
  readonly streaming?: boolean;
}

/**
 * Build a {@link ConformanceReporter} that writes the bar-scorecard
 * report. The return value plugs directly into
 * `runConformance({reporter: createDefaultReporter()})`.
 */
export function createDefaultReporter(
  options: DefaultReporterOptions = {},
): ConformanceReporter {
  const write =
    options.write ??
    ((line: string) => {
      process.stdout.write(line);
      if (!line.endsWith('\n')) process.stdout.write('\n');
    });
  const streaming = options.streaming ?? true;

  return {
    onStart(total: number): void {
      if (!streaming) return;
      write(
        `ggui protocol conformance — driving ${total} fixture(s) against the implementation under test`,
      );
      write(RULE);
    },
    onFixturePass(name: string, elapsedMs: number): void {
      if (!streaming) return;
      write(`  ${MARK_PASS}  ${padRight(name, 48)}  ${elapsedMs}ms`);
    },
    onFixtureFail(failure: ConformanceFailure): void {
      if (!streaming) return;
      write(`  ${MARK_FAIL}  ${padRight(failure.name, 48)}  ${failure.criterion}`);
      write(`        → ${failure.message}`);
    },
    onFixtureSkip(name: string, reason: string): void {
      if (!streaming) return;
      const shortReason = reason.length > 80 ? `${reason.slice(0, 77)}…` : reason;
      write(`  ${MARK_SKIP}  ${padRight(name, 48)}  ${shortReason}`);
    },
    onTeardownWarning(name: string, message: string): void {
      if (!streaming) return;
      write(`  ${MARK_WARN}  ${padRight(name, 48)}  teardown: ${message}`);
    },
    onComplete(result: ConformanceResult): void {
      write(RULE);
      write(formatScorecard(result));
      write(RULE);
      write(formatSummary(result));
    },
  };
}

// =============================================================================
// Scorecard formatting
// =============================================================================

export function formatScorecard(result: ConformanceResult): string {
  // Group fixtures by contract so operators see pass rates per
  // criterion, mirroring `fixturesByContract`'s classification.
  const lines: string[] = [];
  for (const [slug, fixtures] of Object.entries(fixturesByContract)) {
    const names = new Set(fixtures.map((f) => f.name));
    const passedCount = result.passed.filter((n) => names.has(n)).length;
    const failedCount = result.failed.filter((f) => names.has(f.name)).length;
    const skippedCount = result.skipped.filter((s) => names.has(s.name)).length;
    const total = passedCount + failedCount + skippedCount;
    if (total === 0) continue;
    const tone = failedCount > 0 ? MARK_FAIL : passedCount > 0 ? MARK_PASS : MARK_SKIP;
    lines.push(
      `  ${tone}  ${padRight(slug, 38)}  ${passedCount}/${total} pass${
        failedCount > 0 ? ` · ${failedCount} fail` : ''
      }${skippedCount > 0 ? ` · ${skippedCount} skip` : ''}`,
    );
  }
  return lines.join('\n');
}

export function formatSummary(result: ConformanceResult): string {
  const passed = result.passed.length;
  const failed = result.failed.length;
  const skipped = result.skipped.length;
  const total = passed + failed + skipped;
  return [
    `  Passed:   ${String(passed).padStart(3)}`,
    `  Failed:   ${String(failed).padStart(3)}`,
    `  Skipped:  ${String(skipped).padStart(3)}`,
    `  Total:    ${String(total).padStart(3)}   (${result.totalMs}ms)`,
  ].join('\n');
}

/**
 * Emit the full set of failure messages — for CLI `--verbose` mode +
 * programmatic consumers that want a post-run diagnostic dump.
 */
export function formatFailures(failures: readonly ConformanceFailure[]): string {
  if (failures.length === 0) return '';
  const lines = ['', 'Failures:', ''];
  for (const failure of failures) {
    lines.push(`${MARK_FAIL} ${failure.name}  (${failure.criterion})`);
    lines.push(`   ${failure.message}`);
    lines.push(`   expected: ${safeStringify(failure.expected)}`);
    lines.push(`   received: ${safeStringify(failure.received)}`);
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Emit the full set of skip reasons — useful for `--verbose` mode to
 * see which directives an implementation hasn't wired yet.
 */
export function formatSkips(skipped: readonly SkippedFixture[]): string {
  if (skipped.length === 0) return '';
  const lines = ['', 'Skipped:', ''];
  for (const skip of skipped) {
    lines.push(`${MARK_SKIP} ${skip.name}`);
    lines.push(`   ${skip.reason}`);
    lines.push('');
  }
  return lines.join('\n');
}

// =============================================================================
// Shared glyphs + helpers
// =============================================================================

const RULE = '─'.repeat(70);
const MARK_PASS = 'PASS';
const MARK_FAIL = 'FAIL';
const MARK_SKIP = 'SKIP';
const MARK_WARN = 'WARN';

function padRight(s: string, width: number): string {
  if (s.length >= width) return s;
  return s + ' '.repeat(width - s.length);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
