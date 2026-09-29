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
import { PURE_FUNCTION_CATALOG_SLUGS } from './run-conformance.js';
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
    onFixtureWarn(warning: ConformanceFailure): void {
      if (!streaming) return;
      write(`  ${MARK_WARN}  ${padRight(warning.name, 48)}  ${warning.criterion}`);
      write(`        → ${warning.message}`);
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
  // criterion, mirroring `fixturesByContract`'s classification, then
  // the pure-function catalogs, whose rows carry a `<slug>/` prefix
  // instead of living in that map (they are not WS-observable).
  const lines: string[] = [];
  for (const [slug, fixtures] of Object.entries(fixturesByContract)) {
    const names = new Set(fixtures.map((f) => f.name));
    lines.push(...scorecardRow(slug, result, (name) => names.has(name)));
  }
  for (const slug of PURE_FUNCTION_CATALOG_SLUGS) {
    const prefix = `${slug}/`;
    lines.push(...scorecardRow(slug, result, (name) => name.startsWith(prefix)));
  }
  return lines.join('\n');
}

/**
 * One scorecard line for the rows `belongs` selects, or no line at all
 * when the group graded nothing. A group that is entirely SKIPPED still
 * prints — an obligation nobody graded must be visible, not absent.
 */
function scorecardRow(
  slug: string,
  result: ConformanceResult,
  belongs: (name: string) => boolean,
): string[] {
  const passedCount = result.passed.filter(belongs).length;
  const failedCount = result.failed.filter((f) => belongs(f.name)).length;
  const warnedCount = result.warned.filter((w) => belongs(w.name)).length;
  const skippedCount = result.skipped.filter((s) => belongs(s.name)).length;
  const total = passedCount + failedCount + warnedCount + skippedCount;
  if (total === 0) return [];
  const tone =
    failedCount > 0 ? MARK_FAIL : warnedCount > 0 ? MARK_WARN : passedCount > 0 ? MARK_PASS : MARK_SKIP;
  return [
    `  ${tone}  ${padRight(slug, 38)}  ${passedCount}/${total} pass${
      failedCount > 0 ? ` · ${failedCount} fail` : ''
    }${warnedCount > 0 ? ` · ${warnedCount} warn` : ''}${skippedCount > 0 ? ` · ${skippedCount} skip` : ''}`,
  ];
}

export function formatSummary(result: ConformanceResult): string {
  const passed = result.passed.length;
  const failed = result.failed.length;
  const warned = result.warned.length;
  const skipped = result.skipped.length;
  const total = passed + failed + warned + skipped;
  return [
    `  Passed:   ${String(passed).padStart(3)}`,
    `  Failed:   ${String(failed).padStart(3)}`,
    `  Warned:   ${String(warned).padStart(3)}   (SHOULD, never fails a run)`,
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
 * Emit the full set of warnings (ggui#1526): SHOULD fixtures whose
 * expectation was not met, with the same evidence a failure carries.
 */
export function formatWarnings(warnings: readonly ConformanceFailure[]): string {
  if (warnings.length === 0) return '';
  const lines = ['', 'Warnings (SHOULD):', ''];
  for (const warning of warnings) {
    lines.push(`${MARK_WARN} ${warning.name}  (${warning.criterion})`);
    lines.push(`   ${warning.message}`);
    lines.push(`   expected: ${safeStringify(warning.expected)}`);
    lines.push(`   received: ${safeStringify(warning.received)}`);
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
