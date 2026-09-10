import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DataContract, JsonObject } from '@ggui-ai/protocol';
import type { EvalResult, VisualEvalConfig, VisualEvaluationResult } from '@ggui-ai/ui-gen/evaluation';
import type { GenerationResult } from '@ggui-ai/ui-gen/harness/result-types';
import type { DesignMode } from '@ggui-ai/ui-gen';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { BenchmarkRunResultDisplay } from '@ggui-ai/shared';
import { BENCHMARK_COMMITS } from '../multi-sdk/commits.js';
import { getDefaultVariants } from '../multi-sdk/variants.js';
import type { BenchmarkCommit, BenchmarkRunResult, BenchmarkVariant } from '../multi-sdk/types.js';
import { DEFAULT_GENERATOR_SLUG, REPORT_SCHEMA_VERSION } from '../multi-sdk/types.js';
import { runContractBehaviorCheck } from '../multi-sdk/contract-behavior.js';
import { deriveRuntimeProbeVerdict, type RuntimeProbeVerdict } from '../multi-sdk/runtime-probe.js';
import { persistCanvasScreenshots, type CanvasClass, type CanvasScreenshot, type VisualCanvasArtefact } from '../multi-sdk/canvas.js';
import { evaluateAestheticsPanel, selectPanelPrompt, type PanelEvalResult, type PanelPrompt } from '../multi-sdk/post-eval.js';
import { mapRunResult } from '../multi-sdk/reporter.js';
import { calculateCost, judgePanelCostUsd, resolveCostModelId, resolveJudgeCostModelId, runPostGeneration } from '../multi-sdk/runner.js';

/**
 * Exp 008 EVAL task core (#973; cloud's cell shape on #975). A cell is two
 * Fargate tasks: the MINT (pod image, browser-free) exports a prefix —
 * `compiled.js`, `source.tsx`, `contract.json`, `mint.json`, `eval.json`
 * (once ui-gen's `onGenerated` hook lands) — and the EVAL (this package's
 * image, with Chromium) reads it, runs every judge that needs a browser or
 * the source, and writes `report.json` + `canvas-<class>.png` beside it.
 *
 * `report.json` is ONE `benchmark-report.v2` ROW (the published `results[]`
 * shape, produced by the same `mapRunResult` the reporter uses) plus a
 * `meta` block — so rnd's verdict script reads one shape for the local
 * probe rows and the Stage-1 cells alike. Judges are injected so the core is
 * unit-testable without a browser or a provider key; `scripts/eval-cell.mjs`
 * supplies the real ones.
 */

export const EXP008_CELL_REPORT_VERSION = 'exp008-cell.v1' as const;

export type CellLocator =
  | { readonly kind: 's3'; readonly bucket: string; readonly prefix: string }
  | { readonly kind: 'dir'; readonly dir: string };

/** `s3://bucket/prefix[/]` → bucket + prefix (always with a trailing slash); anything else is a local dir. */
export function parseCellLocator(locator: string): CellLocator {
  if (locator.startsWith('s3://')) {
    const m = /^s3:\/\/([^/]+)\/(.+?)\/?$/.exec(locator);
    if (!m) throw new Error(`eval-cell: S3 cell locator needs a bucket AND a cell prefix: '${locator}'`);
    return { kind: 's3', bucket: m[1]!, prefix: `${m[2]!}/` };
  }
  return { kind: 'dir', dir: locator };
}

/** `mint.json` as cloud's mint observer writes it (#975) — copied off the OBSERVED harness result. */
export interface MintJson {
  readonly cellId: string;
  readonly runId: string;
  readonly arm: string;
  readonly model: string;
  readonly keySource?: string;
  readonly variance?: string;
  readonly variantKey?: string;
  readonly blueprintId?: string;
  readonly codeHash?: string;
  readonly tokens?: { readonly input?: number; readonly output?: number; readonly cacheRead?: number; readonly cacheCreation?: number };
  /** Pod wall time. */
  readonly latencyMs?: number;
  readonly mintMs?: number;
  /** Harness generation time (the row's `generation.generationTimeMs`; `latencyMs` is the fallback). */
  readonly generationTimeMs?: number | null;
  readonly turnsUsed?: number | null;
  readonly passesUsed?: number | null;
  readonly designMode?: DesignMode;
  readonly canvas?: CanvasClass | null;
  /** The driver's request; the mint refuses to export on a stamped/requested mismatch (exit 4), so this is a receipt, not an input. */
  readonly requested?: { readonly designMode?: DesignMode; readonly canvas?: CanvasClass | null };
  readonly warnings?: readonly string[];
}

/** `contract.json`: the contract plus its key and the corpus commit it was minted for. */
export interface ContractJson {
  readonly contract: DataContract;
  readonly contractKey?: string;
  /** The corpus commit the arm was minted for; `null` when the mint ran without `MINT_COMMIT_REF`. */
  readonly commitRef: string | null;
}

export interface CellInputs {
  readonly dir: string;
  readonly mint: MintJson;
  readonly commit: BenchmarkCommit;
  readonly variant: BenchmarkVariant;
  readonly contract: DataContract;
  readonly contractKey?: string;
  readonly compiledCode: string;
  readonly sourceCode: string;
  /** The harness `GenerationResult.evalResult` as exported by the mint; absent until the hook lands. */
  readonly evalResult?: EvalResult;
}

/** Corpus lookup by id — loud on a miss; a silent default would judge the wrong prompt. */
export function commitForRef(ref: string): BenchmarkCommit {
  const commit = BENCHMARK_COMMITS.find((c) => c.id === ref);
  if (!commit) {
    throw new Error(`eval-cell: unknown commit ref '${ref}' (not in BENCHMARK_COMMITS)`);
  }
  return commit;
}

/** The public arm a model id belongs to — the row's `variant`; loud when the model is not a matrix arm. */
export function variantForModel(modelId: string): BenchmarkVariant {
  const variant = getDefaultVariants().find((v) => v.modelId === modelId);
  if (!variant) {
    throw new Error(`eval-cell: model '${modelId}' is not a default matrix arm (no variant carries it)`);
  }
  return variant;
}

function requireCommitRef(ref: string | null): string {
  if (ref === null) {
    throw new Error(
      'eval-cell: contract.json.commitRef is null — the mint task ran without MINT_COMMIT_REF, so the eval cannot pick a prompt',
    );
  }
  return ref;
}

function readRequired(dir: string, name: string): string {
  const path = join(dir, name);
  if (!existsSync(path)) throw new Error(`eval-cell: required cell file missing: ${name} (in ${dir})`);
  return readFileSync(path, 'utf8');
}

export function readCellInputs(dir: string): CellInputs {
  const mint: MintJson = JSON.parse(readRequired(dir, 'mint.json'));
  const contractJson: ContractJson = JSON.parse(readRequired(dir, 'contract.json'));
  const compiledCode = readRequired(dir, 'compiled.js');
  const sourceCode = readRequired(dir, 'source.tsx');
  const evalPath = join(dir, 'eval.json');
  const evalResult: EvalResult | undefined = existsSync(evalPath) ? JSON.parse(readFileSync(evalPath, 'utf8')) : undefined;
  return {
    dir,
    mint,
    commit: commitForRef(requireCommitRef(contractJson.commitRef)),
    variant: variantForModel(mint.model),
    contract: contractJson.contract,
    ...(contractJson.contractKey !== undefined ? { contractKey: contractJson.contractKey } : {}),
    compiledCode,
    sourceCode,
    ...(evalResult !== undefined ? { evalResult } : {}),
  };
}

export const EVAL_JSON_ABSENT_REASON = 'eval.json absent — mint did not export the in-loop evaluation';

/** The runner's verdict from the exported in-loop evaluation; absent export = skipped with the reason, never a pass. */
export function deriveRuntimeProbeVerdictFromExport(evalResult: EvalResult | undefined): RuntimeProbeVerdict {
  if (!evalResult) return { status: 'skipped', passed: false, failures: 0, warnings: 0, reason: EVAL_JSON_ABSENT_REASON };
  return deriveRuntimeProbeVerdict(evalResult);
}

/** What the per-canvas visual judge hands back (ui-gen's `runVisualEvaluation` with `canvases` set). */
export interface VisualOutcome {
  readonly score: number;
  readonly passed: boolean;
  readonly canvases?: readonly CanvasScreenshot[];
  /** The judge's own token use (all canvas calls), priced into `estimatedCostUsd`. */
  readonly tokens?: { readonly input: number; readonly output: number };
}

/**
 * ui-gen's visual result → the outcome the core records. TYPED against
 * `VisualEvaluationResult` so a field rename fails compilation here instead
 * of at 03:00Z in Fargate (the aggregate is `finalScore`, not `score`).
 */
export function toVisualOutcome(r: VisualEvaluationResult | null): VisualOutcome | null {
  if (r === null) return null;
  return {
    score: r.finalScore,
    passed: r.passed,
    ...(r.canvases !== undefined ? { canvases: r.canvases } : {}),
    ...(r.inputTokens !== undefined && r.outputTokens !== undefined ? { tokens: { input: r.inputTokens, output: r.outputTokens } } : {}),
  };
}

export type PanelJudge = (sourceCode: string, prompt: string, contract: DataContract) => Promise<PanelEvalResult | null>;
export type VisualJudge = (ctx: {
  compiledCode: string;
  originalPrompt: string;
  contract: DataContract;
  /** The commit's fixture props — what the harness passes the judge (`runner.ts:423`). */
  sampleProps?: JsonObject;
}) => Promise<VisualOutcome | null>;

/**
 * The visual judge's identity — FIXED across arms and models (rnd §5b): never
 * one of the models under test judging itself. Recorded in `report.meta` so
 * the verdict script and the ledger cite it.
 */
export interface VisualJudgeIdentity {
  readonly provider: VisualEvalConfig['provider'];
  readonly model: string;
  readonly passThreshold: number;
}

/** The visual judge's token cost, priced like the panel judges (same registry resolution). 0 when the judge reported no tokens. */
export function visualJudgeCostUsd(judge: VisualJudgeIdentity, outcome: VisualOutcome | null): number {
  if (!outcome?.tokens) return 0;
  return calculateCost(resolveJudgeCostModelId(judge.model), { input: outcome.tokens.input, output: outcome.tokens.output });
}

/**
 * The MINT leg's receipt for this cell, handed to the eval task by the driver from
 * its run manifest (ECS forgets stopped tasks within the hour; the operator role
 * cannot write to the bucket). Stamped verbatim into `report.meta` so the verdict
 * can check the image the cell was minted on and the prompt digests of that image
 * against the experiment's pins — a receipt on the row, not the operator's word.
 */
export interface MintReceipt {
  readonly image: string;
  readonly imageDigest?: string;
  readonly sourceSha: string;
  readonly promptDigests: { readonly constrained: string; readonly free: string };
}

export interface EvalCellDeps {
  readonly dir: string;
  /** Absent = the eval task ran without the MINT_* receipt env (recorded in `notes`). */
  readonly mintReceipt?: MintReceipt;
  readonly playwright?: PlaywrightModule;
  /** Default: the arm-neutral aesthetic panel (#973 §5b). */
  readonly panel?: PanelJudge;
  /** Which panel prompt `panel` judges with — recorded even when the panel returns null. Default `'arm-neutral'`. */
  readonly panelPrompt?: PanelPrompt;
  /** Absent = the visual judge is not configured (recorded in `notes`). */
  readonly visual?: VisualJudge;
  /** Identity of `visual`; recorded in `report.meta.visualJudge` when `visual` is present. */
  readonly visualJudge?: VisualJudgeIdentity;
  readonly contractTimeoutMs?: number;
  /** Injected clock for deterministic timestamps in tests. */
  readonly now?: () => Date;
}

/** `report.json`: one published row + the cell's own record. */
export interface CellReport extends BenchmarkRunResultDisplay {
  readonly schemaVersion: typeof EXP008_CELL_REPORT_VERSION;
  /** The published-report shape the row mirrors. */
  readonly reportSchemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly meta: {
    readonly cellId: string;
    readonly runId: string;
    readonly arm: string;
    readonly codeHash?: string;
    /** Image the cell was MINTED on (from the mint task via the driver's manifest). */
    readonly mintImage?: { readonly image: string; readonly digest?: string };
    /** Source sha the mint image was built from, as declared by the operator with the run. */
    readonly mintSourceSha?: string;
    /** Prompt digests (constrained / free) pinned at `mintSourceSha` — checked against the experiment's pins by the verdict. */
    readonly promptDigests?: { readonly constrained: string; readonly free: string };
    /** Visual score summary of the cell (the per-canvas mean when canvases ran). */
    readonly visual?: { readonly score: number; readonly passed: boolean };
    readonly visualJudge?: VisualJudgeIdentity;
    readonly panelPromptVersion: string;
    /** How `estimatedCostUsd` decomposes — coding tokens, the panel judges, the visual judge. */
    readonly costs: { readonly codingUsd: number; readonly panelUsd: number; readonly visualUsd: number };
    readonly notes: readonly string[];
    readonly timings: { readonly contractMs: number; readonly panelMs: number; readonly visualMs: number };
    readonly generatedAt: string;
  };
}

/** Recorded when the eval task ran without the driver's MINT_* receipt env — the row then carries no mint image/prompt receipt. */
export const MINT_RECEIPT_ABSENT_NOTE = 'mint receipt absent — eval task ran without the MINT_* env (no mintImage / promptDigests on this row)';

const panelFor = (kind: PanelPrompt): PanelJudge => (sourceCode, prompt, contract) =>
  evaluateAestheticsPanel(sourceCode, prompt, contract, { panelPrompt: kind });

/** Run every EVAL-side judge for one cell and write `report.json` (+ PNGs) into `deps.dir`. */
export async function evaluateCell(inputs: CellInputs, deps: EvalCellDeps): Promise<CellReport> {
  const notes: string[] = [];
  if (!deps.mintReceipt) notes.push(MINT_RECEIPT_ABSENT_NOTE);
  const now = deps.now ?? (() => new Date());

  const t0 = Date.now();
  const contractBehavior = await runContractBehaviorCheck({
    compiledCode: inputs.compiledCode,
    contract: inputs.contract,
    ...(inputs.commit.props !== undefined ? { sampleProps: inputs.commit.props } : {}),
    playwright: deps.playwright,
    ...(deps.contractTimeoutMs !== undefined ? { timeoutMs: deps.contractTimeoutMs } : {}),
  });
  const contractMs = Date.now() - t0;

  const runtimeProbeVerdict = deriveRuntimeProbeVerdictFromExport(inputs.evalResult);
  if (!inputs.evalResult) notes.push(EVAL_JSON_ABSENT_REASON);

  const t1 = Date.now();
  const panelPrompt: PanelPrompt = deps.panelPrompt ?? 'arm-neutral';
  const panel = await (deps.panel ?? panelFor(panelPrompt))(inputs.sourceCode, inputs.commit.prompt, inputs.contract);
  const panelMs = Date.now() - t1;
  if (panel === null) notes.push('aesthetic panel returned null (no judge survived)');

  let visual: CellReport['meta']['visual'];
  let visualCanvases: VisualCanvasArtefact[] | undefined;
  let visualOutcome: VisualOutcome | null = null;
  const t2 = Date.now();
  if (!deps.visual) {
    notes.push('visual judge not configured');
  } else {
    const outcome = await deps.visual({
      compiledCode: inputs.compiledCode,
      originalPrompt: inputs.commit.prompt,
      contract: inputs.contract,
      ...(inputs.commit.props !== undefined ? { sampleProps: inputs.commit.props } : {}),
    });
    visualOutcome = outcome;
    if (outcome === null) {
      notes.push('visual judge returned null');
    } else {
      visual = { score: outcome.score, passed: outcome.passed };
      if (outcome.canvases && outcome.canvases.length > 0) {
        visualCanvases = persistCanvasScreenshots(deps.dir, outcome.canvases);
      }
    }
  }
  const visualMs = Date.now() - t2;

  // The cell's generation as the row records it — copied off the mint's
  // OBSERVED harness result (cloud #975 d1), never re-derived here.
  const mint = inputs.mint;
  const input = mint.tokens?.input ?? 0;
  const output = mint.tokens?.output ?? 0;
  if (mint.turnsUsed === undefined || mint.turnsUsed === null) notes.push('turnsUsed absent in mint.json (0 recorded)');
  if (mint.passesUsed === undefined || mint.passesUsed === null) notes.push('passesUsed absent in mint.json (0 recorded)');
  const generation: GenerationResult = {
    compiledCode: inputs.compiledCode,
    sourceCode: inputs.sourceCode,
    tokens: { input, output, total: input + output },
    generationTimeMs: mint.generationTimeMs ?? mint.latencyMs ?? 0,
    turnsUsed: mint.turnsUsed ?? 0,
    passesUsed: mint.passesUsed ?? 0,
    ...(mint.tokens?.cacheRead !== undefined ? { cacheReadTokens: mint.tokens.cacheRead } : {}),
    ...(mint.tokens?.cacheCreation !== undefined ? { cacheCreationTokens: mint.tokens.cacheCreation } : {}),
    ...(mint.designMode !== undefined ? { designMode: mint.designMode } : {}),
    ...(mint.canvas !== undefined && mint.canvas !== null ? { canvas: mint.canvas } : {}),
    ...(inputs.evalResult !== undefined ? { evalResult: inputs.evalResult } : {}),
  };

  // Same cost rule as the published matrix: coding tokens at the registry's
  // rates for the RESOLVED cost model (bare ids normalised by suffix; cache
  // counters priced when present — #979 caveat: absent counters make this an
  // upper bound), plus the panel judges' tokens, plus the visual judge's.
  // The mint carries no adapter `rawCostUsd`, so the estimate is the record.
  const codingUsd = calculateCost(resolveCostModelId(undefined, mint.model), {
    input,
    output,
    ...(mint.tokens?.cacheCreation !== undefined ? { cacheCreation: mint.tokens.cacheCreation } : {}),
    ...(mint.tokens?.cacheRead !== undefined ? { cacheRead: mint.tokens.cacheRead } : {}),
  });
  const panelUsd = judgePanelCostUsd(panel);
  const visualUsd = deps.visualJudge ? visualJudgeCostUsd(deps.visualJudge, visualOutcome) : 0;
  if (deps.visual && visualOutcome !== null && visualOutcome.tokens === undefined) notes.push('visual judge reported no token counts (visual cost 0 recorded)');
  const estimatedCostUsd = codingUsd + panelUsd + visualUsd;

  const result: BenchmarkRunResult = {
    variant: inputs.variant,
    commit: inputs.commit,
    generation,
    evaluation: panel,
    ...(inputs.evalResult !== undefined ? { tierEvaluation: inputs.evalResult } : {}),
    estimatedCostUsd,
    timestamp: now().toISOString(),
    postGeneration: runPostGeneration(generation, inputs.commit),
    generator: DEFAULT_GENERATOR_SLUG,
    runtimeProbeVerdict,
    contractBehavior,
    ...(visualCanvases !== undefined ? { visualCanvases } : {}),
  };

  const report: CellReport = {
    ...mapRunResult(result),
    schemaVersion: EXP008_CELL_REPORT_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    meta: {
      cellId: mint.cellId,
      runId: mint.runId,
      arm: mint.arm,
      ...(mint.codeHash !== undefined ? { codeHash: mint.codeHash } : {}),
      ...(deps.mintReceipt
        ? {
            mintImage: {
              image: deps.mintReceipt.image,
              ...(deps.mintReceipt.imageDigest !== undefined ? { digest: deps.mintReceipt.imageDigest } : {}),
            },
            mintSourceSha: deps.mintReceipt.sourceSha,
            promptDigests: deps.mintReceipt.promptDigests,
          }
        : {}),
      ...(visual !== undefined ? { visual } : {}),
      ...(deps.visual && deps.visualJudge ? { visualJudge: deps.visualJudge } : {}),
      panelPromptVersion: panel?.promptVersion ?? selectPanelPrompt(panelPrompt).promptVersion,
      costs: { codingUsd, panelUsd, visualUsd },
      notes,
      timings: { contractMs, panelMs, visualMs },
      generatedAt: now().toISOString(),
    },
  };
  writeFileSync(join(deps.dir, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
