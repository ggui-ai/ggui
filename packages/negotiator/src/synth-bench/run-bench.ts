/**
 * Synthesizer bench runner.
 *
 * Two evaluators:
 *
 *   - {@link evaluateAgainstCorpus} — given an `LLMCaller`, runs
 *     `synthesizeContract` over the corpus and compares each output to
 *     the expected structural shape. Used by {@link runSynthBench} for
 *     a real LLM probe (opt-in CLI, costs ~$0.001 per entry on Haiku).
 *
 *   - {@link scoreSynthesizedContract} — pure structural compare. Used
 *     by the deterministic structure-bench test against fixtures and
 *     by the LLM bench to grade live outputs.
 *
 * Pass criteria:
 *   - `hasActionSpec` / `hasContextSpec` / `hasStreamSpec` / `hasProps`
 *     match, OR the entry sets `tolerateEitherShape: true`.
 *   - Gadget / agent-tool *identity* (`capabilityHooks`,
 *     `forbiddenCapabilityHooks`) — registry-bounded names, so a
 *     mismatch is a real retrieval/discrimination bug and DOES fail.
 *
 * Advisory (reported, NOT pass-gating) — see {@link ADVISORY_FAILURE_KINDS}:
 *   - `actionNames` / `contextSlots` / `agentToolNames` are
 *     free-vocabulary: the synth invents the action/slot/tool name and
 *     a checkout-completion action (`finish` / `complete` /
 *     `completePurchase` / `placeOrder` / …) has an unbounded valid
 *     name space. An exact-name allow-list only generates false
 *     negatives, so a name mismatch is surfaced but does not fail the
 *     bench — spec-presence + placement already verify the shape.
 *
 * Validator findings ride along on the report so an operator inspecting
 * a regression can see WHY a synthesized contract was flagged
 * (redundant-action vs novel-shape vs nothing).
 */

import type { DataContract } from '@ggui-ai/protocol';
import { listContractGadgets } from '@ggui-ai/protocol';
import { synthesizeContract } from '../synthesize-contract.js';
import {
  validateContractRedundancy,
  type ContractValidationFinding,
} from '../contract-validators.js';
import type { LLMCaller } from '../llm-caller.js';
import {
  BENCH_CORPUS,
  contractShape,
  type BenchEntry,
  type BenchExpectation,
} from './corpus.js';

export interface ScoreFailure {
  readonly kind:
    | 'synth-declined'
    | 'has-action-mismatch'
    | 'has-context-mismatch'
    | 'has-stream-mismatch'
    | 'has-props-mismatch'
    | 'has-client-capabilities-mismatch'
    | 'has-agent-tools-mismatch'
    | 'action-names-disjoint'
    | 'context-slots-disjoint'
    | 'capability-hooks-disjoint'
    | 'forbidden-capability-hooks-present'
    | 'agent-tool-names-disjoint';
  readonly hint: string;
}

export interface ScoreResult {
  readonly pass: boolean;
  /** True when expectation tolerated either shape and structural match
   *  was loose. Used to distinguish strict pass from tolerated pass in
   *  reporting. */
  readonly tolerated: boolean;
  readonly failures: readonly ScoreFailure[];
}

/**
 * Failure kinds that are ADVISORY — surfaced in the report but do NOT
 * gate pass/fail. These check free-vocabulary names (action / slot /
 * agent-tool keys the synth invents); an exact-name allow-list cannot
 * enumerate the unbounded valid space, so a mismatch is a bench
 * false-negative, not a synth bug. Spec-presence + placement carry the
 * real verdict. Gadget-identity kinds are deliberately NOT here —
 * those names are registry-bounded.
 */
const ADVISORY_FAILURE_KINDS: ReadonlySet<ScoreFailure['kind']> = new Set([
  'action-names-disjoint',
  'context-slots-disjoint',
  'agent-tool-names-disjoint',
]);

/**
 * Compare a synthesized contract against the expected shape. Pure /
 * deterministic — used both by the deterministic structure-bench and
 * by the live-LLM probe.
 */
export function scoreSynthesizedContract(
  contract: DataContract,
  expected: BenchExpectation,
): ScoreResult {
  const failures: ScoreFailure[] = [];
  const tolerate = expected.tolerateEitherShape === true;

  const hasActionSpec =
    contract.actionSpec !== undefined &&
    Object.keys(contract.actionSpec).length > 0;
  const hasContextSpec =
    contract.contextSpec !== undefined &&
    Object.keys(contract.contextSpec).length > 0;
  const hasStreamSpec =
    contract.streamSpec !== undefined &&
    Object.keys(contract.streamSpec).length > 0;
  const hasProps =
    contract.propsSpec !== undefined &&
    contract.propsSpec.properties !== undefined &&
    Object.keys(contract.propsSpec.properties).length > 0;
  // The wire `clientCapabilities.gadgets` map is package-keyed two-level —
  // `listContractGadgets` flattens it to `(package, name)` use
  // records. The export NAME is the discriminating identifier (a
  // `use`-prefixed hook or a PascalCase component). Default empty when
  // the catalog is absent.
  const gadgetUses = listContractGadgets(contract);
  const hasClientCapabilities = gadgetUses.length > 0;
  const agentToolMap = contract.agentCapabilities?.tools ?? {};
  const hasAgentTools = Object.keys(agentToolMap).length > 0;

  if (!tolerate) {
    if (hasActionSpec !== expected.hasActionSpec) {
      failures.push({
        kind: 'has-action-mismatch',
        hint: `expected hasActionSpec=${expected.hasActionSpec}, got ${hasActionSpec}${hasActionSpec ? ` (actions: ${Object.keys(contract.actionSpec ?? {}).join(', ')})` : ''}`,
      });
    }
    if (hasContextSpec !== expected.hasContextSpec) {
      failures.push({
        kind: 'has-context-mismatch',
        hint: `expected hasContextSpec=${expected.hasContextSpec}, got ${hasContextSpec}${hasContextSpec ? ` (slots: ${Object.keys(contract.contextSpec ?? {}).join(', ')})` : ''}`,
      });
    }
    if (hasStreamSpec !== expected.hasStreamSpec) {
      failures.push({
        kind: 'has-stream-mismatch',
        hint: `expected hasStreamSpec=${expected.hasStreamSpec}, got ${hasStreamSpec}`,
      });
    }
    if (hasProps !== expected.hasProps) {
      failures.push({
        kind: 'has-props-mismatch',
        hint: `expected hasProps=${expected.hasProps}, got ${hasProps}`,
      });
    }
    // EE+ surfaces — only enforced when the corpus entry opts in
    // (`hasClientCapabilities`/`hasAgentTools` field present). Legacy
    // entries leave them undefined and skip the check.
    if (expected.hasClientCapabilities !== undefined) {
      if (hasClientCapabilities !== expected.hasClientCapabilities) {
        failures.push({
          kind: 'has-client-capabilities-mismatch',
          hint: `expected hasClientCapabilities=${expected.hasClientCapabilities}, got ${hasClientCapabilities}${hasClientCapabilities ? ` (exports: ${gadgetUses.map((u) => u.name).join(', ')})` : ''}`,
        });
      }
    }
    if (expected.hasAgentTools !== undefined) {
      if (hasAgentTools !== expected.hasAgentTools) {
        failures.push({
          kind: 'has-agent-tools-mismatch',
          hint: `expected hasAgentTools=${expected.hasAgentTools}, got ${hasAgentTools}${hasAgentTools ? ` (tools: ${Object.keys(agentToolMap).join(', ')})` : ''}`,
        });
      }
    }
  }

  if (
    expected.actionNames !== undefined &&
    expected.actionNames.length > 0 &&
    hasActionSpec
  ) {
    const allowed = expected.actionNames.map(toFold);
    const got = Object.keys(contract.actionSpec ?? {});
    const intersects = got.some((name) =>
      allowed.some((a) => containsEither(toFold(name), a)),
    );
    if (!intersects) {
      failures.push({
        kind: 'action-names-disjoint',
        hint: `synthesized actions [${got.join(', ')}] disjoint from allowed [${expected.actionNames.join(', ')}]`,
      });
    }
  }

  if (
    expected.contextSlots !== undefined &&
    expected.contextSlots.length > 0 &&
    hasContextSpec
  ) {
    const allowed = expected.contextSlots.map(toFold);
    const got = Object.keys(contract.contextSpec ?? {});
    const intersects = got.some((slot) =>
      allowed.some((a) => containsEither(toFold(slot), a)),
    );
    if (!intersects) {
      failures.push({
        kind: 'context-slots-disjoint',
        hint: `synthesized slots [${got.join(', ')}] disjoint from allowed [${expected.contextSlots.join(', ')}]`,
      });
    }
  }

  if (
    expected.capabilityHooks !== undefined &&
    expected.capabilityHooks.length > 0 &&
    hasClientCapabilities
  ) {
    const allowed = new Set(expected.capabilityHooks.map(toFold));
    const got = gadgetUses.map((u) => u.name);
    const intersects = got.some((h) => allowed.has(toFold(h)));
    if (!intersects) {
      failures.push({
        kind: 'capability-hooks-disjoint',
        hint: `synthesized hooks [${got.join(', ')}] disjoint from allowed [${expected.capabilityHooks.join(', ')}]`,
      });
    }
  }

  // Forbidden hooks check. Fires even when
  // `hasClientCapabilities=false` is the headline expectation, because
  // the LLM might violate by attaching the wrapper anyway. The check
  // is silent when the contract has no clientCapabilities (nothing to
  // forbid).
  if (
    expected.forbiddenCapabilityHooks !== undefined &&
    expected.forbiddenCapabilityHooks.length > 0
  ) {
    const forbidden = new Set(
      expected.forbiddenCapabilityHooks.map(toFold),
    );
    const got = gadgetUses.map((u) => u.name);
    const violating = got.filter((h) => forbidden.has(toFold(h)));
    if (violating.length > 0) {
      failures.push({
        kind: 'forbidden-capability-hooks-present',
        hint: `synthesized hooks [${violating.join(', ')}] present in forbidden set [${expected.forbiddenCapabilityHooks.join(', ')}] — registered wrapper attached without intent justification`,
      });
    }
  }

  if (
    expected.agentToolNames !== undefined &&
    expected.agentToolNames.length > 0 &&
    hasAgentTools
  ) {
    const allowed = expected.agentToolNames.map(toFold);
    const got = Object.keys(agentToolMap);
    const intersects = got.some((name) =>
      allowed.some((a) => containsEither(toFold(name), a)),
    );
    if (!intersects) {
      failures.push({
        kind: 'agent-tool-names-disjoint',
        hint: `synthesized agentTools [${got.join(', ')}] disjoint from allowed [${expected.agentToolNames.join(', ')}]`,
      });
    }
  }

  // Pass when there are no NON-advisory failures. Advisory findings
  // (free-vocabulary name mismatches) ride along on `failures` for
  // report visibility but never gate the verdict.
  const pass = failures.every((f) => ADVISORY_FAILURE_KINDS.has(f.kind));
  return {
    pass,
    tolerated: tolerate && pass,
    failures,
  };
}

function toFold(s: string): string {
  return s.toLowerCase();
}

function containsEither(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

export interface BenchOutcome {
  readonly entry: BenchEntry;
  readonly contract: DataContract | null;
  readonly score: ScoreResult;
  readonly findings: readonly ContractValidationFinding[];
  readonly latencyMs: number;
  /** LLM attempts the synthesizer made (1 = no repair retry needed). */
  readonly attempts: number;
  readonly synthReason: string;
}

export interface BenchReport {
  readonly outcomes: readonly BenchOutcome[];
  readonly totals: {
    readonly all: number;
    readonly pass: number;
    readonly fail: number;
    readonly synthDeclined: number;
    readonly precision: number;
  };
  readonly byShape: Readonly<
    Record<string, { all: number; pass: number; precision: number }>
  >;
  readonly redundantActionFindings: number;
  readonly latency: { readonly p50Ms: number; readonly p95Ms: number };
}

export interface RunSynthBenchOptions {
  readonly limit?: number;
  /** Filter the corpus to entries of one `contractShape` bucket. */
  readonly shapeFilter?: string;
  readonly onProgress?: (
    outcome: BenchOutcome,
    index: number,
    total: number,
  ) => void;
}

export async function evaluateAgainstCorpus(
  deps: { readonly llm: LLMCaller },
  options: RunSynthBenchOptions = {},
  corpus: readonly BenchEntry[] = BENCH_CORPUS,
): Promise<BenchReport> {
  let subset: readonly BenchEntry[] = corpus;
  if (options.shapeFilter !== undefined) {
    const shapeFilter = options.shapeFilter;
    subset = subset.filter((e) => contractShape(e.expected) === shapeFilter);
  }
  if (options.limit !== undefined) {
    subset = subset.slice(0, options.limit);
  }

  const outcomes: BenchOutcome[] = [];
  for (let i = 0; i < subset.length; i++) {
    const entry = subset[i]!;
    // Thread the entry's per-app registered catalog through to
    // `synthesizeContract`. When absent, synth falls through to the
    // static stdlib hint baked into the system prompt.
    const synth = await synthesizeContract(
      { llm: deps.llm },
      entry.intent,
      entry.appGadgets !== undefined
        ? { appGadgets: entry.appGadgets }
        : undefined,
    );
    let outcome: BenchOutcome;
    if (synth.contract === null) {
      outcome = {
        entry,
        contract: null,
        score: {
          pass: false,
          tolerated: false,
          failures: [
            {
              kind: 'synth-declined',
              hint: `synth declined: ${synth.reason}`,
            },
          ],
        },
        findings: [],
        latencyMs: synth.latencyMs,
        attempts: synth.attempts,
        synthReason: synth.reason,
      };
    } else {
      const findings = validateContractRedundancy(synth.contract).findings;
      const score = scoreSynthesizedContract(synth.contract, entry.expected);
      outcome = {
        entry,
        contract: synth.contract,
        score,
        findings,
        latencyMs: synth.latencyMs,
        attempts: synth.attempts,
        synthReason: synth.reason,
      };
    }
    outcomes.push(outcome);
    options.onProgress?.(outcome, i, subset.length);
  }

  return summarize(outcomes);
}

export function summarize(outcomes: readonly BenchOutcome[]): BenchReport {
  const all = outcomes.length;
  const pass = outcomes.filter((o) => o.score.pass).length;
  const synthDeclined = outcomes.filter((o) => o.contract === null).length;
  const fail = all - pass;
  const precision = all === 0 ? 0 : pass / all;

  // Roll precision up by contract SHAPE (the retired archetype
  // categories are gone). Canonical order keeps the report stable;
  // any shape the corpus doesn't exercise simply drops out.
  const shapeOrder = [
    'props-only',
    'context-only',
    'context+action',
    'stream',
    'with-gadgets',
    'empty',
  ];
  const presentShapes = new Set(
    outcomes.map((o) => contractShape(o.entry.expected)),
  );
  const byShape = Object.fromEntries(
    shapeOrder
      .filter((shape) => presentShapes.has(shape))
      .map((shape) => {
        const subset = outcomes.filter(
          (o) => contractShape(o.entry.expected) === shape,
        );
        const subsetAll = subset.length;
        const subsetPass = subset.filter((o) => o.score.pass).length;
        return [
          shape,
          {
            all: subsetAll,
            pass: subsetPass,
            precision: subsetAll === 0 ? 0 : subsetPass / subsetAll,
          },
        ];
      }),
  ) as BenchReport['byShape'];

  const redundantActionFindings = outcomes
    .flatMap((o) => o.findings)
    .filter((f) => f.kind === 'redundant-action').length;

  const latencies = outcomes.map((o) => o.latencyMs).sort((a, b) => a - b);
  const p50 = percentile(latencies, 0.5);
  const p95 = percentile(latencies, 0.95);

  return {
    outcomes,
    totals: { all, pass, fail, synthDeclined, precision },
    byShape,
    redundantActionFindings,
    latency: { p50Ms: p50, p95Ms: p95 },
  };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
  return sorted[idx] ?? 0;
}

export function formatBenchReport(report: BenchReport): string {
  const lines: string[] = [];
  lines.push('=== synth bench report ===');
  lines.push('');
  lines.push('Precision by contract shape:');
  for (const [shape, stats] of Object.entries(report.byShape)) {
    if (stats.all === 0) continue;
    const pct = (stats.precision * 100).toFixed(1);
    lines.push(`  ${shape.padEnd(16)} ${stats.pass}/${stats.all} (${pct}%)`);
  }
  lines.push('');
  lines.push(
    `Overall:                  ${report.totals.pass}/${report.totals.all} (${(report.totals.precision * 100).toFixed(1)}%)`,
  );
  lines.push(`Synth declined:           ${report.totals.synthDeclined}`);
  lines.push(
    `Redundant-action firings: ${report.redundantActionFindings}`,
  );
  // Free-vocabulary name mismatches — surfaced, non-gating.
  const advisoryCount = report.outcomes.reduce(
    (n, o) =>
      n +
      o.score.failures.filter((f) => ADVISORY_FAILURE_KINDS.has(f.kind))
        .length,
    0,
  );
  lines.push(`Name advisories (non-gating): ${advisoryCount}`);
  lines.push(
    `Latency:                  p50=${report.latency.p50Ms}ms p95=${report.latency.p95Ms}ms`,
  );
  // Repair-loop turn distribution — `1t×N` means N entries synthesized
  // on the first attempt (no repair retry). Early-skip outcomes
  // (attempts=0) are excluded.
  const turnDist = new Map<number, number>();
  for (const o of report.outcomes) {
    if (o.attempts > 0) {
      turnDist.set(o.attempts, (turnDist.get(o.attempts) ?? 0) + 1);
    }
  }
  const turnStr = [...turnDist.keys()]
    .sort((a, b) => a - b)
    .map((t) => `${t}t×${turnDist.get(t)}`)
    .join(' ');
  lines.push(`Attempts:                 ${turnStr || '(none)'}`);

  const failed = report.outcomes.filter((o) => !o.score.pass);
  if (failed.length > 0) {
    lines.push('');
    lines.push('Failures:');
    for (const o of failed) {
      lines.push(
        `  [${contractShape(o.entry.expected)}] ${o.entry.id}: ${o.entry.intent.slice(0, 60)}`,
      );
      for (const f of o.score.failures) {
        lines.push(`    ${f.kind}: ${f.hint}`);
      }
      if (o.findings.length > 0) {
        for (const f of o.findings) {
          lines.push(`    [${f.severity}:${f.kind}] ${f.hint.slice(0, 120)}`);
        }
      }
    }
  }

  return lines.join('\n');
}

export function runSynthBench(
  deps: { readonly llm: LLMCaller },
  options: RunSynthBenchOptions = {},
): Promise<BenchReport> {
  return evaluateAgainstCorpus(deps, options);
}
