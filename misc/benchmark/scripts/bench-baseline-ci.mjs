#!/usr/bin/env node
// bench:baseline-ci — CI-oriented interpreter for a triage JSON.
//
// Applies the soft-rollout policy:
//   - BLOCKING = severity === 'alert' AND anchor !== 'provisional'
//   - PROVISIONAL = severity === 'alert' AND anchor === 'provisional'
//   - NOTICE, SUPPRESSED, INFORMATIONAL = non-blocking
//
// Reads the triage JSON, partitions items, prints:
//   - GitHub Actions `::error::` annotations for blocking alerts
//   - GitHub Actions `::notice::` annotations for provisional alerts
//   - Optional markdown to a `$GITHUB_STEP_SUMMARY` file
//
// Exit codes:
//   0 — zero blocking alerts (CI PASS)
//   1 — one or more blocking alerts (CI FAIL)
//   2 — invocation error (missing / unreadable / unsupported triage JSON)
//
// Discipline:
//   - This tool is CI policy, NOT triage policy. It NEVER re-classifies
//     items. It just partitions what the triage tool already decided.
//   - No threshold knobs here — all thresholds live in
//     `baseline-diff-triage/policy.ts`.

import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { resolve } from 'node:path';

// ─── CLI ──────────────────────────────────────────────────────────

function parseArgs(argv) {
  const args = { triage: null, summary: null, allowEmpty: false };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--summary') args.summary = argv[++i];
    else if (a === '--allow-empty') args.allowEmpty = true;
    else if (a === '--help' || a === '-h') {
      printHelp();
      process.exit(0);
    } else if (a.startsWith('--')) {
      console.error(`[bench-ci] unknown flag: ${a}`);
      process.exit(2);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) {
    console.error('[bench-ci] expected exactly 1 positional arg: <triage.json>');
    printHelp();
    process.exit(2);
  }
  args.triage = resolve(positional[0]);
  return args;
}

function printHelp() {
  console.log('Usage: bench-baseline-ci [--summary <path>] [--allow-empty] <triage.json>');
  console.log('');
  console.log('CI interpreter: partition triage JSON items into blocking vs non-blocking');
  console.log('per soft-rollout policy.');
  console.log('');
  console.log('Flags:');
  console.log('  --summary <path>   Append a markdown summary to this file (typically $GITHUB_STEP_SUMMARY)');
  console.log('  --allow-empty      Exit 0 when triage.json missing (cold-start / first run); default is exit 2');
  console.log('');
  console.log('Exit codes:');
  console.log('  0  zero blocking alerts (PASS)');
  console.log('  1  one or more blocking alerts (FAIL)');
  console.log('  2  invocation error');
}

// ─── Main ─────────────────────────────────────────────────────────

function main() {
  const args = parseArgs(process.argv);

  if (!existsSync(args.triage)) {
    if (args.allowEmpty) {
      const msg = `[bench-ci] triage not found at ${args.triage} — cold start, no prior baseline; exiting 0 (--allow-empty)`;
      console.log(msg);
      if (args.summary) {
        appendFileSync(
          args.summary,
          `## Benchmark pipeline\n\n_Cold start — no cached baseline to diff against. Bundle uploaded; diff + triage skipped._\n\n`,
        );
      }
      process.exit(0);
    }
    console.error(`[bench-ci] triage file not found: ${args.triage}`);
    process.exit(2);
  }

  let report;
  try {
    report = JSON.parse(readFileSync(args.triage, 'utf8'));
  } catch (e) {
    console.error(`[bench-ci] failed to parse triage JSON: ${e.message}`);
    process.exit(2);
  }

  if (report?.schemaVersion !== 'bench-baseline-diff-triage.v0') {
    console.error(
      `[bench-ci] unsupported triage schemaVersion: ${report?.schemaVersion}`,
    );
    process.exit(2);
  }

  const items = Array.isArray(report.items) ? report.items : [];
  const blocking = items.filter(
    (i) => i.severity === 'alert' && i.anchor !== 'provisional',
  );
  const provisional = items.filter(
    (i) => i.severity === 'alert' && i.anchor === 'provisional',
  );
  const notices = items.filter((i) => i.severity === 'notice');
  const counts = report.counts ?? { alert: 0, notice: 0, suppressed: 0, informational: 0 };

  // ── GitHub Actions annotations ────────────────────────────────
  for (const it of blocking) {
    // ::error:: annotations are picked up by the PR checks UI and
    // turn red. Blocking alerts get this treatment.
    console.log(
      `::error title=Bench regression [${it.benchName}]::${it.location} ${formatMessage(it)}`,
    );
  }
  for (const it of provisional) {
    // ::notice:: for provisional alerts — visible but not red.
    console.log(
      `::notice title=Provisional alert [${it.benchName}]::${it.location} ${formatMessage(it)}`,
    );
  }

  // ── Console summary ───────────────────────────────────────────
  const ok = blocking.length === 0;
  console.log('');
  console.log(
    `Bench-CI soft-rollout — ${ok ? '✓ PASS' : '✗ FAIL'}  blocking=${blocking.length} provisional=${provisional.length} notice=${counts.notice} suppressed=${counts.suppressed} informational=${counts.informational}`,
  );
  console.log(
    `  source: ${report.source?.beforeBaselineId ?? '?'} → ${report.source?.afterBaselineId ?? '?'}`,
  );
  if (blocking.length > 0) {
    console.log(`  blocking alerts (will fail CI):`);
    for (const it of blocking) console.log(`    ✗ ${formatLine(it)}`);
  }
  if (provisional.length > 0) {
    console.log(`  provisional alerts (NOT blocking — calibration not yet anchored):`);
    for (const it of provisional) console.log(`    ! ${formatLine(it)}`);
  }
  if (notices.length > 0) {
    console.log(`  notices:`);
    for (const it of notices) console.log(`    · ${formatLine(it)}`);
  }

  // ── GITHUB_STEP_SUMMARY markdown ──────────────────────────────
  if (args.summary) {
    appendFileSync(args.summary, renderMarkdown(report, blocking, provisional, notices));
  }

  process.exit(ok ? 0 : 1);
}

// ─── Formatting helpers ───────────────────────────────────────────

function formatMessage(it) {
  const extras = [];
  if (it.context?.before != null) extras.push(`before=${fmtVal(it.context.before)}`);
  if (it.context?.after != null) extras.push(`after=${fmtVal(it.context.after)}`);
  if (it.context?.delta != null) extras.push(`Δ=${fmtVal(it.context.delta)}`);
  const extra = extras.length > 0 ? ` (${extras.join(' ')})` : '';
  return `${it.message}${extra}`;
}

function formatLine(it) {
  const anchor = it.anchor === 'provisional' ? '[provisional]' : `[cal:${it.anchor}]`;
  return `[${it.benchName}] ${it.location} ${anchor} — ${it.message}`;
}

function fmtVal(v) {
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return String(v);
  if (Math.abs(v) >= 100) return String(Math.round(v));
  return v.toFixed(2);
}

function renderMarkdown(report, blocking, provisional, notices) {
  const lines = [];
  const ok = blocking.length === 0;
  const bId = report.source?.beforeBaselineId ?? '?';
  const aId = report.source?.afterBaselineId ?? '?';
  const bSha = report.source?.beforeGitSha?.slice(0, 8) ?? '?';
  const aSha = report.source?.afterGitSha?.slice(0, 8) ?? '?';

  lines.push('## Benchmark pipeline');
  lines.push('');
  lines.push(ok ? '**✓ PASS** — no blocking alerts' : `**✗ FAIL** — ${blocking.length} blocking alert${blocking.length === 1 ? '' : 's'}`);
  lines.push('');
  lines.push(`- Before: \`${bId}\` (git \`${bSha}\`)`);
  lines.push(`- After:  \`${aId}\` (git \`${aSha}\`)`);
  lines.push('');
  lines.push('### Counts');
  lines.push('');
  lines.push('| class | count | policy |');
  lines.push('|---|---|---|');
  lines.push(`| blocking alerts | **${blocking.length}** | fails CI |`);
  lines.push(`| provisional alerts | ${provisional.length} | surfaced, non-blocking |`);
  lines.push(`| notices | ${report.counts?.notice ?? 0} | non-blocking |`);
  lines.push(`| suppressed | ${report.counts?.suppressed ?? 0} | noise / improvements |`);
  lines.push(`| informational | ${report.counts?.informational ?? 0} | schema drift / nulls |`);
  lines.push('');

  if (blocking.length > 0) {
    lines.push('### Blocking alerts (calibration-anchored)');
    lines.push('');
    for (const it of blocking) {
      lines.push(`- **[${it.benchName}]** \`${it.location}\` — ${it.message} _(anchor: \`${it.anchor}\`)_`);
    }
    lines.push('');
  }
  if (provisional.length > 0) {
    lines.push('### Provisional alerts (non-blocking — thresholds not yet calibrated)');
    lines.push('');
    for (const it of provisional) {
      lines.push(`- **[${it.benchName}]** \`${it.location}\` — ${it.message}`);
    }
    lines.push('');
  }
  if (notices.length > 0) {
    lines.push('### Notices');
    lines.push('');
    for (const it of notices) {
      lines.push(`- [${it.benchName}] \`${it.location}\` — ${it.message}`);
    }
    lines.push('');
  }
  if (!ok) {
    lines.push('---');
    lines.push('');
    lines.push('**How to interpret:** blocking alerts are anchored to real calibration bundles (R1, F1, F2, N1-N4). They represent behaviors that real regression evidence justifies gating on. Fix or justify the regression before merging.');
    lines.push('');
  } else if (provisional.length > 0) {
    lines.push('---');
    lines.push('');
    lines.push('**Provisional alerts** fired on thresholds that lack real calibration anchors. They are surfaced for awareness but do NOT block the build. If a provisional alert catches something real, consider upgrading the rule\'s anchor in `baseline-diff-triage/policy.ts`.');
    lines.push('');
  }

  return lines.join('\n') + '\n';
}

main();
