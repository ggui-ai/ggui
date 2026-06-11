/**
 * Triage policy v0 — all thresholds in one place.
 *
 * Every rule carries a `CalibrationAnchor` so readers know whether a
 * threshold was validated against a real bundle (`R1`, `F1`, `F2`,
 * `N1-N4`) or is a provisional guess that needs more data.
 *
 * Design intent:
 *   - Narrow + legible. Per-bench classify functions, explicit
 *     switch statements. Grep-friendly.
 *   - No hidden defaults — unknown fields fall back to
 *     `suppressed` (provisional) with a clear reason, never to
 *     `alert` by accident.
 *   - Thresholds are the ONLY knobs. Everything else is shape rules.
 */

import type { BenchName } from '../baseline/manifest.js';
import type {
  BenchDiffEntry,
  FieldDelta,
  RowDiff,
  StatusChange,
} from '../baseline-diff/types.js';
import type {
  CalibrationAnchor,
  Severity,
  TriageItem,
  TriageItemContext,
} from './types.js';

// ─── Threshold constants ──────────────────────────────────────────
// Grouped by type so adjusting one bench's budget doesn't require
// touching another's. Every constant cites the calibration anchor
// that justifies the number.

export const THRESHOLDS = {
  /**
   * Absolute ms floor on deterministic benches — deltas below this
   * are suppressed as same-code jitter. Calibrated from N1→N2 where
   * slo.blueprint_hit.timeToFirstPreview shifted +1.0ms on identical
   * code.
   */
  deterministicNoiseFloorMs: 2,
  /** Anchor: N1-N4. */

  // ── SLO latency bands (calibrated against R1's +50ms signal) ──
  sloLatencyNoticeMs: 5,
  sloLatencyAlertMs: 20,

  // ── A2UI latency bands (same shape; R1 didn't perturb a2ui
  //    latencies so these inherit from slo) ──
  a2uiLatencyNoticeMs: 5,
  a2uiLatencyAlertMs: 20,

  // ── Rate thresholds (percentage points, 0..1 scale) ──
  a2uiParsePassRateDropAlert: 0.01, // 1pp — deterministic emitter should never drop parse rate
  multiSdkSuccessRateDropAlert: 0.10, // 10pp — calibrated against F1 (100% → 0%)

  // ── multi-sdk quality band (avgScore — 0..100 scale) ──
  // R1 did not perturb multi-sdk score; thresholds provisional.
  // Rationale: a 3-point drop is ~4% of an 80-point baseline,
  // conservative enough to surface real regressions without
  // tripping on LLM stochasticity. Revisit after more same-code
  // samples or a deliberate score regression bundle.
  multiSdkScoreAlertDrop: 3.0,
  multiSdkScoreNoticeDrop: 1.0,

  // ── multi-sdk latency (relative — absolute thresholds useless on
  //    10+ second runs) ──
  multiSdkTimeRelAlert: 0.5, // +50%: likely a real slowdown
  multiSdkTimeRelNotice: 0.2, // +20%: drift worth a look
} as const;

// ─── Severity resolution on status transitions ────────────────────

export function classifyStatus(entry: BenchDiffEntry): TriageItem | null {
  const rule: Record<StatusChange, { severity: Severity; anchor: CalibrationAnchor; msg: string } | null> = {
    regressed: {
      severity: 'alert',
      anchor: 'F2',
      msg: 'bench status regressed (success → failed)',
    },
    'same-failed': {
      severity: 'alert',
      anchor: 'provisional',
      msg: 'bench remains failed across both bundles',
    },
    removed: {
      severity: 'alert',
      anchor: 'provisional',
      msg: 'bench disappeared from after-bundle — likely accidental drop',
    },
    recovered: {
      severity: 'notice',
      anchor: 'F2',
      msg: 'bench recovered (failed → success)',
    },
    added: {
      severity: 'notice',
      anchor: 'provisional',
      msg: 'bench added in after-bundle — confirm intent',
    },
    'same-success': null, // no status-level item; field rules apply
  };
  const r = rule[entry.statusChange];
  if (!r) return null;
  const context: TriageItemContext = {
    statusChange: entry.statusChange,
    beforeStatus: entry.beforeStatus,
    afterStatus: entry.afterStatus,
  };
  return {
    benchName: entry.benchName,
    location: `${entry.benchName}.status`,
    severity: r.severity,
    rule: `status-${entry.statusChange}`,
    anchor: r.anchor,
    message: r.msg,
    context,
  };
}

// ─── Row-presence classification ──────────────────────────────────

/**
 * A row appearing or disappearing from a summary is either
 * structural (schema drift — informational) or semantic (a real new
 * or retired group — notice/alert). The diff entry's notes tell us
 * which: if any note mentions "missing" the summaryPath or calls out
 * schema drift, the presence change is structural.
 */
export function classifyRowPresence(
  entry: BenchDiffEntry,
  row: RowDiff,
  driftNoted: boolean,
): TriageItem | null {
  if (row.presence === 'both') return null;
  if (driftNoted) {
    return {
      benchName: entry.benchName,
      location: `${entry.benchName}.${row.key}.presence`,
      severity: 'informational',
      rule: `row-${row.presence}-schema-drift`,
      anchor: 'provisional',
      message: `row ${row.presence} due to schema drift between bundles`,
      context: { note: describeDriftNote(entry.notes) },
    };
  }
  if (row.presence === 'added') {
    return {
      benchName: entry.benchName,
      location: `${entry.benchName}.${row.key}.presence`,
      severity: 'notice',
      rule: 'row-added',
      anchor: 'provisional',
      message: `new summary row appeared (${row.key})`,
      context: {},
    };
  }
  // removed, no drift note → treat as alert: a group disappearing
  // without schema explanation is usually a real regression (e.g.,
  // "blueprint_hit" stopped firing at all).
  return {
    benchName: entry.benchName,
    location: `${entry.benchName}.${row.key}.presence`,
    severity: 'alert',
    rule: 'row-removed-unexplained',
    anchor: 'provisional',
    message: `summary row disappeared without schema-drift note (${row.key})`,
    context: {},
  };
}

function describeDriftNote(notes: readonly string[]): string | undefined {
  const relevant = notes.find(
    (n) =>
      n.toLowerCase().includes('missing') ||
      n.toLowerCase().includes('schemaversion'),
  );
  return relevant;
}

// ─── Per-bench field classification ───────────────────────────────

/**
 * Route a field delta to the bench-specific classifier. Unknown
 * benches fall back to `suppressed` with a reason — never alert on
 * unknown.
 */
export function classifyField(
  benchName: BenchName,
  rowKey: string,
  fieldName: string,
  delta: FieldDelta,
  rowContext: RowFieldContext,
): TriageItem | null {
  switch (benchName) {
    case 'slo':
      return classifySloField(rowKey, fieldName, delta);
    case 'a2ui':
      return classifyA2uiField(rowKey, fieldName, delta);
    case 'multi-sdk':
      return classifyMultiSdkField(rowKey, fieldName, delta, rowContext);
  }
}

export interface RowFieldContext {
  /**
   * Map of fields on the SAME row, so composite rules (like
   * multi-sdk's F1 silent-failure detection across avgScore +
   * successRate + avgTimeMs) can consult sibling fields.
   */
  readonly siblingFields: Readonly<Record<string, FieldDelta>>;
}

// ── slo ───────────────────────────────────────────────────────────

function classifySloField(
  rowKey: string,
  fieldName: string,
  delta: FieldDelta,
): TriageItem | null {
  const location = `slo.${rowKey}.${fieldName}`;
  if (delta.kind === 'missing') {
    return mkInformational(
      'slo',
      location,
      'field-missing',
      'provisional',
      `${fieldName} missing on both sides — schema drift`,
      delta,
    );
  }
  if (delta.kind === 'scalar') {
    switch (fieldName) {
      case 'previewExpectedButMissingCount':
        return scalarCounterRule(
          'slo',
          location,
          'slo-preview-missing-rise',
          'R1',
          'preview expected but not observed — primary regression signal',
          delta,
          'up-only',
        );
      case 'previewObservedCount':
        return scalarCounterRule(
          'slo',
          location,
          'slo-preview-observed-drop',
          'provisional',
          'fewer preview frames observed than before',
          delta,
          'down-only',
        );
      default:
        return suppressedTinyScalar('slo', location, fieldName, delta);
    }
  }
  // stat band
  if (delta.before?.median == null || delta.after?.median == null) {
    return mkInformational(
      'slo',
      location,
      'stat-null-side',
      'provisional',
      `${fieldName} median null on one side`,
      delta,
    );
  }
  return classifyLatencyStatBand(
    'slo',
    location,
    fieldName,
    delta,
    THRESHOLDS.sloLatencyNoticeMs,
    THRESHOLDS.sloLatencyAlertMs,
    'R1',
  );
}

// ── a2ui ──────────────────────────────────────────────────────────

function classifyA2uiField(
  rowKey: string,
  fieldName: string,
  delta: FieldDelta,
): TriageItem | null {
  const location = `a2ui.${rowKey}.${fieldName}`;
  if (delta.kind === 'missing') {
    return mkInformational(
      'a2ui',
      location,
      'field-missing',
      'provisional',
      `${fieldName} missing on both sides — schema drift`,
      delta,
    );
  }
  if (delta.kind === 'scalar') {
    switch (fieldName) {
      case 'totalParseFailures':
      case 'runsWithParseFailures':
      case 'previewExpectedButMissingCount':
        return scalarCounterRule(
          'a2ui',
          location,
          `a2ui-${fieldName}-nonzero`,
          'R1',
          `${fieldName} increased — regression`,
          delta,
          'up-only',
        );
      default:
        return suppressedTinyScalar('a2ui', location, fieldName, delta);
    }
  }
  // stat band
  if (delta.before?.median == null || delta.after?.median == null) {
    return mkInformational(
      'a2ui',
      location,
      'stat-null-side',
      'provisional',
      `${fieldName} median null on one side`,
      delta,
    );
  }
  // a2ui frameCount is a stat but a counter-like one: the emitter
  // emits exactly 4 frames per run. Any drift in median is real.
  if (fieldName === 'frameCount') {
    if ((delta.deltaMedian ?? 0) !== 0) {
      return mkItem(
        'a2ui',
        location,
        'a2ui-framecount-drift',
        'R1',
        'alert',
        `frameCount median moved (${delta.before?.median} → ${delta.after?.median}) — deterministic emitter should not drift`,
        { before: delta.before?.median, after: delta.after?.median, delta: delta.deltaMedian },
      );
    }
    return mkItem(
      'a2ui',
      location,
      'a2ui-framecount-ok',
      'N1-N4',
      'suppressed',
      'frameCount median unchanged',
      { before: delta.before?.median, after: delta.after?.median, delta: 0 },
    );
  }
  // parsePassRate as a stat band (0..1). Drop of ≥1pp (0.01) on
  // median → alert.
  if (fieldName === 'parsePassRate') {
    const dm = delta.deltaMedian ?? 0;
    if (dm <= -THRESHOLDS.a2uiParsePassRateDropAlert) {
      return mkItem(
        'a2ui',
        location,
        'a2ui-parsepass-drop',
        'R1',
        'alert',
        `parsePassRate dropped ${(dm * 100).toFixed(1)}pp (${(delta.before!.median! * 100).toFixed(0)}% → ${(delta.after!.median! * 100).toFixed(0)}%)`,
        {
          before: delta.before!.median,
          after: delta.after!.median,
          delta: dm,
        },
      );
    }
    return mkItem(
      'a2ui',
      location,
      'a2ui-parsepass-ok',
      'R1',
      'suppressed',
      `parsePassRate delta below threshold`,
      { delta: dm },
    );
  }
  return classifyLatencyStatBand(
    'a2ui',
    location,
    fieldName,
    delta,
    THRESHOLDS.a2uiLatencyNoticeMs,
    THRESHOLDS.a2uiLatencyAlertMs,
    'provisional',
  );
}

// ── multi-sdk ─────────────────────────────────────────────────────

function classifyMultiSdkField(
  rowKey: string,
  fieldName: string,
  delta: FieldDelta,
  rowContext: RowFieldContext,
): TriageItem | null {
  const location = `multi-sdk.${rowKey}.${fieldName}`;
  if (delta.kind === 'missing') {
    return mkInformational(
      'multi-sdk',
      location,
      'field-missing',
      'provisional',
      `${fieldName} missing on both sides — likely pre-generatorSummaries report`,
      delta,
    );
  }
  if (delta.kind !== 'scalar') {
    // multi-sdk has no stat-band fields in the current spec
    return null;
  }
  switch (fieldName) {
    case 'successRate':
      return rateRule(
        'multi-sdk',
        location,
        'multisdk-successrate-drop',
        'F1',
        'multi-sdk successRate dropped — runs are failing internally',
        delta,
        'down-only',
        THRESHOLDS.multiSdkSuccessRateDropAlert,
      );

    case 'avgScore':
      return classifyMultiSdkScore(location, delta);

    case 'avgTimeMs':
      return classifyMultiSdkTime(location, delta, rowContext);

    case 'runs':
      return suppressedTinyScalar('multi-sdk', location, fieldName, delta);

    default:
      return suppressedTinyScalar('multi-sdk', location, fieldName, delta);
  }
}

/**
 * avgScore-specific rule:
 *   - If before ≥ 0 and after < 0 → F1 silent-failure signal. Alert.
 *     (multi-sdk reports avgScore = -1 when no runs produced a score.)
 *   - If both sides ≥ 0:
 *       drop ≥ alertDrop → alert
 *       drop ≥ noticeDrop → notice
 *       otherwise → suppressed
 *   - If before < 0 and after ≥ 0 → notice (recovery from n/a).
 */
function classifyMultiSdkScore(
  location: string,
  delta: FieldDelta & { kind: 'scalar' },
): TriageItem {
  const b = delta.before;
  const a = delta.after;
  const d = delta.delta;

  // Both real numbers → normal score-delta rule.
  if (b !== null && a !== null && b >= 0 && a >= 0) {
    if (d !== null && d <= -THRESHOLDS.multiSdkScoreAlertDrop) {
      return mkItem(
        'multi-sdk',
        location,
        'multisdk-score-alertdrop',
        'provisional',
        'alert',
        `avgScore dropped ${d.toFixed(1)} points (${b.toFixed(1)} → ${a.toFixed(1)})`,
        { before: b, after: a, delta: d },
      );
    }
    if (d !== null && d <= -THRESHOLDS.multiSdkScoreNoticeDrop) {
      return mkItem(
        'multi-sdk',
        location,
        'multisdk-score-noticedrop',
        'provisional',
        'notice',
        `avgScore dropped ${d.toFixed(1)} points (${b.toFixed(1)} → ${a.toFixed(1)})`,
        { before: b, after: a, delta: d },
      );
    }
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-score-stable',
      'provisional',
      'suppressed',
      'avgScore delta below notice threshold',
      { before: b, after: a, delta: d },
    );
  }

  // F1 silent-failure signal: before was a real score, after is
  // sentinel -1 (n/a).
  if (b !== null && a !== null && b >= 0 && a < 0) {
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-score-sentinel',
      'F1',
      'alert',
      `avgScore collapsed to sentinel n/a (${b.toFixed(1)} → n/a) — runs failing internally`,
      { before: b, after: a, delta: d },
    );
  }

  // Recovery from n/a.
  if (b !== null && a !== null && b < 0 && a >= 0) {
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-score-recovery',
      'F1',
      'notice',
      `avgScore recovered from sentinel n/a to ${a.toFixed(1)}`,
      { before: b, after: a, delta: d },
    );
  }

  // Both sentinels — persistent failure.
  if (b !== null && a !== null && b < 0 && a < 0) {
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-score-both-sentinel',
      'provisional',
      'alert',
      'avgScore sentinel n/a on both sides — persistent failure',
      { before: b, after: a, delta: d },
    );
  }

  // Missing side.
  return mkItem(
    'multi-sdk',
    location,
    'multisdk-score-null-side',
    'provisional',
    'informational',
    'avgScore null on one side',
    { before: b, after: a, delta: d },
  );
}

/**
 * avgTimeMs rule:
 *   - If before > 0 and after === 0 AND sibling successRate
 *     collapsed → composite F1 silent-failure signal. Alert.
 *   - Else use relative delta thresholds (absolute thresholds
 *     on 10-second runs don't work).
 */
function classifyMultiSdkTime(
  location: string,
  delta: FieldDelta & { kind: 'scalar' },
  rowContext: RowFieldContext,
): TriageItem | null {
  const b = delta.before;
  const a = delta.after;
  if (b === null || a === null) {
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-time-null-side',
      'provisional',
      'informational',
      'avgTimeMs null on one side',
      { before: b, after: a },
    );
  }

  // Composite F1 detection: time collapsed to 0 alongside
  // successRate collapse. The successRate rule also fires, but
  // we flag this specifically so the alert message is precise.
  if (b > 0 && a === 0) {
    const siblingSuccess = rowContext.siblingFields.successRate;
    const successCollapsed =
      siblingSuccess?.kind === 'scalar' &&
      siblingSuccess.after !== null &&
      siblingSuccess.after <= 0.01;
    if (successCollapsed) {
      return mkItem(
        'multi-sdk',
        location,
        'multisdk-time-zero-composite',
        'F1',
        'alert',
        `avgTimeMs collapsed to 0 alongside successRate collapse — silent internal failure`,
        { before: b, after: a, delta: a - b },
      );
    }
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-time-zero',
      'provisional',
      'alert',
      `avgTimeMs dropped to 0 — investigate whether runs executed`,
      { before: b, after: a, delta: a - b },
    );
  }

  // Both > 0 — apply relative-delta rule.
  if (b > 0 && a > 0) {
    const rel = (a - b) / b;
    if (Math.abs(rel) >= THRESHOLDS.multiSdkTimeRelAlert) {
      return mkItem(
        'multi-sdk',
        location,
        'multisdk-time-rel-alert',
        'provisional',
        'alert',
        `avgTimeMs shifted ${(rel * 100).toFixed(0)}% (${Math.round(b)} → ${Math.round(a)} ms)`,
        { before: b, after: a, delta: a - b, relativeDelta: rel },
      );
    }
    if (Math.abs(rel) >= THRESHOLDS.multiSdkTimeRelNotice) {
      return mkItem(
        'multi-sdk',
        location,
        'multisdk-time-rel-notice',
        'provisional',
        'notice',
        `avgTimeMs shifted ${(rel * 100).toFixed(0)}% (${Math.round(b)} → ${Math.round(a)} ms)`,
        { before: b, after: a, delta: a - b, relativeDelta: rel },
      );
    }
    return mkItem(
      'multi-sdk',
      location,
      'multisdk-time-stable',
      'provisional',
      'suppressed',
      'avgTimeMs relative delta below notice threshold',
      { before: b, after: a, delta: a - b, relativeDelta: rel },
    );
  }

  return null;
}

// ─── Shared rule helpers ──────────────────────────────────────────

/**
 * Scalar-counter rule: counters have zero observed same-code noise
 * (calibrated from N1→N2). Any non-zero move in the asserted
 * direction is an alert.
 */
function scalarCounterRule(
  benchName: BenchName,
  location: string,
  rule: string,
  anchor: CalibrationAnchor,
  message: string,
  delta: FieldDelta & { kind: 'scalar' },
  direction: 'up-only' | 'down-only',
): TriageItem {
  const d = delta.delta;
  if (d === null) {
    return mkItem(
      benchName,
      location,
      `${rule}-null`,
      anchor,
      'informational',
      `${location} delta null (one side missing)`,
      { before: delta.before, after: delta.after },
    );
  }
  const triggers =
    (direction === 'up-only' && d > 0) ||
    (direction === 'down-only' && d < 0);
  if (triggers) {
    return mkItem(benchName, location, rule, anchor, 'alert', `${message}: ${delta.before} → ${delta.after} (Δ ${d > 0 ? '+' : ''}${d})`, {
      before: delta.before,
      after: delta.after,
      delta: d,
    });
  }
  return mkItem(benchName, location, `${rule}-stable`, anchor, 'suppressed', `${location} unchanged or moved in non-regression direction`, {
    before: delta.before,
    after: delta.after,
    delta: d,
  });
}

/**
 * Rate rule: percentage-point threshold (0..1 scale). Severity
 * override lets callers produce notice-only rules.
 */
function rateRule(
  benchName: BenchName,
  location: string,
  rule: string,
  anchor: CalibrationAnchor,
  message: string,
  delta: FieldDelta & { kind: 'scalar' },
  direction: 'up-only' | 'down-only',
  threshold: number,
  severityOverride?: Severity,
): TriageItem {
  const d = delta.delta;
  if (d === null) {
    return mkItem(
      benchName,
      location,
      `${rule}-null`,
      anchor,
      'informational',
      `${location} delta null`,
      { before: delta.before, after: delta.after },
    );
  }
  const signedDelta = direction === 'up-only' ? d : -d;
  // threshold === 0 means "any non-zero move in the asserted
  // direction". Use strict > to avoid firing on stable 0 → 0.
  const triggers =
    threshold === 0 ? signedDelta > 0 : signedDelta >= threshold;
  if (triggers) {
    const sev: Severity = severityOverride ?? 'alert';
    return mkItem(
      benchName,
      location,
      rule,
      anchor,
      sev,
      `${message}: ${(delta.before ?? 0) * 100}% → ${(delta.after ?? 0) * 100}% (Δ ${d > 0 ? '+' : ''}${(d * 100).toFixed(1)}pp)`,
      { before: delta.before, after: delta.after, delta: d },
    );
  }
  return mkItem(
    benchName,
    location,
    `${rule}-stable`,
    anchor,
    'suppressed',
    `${location} below rate threshold`,
    { before: delta.before, after: delta.after, delta: d },
  );
}

/**
 * Latency stat-band rule with absolute ms thresholds + noise-floor
 * suppression.
 */
function classifyLatencyStatBand(
  benchName: BenchName,
  location: string,
  fieldName: string,
  delta: FieldDelta & { kind: 'stat' },
  noticeMs: number,
  alertMs: number,
  anchor: CalibrationAnchor,
): TriageItem {
  const dm = delta.deltaMedian;
  if (dm === null) {
    return mkInformational(
      benchName,
      location,
      'latency-null',
      anchor,
      `${fieldName} median delta unavailable`,
      delta,
    );
  }
  const abs = Math.abs(dm);
  if (abs >= alertMs) {
    return mkItem(
      benchName,
      location,
      `${benchName}-latency-alert`,
      anchor,
      'alert',
      `${fieldName} median shifted ${dm > 0 ? '+' : ''}${dm.toFixed(1)}ms (${delta.before!.median!.toFixed(1)} → ${delta.after!.median!.toFixed(1)} ms)`,
      {
        before: delta.before!.median,
        after: delta.after!.median,
        delta: dm,
      },
    );
  }
  if (abs >= noticeMs) {
    return mkItem(
      benchName,
      location,
      `${benchName}-latency-notice`,
      anchor,
      'notice',
      `${fieldName} median shifted ${dm > 0 ? '+' : ''}${dm.toFixed(1)}ms (${delta.before!.median!.toFixed(1)} → ${delta.after!.median!.toFixed(1)} ms)`,
      {
        before: delta.before!.median,
        after: delta.after!.median,
        delta: dm,
      },
    );
  }
  return mkItem(
    benchName,
    location,
    `${benchName}-latency-suppressed`,
    'N1-N4',
    'suppressed',
    `${fieldName} median delta below noise floor (${dm.toFixed(1)}ms)`,
    { before: delta.before!.median, after: delta.after!.median, delta: dm },
  );
}

/**
 * Fallback: scalar fields we don't have explicit rules for. Emit a
 * suppressed item so the triage report counts it (transparent) but
 * doesn't alert.
 */
function suppressedTinyScalar(
  benchName: BenchName,
  location: string,
  fieldName: string,
  delta: FieldDelta & { kind: 'scalar' },
): TriageItem {
  return mkItem(
    benchName,
    location,
    `${benchName}-unclassified-scalar`,
    'provisional',
    'suppressed',
    `${fieldName} — no explicit rule, default suppressed`,
    {
      before: delta.before,
      after: delta.after,
      delta: delta.delta,
    },
  );
}

// ─── Constructors ─────────────────────────────────────────────────

function mkItem(
  benchName: BenchName,
  location: string,
  rule: string,
  anchor: CalibrationAnchor,
  severity: Severity,
  message: string,
  context: TriageItemContext,
): TriageItem {
  return { benchName, location, severity, rule, anchor, message, context };
}

function mkInformational(
  benchName: BenchName,
  location: string,
  rule: string,
  anchor: CalibrationAnchor,
  message: string,
  delta: FieldDelta,
): TriageItem {
  const context: TriageItemContext = {};
  if (delta.kind === 'scalar') {
    Object.assign(context, { before: delta.before, after: delta.after, delta: delta.delta });
  } else if (delta.kind === 'stat') {
    Object.assign(context, {
      before: delta.before?.median,
      after: delta.after?.median,
      delta: delta.deltaMedian,
    });
  } else {
    Object.assign(context, { note: delta.reason });
  }
  return mkItem(benchName, location, rule, anchor, 'informational', message, context);
}
