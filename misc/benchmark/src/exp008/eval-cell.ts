import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { DataContract, JsonObject, AppGenerationProfile, AppTheme } from '@ggui-ai/protocol';
import { parseAppGenerationProfileAtReadDoor, parseAppThemeAtReadDoor } from '@ggui-ai/protocol';
import type { EvalResult, VisualEvalConfig, VisualEvaluationResult } from '@ggui-ai/ui-gen/evaluation';
import type { GenerationResult } from '@ggui-ai/ui-gen/harness/result-types';
import type { DesignMode } from '@ggui-ai/ui-gen';
import type { PlaywrightModule } from '@ggui-ai/ui-visual-tester';
import type { BenchmarkRunResultDisplay } from '@ggui-ai/shared';
import { BENCHMARK_COMMITS } from '../multi-sdk/commits.js';
import { getDefaultVariants } from '../multi-sdk/variants.js';
import type { BenchmarkCommit, BenchmarkRunResult, BenchmarkVariant } from '../multi-sdk/types.js';
import type { ProviderName } from '@ggui-ai/ui-gen/adapters/types';
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

/** Where the judge's sample props came from — stamped on the row so a receipt says in words whether the score is on the sample or the empty state. */
export type PropsSource = 'cell' | 'commit' | 'empty';

/**
 * A bootstrap cell's judge input — the mint exports it beside contract.json
 * when the cell has no corpus commit (the prompt is the visitor's request, not a
 * corpus row). File-level contract shared with the exporter: `judge-input.json`.
 */
export interface BootstrapJudgeInput {
  readonly prompt: string;
  readonly sampleProps?: JsonObject;
  /** The app's generation profile (styling / density / layout), when the app row carries one — the judge scores against it. */
  readonly profile?: AppGenerationProfile;
  /** The app's theme overlay, when the app carries one — the judge renders under it (the visitor's paint), not the design defaults. */
  readonly theme?: AppTheme;
  /**
   * Top-level profile members the read door stripped because this judge does not know them
   * (a newer writer, N−1 #1014) — present only when non-empty. The row names them (#1105):
   * a member the judge should have scored is dropped WITH its name, never silently.
   */
  readonly profileStripped?: readonly string[];
  /** Same for the theme overlay. */
  readonly themeStripped?: readonly string[];
}
/** The row's note when the read door thinned the profile — the names are the point (#1105). */
export const profileMembersStrippedNote = (names: readonly string[]): string =>
  `profile members unknown to this judge were stripped at the read door and not scored: ${names.join(', ')} (newer writer, N−1 #1014)`;
/** Same for the theme overlay: stripped members were not rendered. */
export const themeMembersStrippedNote = (names: readonly string[]): string =>
  `theme members unknown to this judge were stripped at the read door and not rendered: ${names.join(', ')} (newer writer, N−1 #1014)`;
export const JUDGE_INPUT_FILE = 'judge-input.json';
export const BOOTSTRAP_NOTE =
  'bootstrap cell, no corpus — prompt and sample props read from judge-input.json; variant.id "bootstrap" is synthetic when the model is not a matrix arm';
export const EMPTY_PROPS_NOTE = 'no sample props — the judge and the behaviour check rendered the empty state';
/** ggui#1156 part 1: the cell carried no sample props, so the judges rendered the contract author's OWN examples — named, never a synthesis. */
export const exampleFieldsNote = (fields: readonly string[]): string =>
  `judged on empty state + contract examples: ${fields.join(', ')} — the props' copy is the contract author's declared examples, not a sample the cell carried`;
/** ggui#1156 part 2: nothing to render — no sample props on the cell, no examples on the contract, and the contract renders props. The score is a reading about the REQUEST, not the card. */
export const NOT_JUDGEABLE_NOTE =
  'not judgeable: no sampleProps on the item and no examples on the contract — the empty-state score is a reading about the request, not the card; the bar treats it as draft_invalid, never as judge_below_bar';

/**
 * The contract author's declared examples, as the props to render with (ggui#1156 part 1).
 * An `example` is not a synthesis: it is what the author said the data looks like, on the
 * wire, with provenance. `undefined` when no property carries one.
 */
export function examplesFrom(contract: DataContract): { readonly props: JsonObject; readonly fields: readonly string[] } | undefined {
  const properties = contract.propsSpec?.properties ?? {};
  const props: Record<string, JsonObject[string]> = {};
  const fields: string[] = [];
  for (const [name, entry] of Object.entries(properties)) {
    if (entry.example !== undefined) {
      props[name] = entry.example;
      fields.push(name);
    }
  }
  return fields.length > 0 ? { props, fields } : undefined;
}

/** Whether the contract declares any props at all — a props-less card judged empty is judged CORRECTLY and must never read as not-judgeable. */
export function contractRendersProps(contract: DataContract): boolean {
  return Object.keys(contract.propsSpec?.properties ?? {}).length > 0;
}

export interface CellInputs {
  readonly dir: string;
  readonly mint: MintJson;
  readonly commit: BenchmarkCommit;
  readonly variant: BenchmarkVariant;
  /** The prompt the judges score against — the corpus commit's, or the bootstrap cell's judge-input.json. */
  readonly prompt: string;
  /** The sample props the judges and the behaviour check render with (see `propsSource`). */
  readonly sampleProps?: JsonObject;
  readonly propsSource: PropsSource;
  /** ggui#1156: present when `sampleProps` are the contract author's examples (`propsSource` stays 'empty'; the PRESENCE of this field is the fact). */
  readonly exampleFields?: readonly string[];
  /** ggui#1156: false ONLY when nothing could be rendered — `propsSource === 'empty'`, no examples, and the contract renders props. */
  readonly judgeable: boolean;
  /** True when the cell has no corpus commit (contract.json.commitRef === null). */
  readonly bootstrap: boolean;
  /** The app's generation profile from judge-input.json — absent on corpus cells and on bootstrap cells whose app carries none. */
  readonly profile?: AppGenerationProfile;
  /** The app's theme from judge-input.json — the judge renders under it; absent on corpus cells and on themeless apps. */
  readonly theme?: AppTheme;
  /** Profile / theme members the read door stripped (a newer writer) — the row names them (#1105). */
  readonly profileStripped?: readonly string[];
  readonly themeStripped?: readonly string[];
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

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Loud on a missing or malformed judge-input.json — a bootstrap cell without it has no prompt to judge. */
export function readJudgeInput(dir: string): BootstrapJudgeInput {
  const path = join(dir, JUDGE_INPUT_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `eval-cell: contract.json.commitRef is null (a bootstrap cell, no corpus) and ${JUDGE_INPUT_FILE} is missing — the mint must export { prompt, sampleProps? } beside contract.json (in ${dir})`,
    );
  }
  const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!isJsonObject(raw) || typeof raw.prompt !== 'string' || raw.prompt.trim().length === 0) {
    throw new Error(`eval-cell: ${JUDGE_INPUT_FILE} must carry a non-empty string "prompt" (in ${dir})`);
  }
  if (raw.sampleProps !== undefined && !isJsonObject(raw.sampleProps)) {
    throw new Error(`eval-cell: ${JUDGE_INPUT_FILE} "sampleProps" must be a JSON object when present (in ${dir})`);
  }
  // N−1 (#1014): this reader may be OLDER than the writer — a pinned eval image
  // that predates a protocol addition must keep judging. Both reads go through
  // protocol's READ doors (#1105): one door for the mint and the judge, so the
  // two cannot disagree about what a stored profile says, and a member this
  // judge cannot know is dropped WITH ITS NAME on the row, never silently.
  // Limit (the door's): nested objects stay strict, so an additive member
  // INSIDE one of them still refuses here.
  let profile: AppGenerationProfile | undefined;
  let profileStripped: readonly string[] | undefined;
  if (raw.profile !== undefined) {
    const door = parseAppGenerationProfileAtReadDoor(raw.profile);
    if (!door.ok) {
      throw new Error(`eval-cell: ${JUDGE_INPUT_FILE} "profile" is not a generation profile — ${door.issues.join('; ')} (in ${dir})`);
    }
    profile = door.profile;
    if (door.stripped.length > 0) profileStripped = door.stripped;
  }
  let theme: AppTheme | undefined;
  let themeStripped: readonly string[] | undefined;
  if (raw.theme !== undefined) {
    const door = parseAppThemeAtReadDoor(raw.theme);
    if (!door.ok) {
      throw new Error(`eval-cell: ${JUDGE_INPUT_FILE} "theme" is not an app theme — ${door.issues.join('; ')} (in ${dir})`);
    }
    theme = door.theme;
    if (door.stripped.length > 0) themeStripped = door.stripped;
  }
  return {
    prompt: raw.prompt,
    ...(raw.sampleProps !== undefined ? { sampleProps: raw.sampleProps } : {}),
    ...(profile !== undefined ? { profile } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(profileStripped !== undefined ? { profileStripped } : {}),
    ...(themeStripped !== undefined ? { themeStripped } : {}),
  };
}

/** The provider a model ref belongs to, in the matrix's vocabulary — loud for a prefix the matrix does not know. */
export function providerOfModel(modelId: string): ProviderName {
  const prefix = modelId.includes('/') ? modelId.slice(0, modelId.indexOf('/')) : modelId;
  switch (prefix) {
    case 'anthropic':
    case 'claude':
      return 'claude';
    case 'openai':
      return 'openai';
    case 'google':
    case 'gemini':
      return 'google';
    case 'openrouter':
      return 'openrouter';
    default:
      throw new Error(`eval-cell: model '${modelId}' has no provider the matrix knows (prefix '${prefix}')`);
  }
}

/** A bootstrap cell's variant: the matrix arm when the model is one, else a synthetic 'bootstrap' arm carrying the model verbatim. */
export function bootstrapVariant(modelId: string): BenchmarkVariant {
  const arm = getDefaultVariants().find((v) => v.modelId === modelId);
  return arm ?? { id: 'bootstrap', sdkName: providerOfModel(modelId), tier: 'balanced', modelId };
}

/** A bootstrap cell's commit: the judge input as the row's prompt/props, the exported contract as its contract. */
export function bootstrapCommit(judge: BootstrapJudgeInput, contract: DataContract): BenchmarkCommit {
  return {
    id: 'bootstrap',
    name: 'bootstrap cell (no corpus)',
    description: 'The prompt is the visitor request from judge-input.json, not a corpus row.',
    complexity: 'medium',
    prompt: judge.prompt,
    contract,
    ...(judge.sampleProps !== undefined ? { props: judge.sampleProps } : {}),
  };
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
  // A null commitRef is a bootstrap cell (no corpus): its prompt and props come
  // from judge-input.json and become the row's commit; otherwise the corpus row.
  const ref = contractJson.commitRef;
  const bootstrap = ref === null;
  let commit: BenchmarkCommit;
  let profile: AppGenerationProfile | undefined;
  let theme: AppTheme | undefined;
  let profileStripped: readonly string[] | undefined;
  let themeStripped: readonly string[] | undefined;
  if (ref === null) {
    const judge = readJudgeInput(dir);
    commit = bootstrapCommit(judge, contractJson.contract);
    profile = judge.profile;
    theme = judge.theme;
    profileStripped = judge.profileStripped;
    themeStripped = judge.themeStripped;
  } else {
    commit = commitForRef(ref);
    profile = undefined;
    theme = undefined;
  }
  const variant = bootstrap ? bootstrapVariant(mint.model) : variantForModel(mint.model);
  // ggui#1156: the cell's own props win; absent them, the contract author's examples render
  // (propsSource stays 'empty' — the presence of exampleFields is the fact); absent both, a
  // contract that renders props is NOT JUDGEABLE and the bar must not score it against the floor.
  const stated = commit.props;
  const examples = stated === undefined ? examplesFrom(commit.contract) : undefined;
  const sampleProps = stated ?? examples?.props;
  const propsSource: PropsSource = stated !== undefined ? (bootstrap ? 'cell' : 'commit') : 'empty';
  const judgeable = !(propsSource === 'empty' && examples === undefined && contractRendersProps(commit.contract));
  return {
    dir,
    mint,
    commit,
    variant,
    prompt: commit.prompt,
    ...(sampleProps !== undefined ? { sampleProps } : {}),
    propsSource,
    ...(examples !== undefined ? { exampleFields: examples.fields } : {}),
    judgeable,
    bootstrap,
    ...(profile !== undefined ? { profile } : {}),
    ...(theme !== undefined ? { theme } : {}),
    ...(profileStripped !== undefined ? { profileStripped } : {}),
    ...(themeStripped !== undefined ? { themeStripped } : {}),
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
  /** The design tree the judge bundled against — `design@judge` (ggui#1042); absent from a judge before it. */
  readonly design?: NonNullable<VisualEvaluationResult['design']>;
  /** The mode the judge's tokens were composed in, when the caller said (ggui#1076). */
  readonly themeMode?: NonNullable<VisualEvaluationResult['themeMode']>;
}
export const VISUAL_DESIGN_UNSTAMPED_NOTE = 'visual judge design tree unstamped — the evaluator returned no design receipt (a judge before #1042)';

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
    ...(r.design !== undefined ? { design: r.design } : {}),
    ...(r.themeMode !== undefined ? { themeMode: r.themeMode } : {}),
  };
}

export type PanelJudge = (sourceCode: string, prompt: string, contract: DataContract) => Promise<PanelEvalResult | null>;
/** Why the visual judge could not judge — the launcher, the in-page render or the screenshot failed (reason verbatim), at which canvas when known. */
export interface VisualUnavailable {
  readonly unavailableReason: string;
  readonly canvas?: string;
}
export function isVisualUnavailable(v: VisualOutcome | VisualUnavailable | null): v is VisualUnavailable {
  return v !== null && 'unavailableReason' in v;
}

export type VisualJudge = (ctx: {
  compiledCode: string;
  originalPrompt: string;
  /** The app's generation profile, when the cell carries one — the judge scores against it (absent = today's path). */
  profile?: AppGenerationProfile;
  /** The app's theme, when the cell carries one — the judge renders under its overlay (absent = the design defaults, today's path). */
  theme?: AppTheme;
  contract: DataContract;
  /** The commit's fixture props — what the harness passes the judge (`runner.ts:423`). */
  sampleProps?: JsonObject;
}) => Promise<VisualOutcome | VisualUnavailable | null>;

/**
 * The visual judge's identity — FIXED across arms and models (rnd §5b): never
 * one of the models under test judging itself. Recorded in `report.meta` so
 * the verdict script and the ledger cite it.
 */
export interface VisualJudgeIdentity {
  readonly provider: VisualEvalConfig['provider'];
  readonly model: string;
  readonly passThreshold: number;
  /** The judge prompt's version as the evaluator itself declares it (`VISUAL_JUDGE_PROMPT_VERSION`) — absent when the evaluator exports none. */
  readonly promptVersion?: string;
  /** sha256 of the judge prompt the evaluator ran (`VISUAL_JUDGE_PROMPT_DIGEST`, computed at its module load) — the receipt's quote; absent when the evaluator exports none. */
  readonly promptDigest?: string;
  /** Vision calls per sampled canvas (ggui#1072) — an INSTRUMENT dial: a mixed `k` within a run is a mixed instrument. Absent ⇒ 1 (a script before #1072). */
  readonly k?: number;
  /** The canvases sampled `k` times; absent ⇒ every judged canvas when `k > 1`. */
  readonly kCanvases?: readonly CanvasClass[];
  /** sha256 of the design tree the judge painted with — `design@judge` (ggui#1042), stamped from the judgement itself; absent when the judge returned no receipt. */
  readonly designSrcSha256?: string;
  /** The mode the judge's tokens were composed in, when the caller said (ggui#1076). */
  readonly themeMode?: 'light' | 'dark';
}

/** The most vision calls per canvas the eval task accepts from its environment — K is spend: past this a change of code (and a spend clearance) is the only way. */
export const JUDGE_K_MAX = 9;

/**
 * `JUDGE_K` / `JUDGE_K_CANVASES` from the eval task's environment (ggui#1072) —
 * loud on anything that is not an integer in 1..JUDGE_K_MAX or a known canvas
 * class, and loud when `k > 1` names no canvases: sampling every canvas k times
 * is a spend decision the lane must write down, never a default it falls into.
 */
export function parseJudgeKEnv(
  env: { readonly JUDGE_K?: string; readonly JUDGE_K_CANVASES?: string },
  knownCanvases: readonly CanvasClass[],
): { readonly k: number; readonly kCanvases?: readonly CanvasClass[] } {
  const rawK = env.JUDGE_K;
  let k = 1;
  if (rawK !== undefined && rawK.trim() !== '') {
    if (!/^\d+$/.test(rawK.trim()) || Number(rawK) < 1) throw new Error(`eval-cell: JUDGE_K must be an integer >= 1 (got ${JSON.stringify(rawK)})`);
    k = Number(rawK);
    if (k > JUDGE_K_MAX) throw new Error(`eval-cell: JUDGE_K=${k} exceeds JUDGE_K_MAX=${JUDGE_K_MAX} — K is vision calls per canvas per cell; raise the cap in code with the spend cleared, not from the environment`);
  }
  const rawList = env.JUDGE_K_CANVASES;
  if (rawList === undefined || rawList.trim() === '') {
    if (k > 1) throw new Error(`eval-cell: JUDGE_K=${k} requires JUDGE_K_CANVASES (the canvases the bar reads) — sampling every canvas ${k}× is a spend decision, name it`);
    return { k };
  }
  const isKnown = (v: string): v is CanvasClass => (knownCanvases as readonly string[]).includes(v);
  const kCanvases: CanvasClass[] = [];
  for (const part of rawList.split(',').map((p) => p.trim()).filter((p) => p !== '')) {
    if (!isKnown(part)) throw new Error(`eval-cell: JUDGE_K_CANVASES names an unknown canvas class ${JSON.stringify(part)} (known: ${knownCanvases.join(', ')})`);
    if (!kCanvases.includes(part)) kCanvases.push(part);
  }
  return { k, kCanvases };
}
export const VISUAL_PROMPT_UNSTAMPED_NOTE = 'visual judge prompt unstamped — the evaluator exports no VISUAL_JUDGE_PROMPT_VERSION / VISUAL_JUDGE_PROMPT_DIGEST';

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
    /** Where the judges' sample props came from: the cell's judge-input.json, the corpus commit, or nothing (empty state). */
    readonly propsSource: PropsSource;
    /** ggui#1156: emitted only when FALSE — nothing could be rendered; the bar's `draft_invalid` arm reads it before any score meets the floor. Absent ⇒ judged as before. */
    readonly judgeable?: false;
    /** ggui#1156: the props that came from the contract author's examples (`propsSource` stays 'empty'). Presence is the fact the bar derives `"empty+example"` from. */
    readonly exampleFields?: readonly string[];
    /** The generation profile the visual judge was told to score against, verbatim — absent when the cell carried none. */
    readonly profile?: AppGenerationProfile;
    /** True when the judge rendered under the app's theme overlay (judge-input.json.theme) — absent when it rendered the design defaults. */
    readonly themeApplied?: true;
    /** Why the visual judge could not judge (verbatim from the judge), and at which canvas — present only when it could not. */
    readonly visualUnavailableReason?: string;
    readonly visualUnavailableCanvas?: string;
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
  if (deps.visual && deps.visualJudge && (deps.visualJudge.promptVersion === undefined || deps.visualJudge.promptDigest === undefined)) notes.push(VISUAL_PROMPT_UNSTAMPED_NOTE);
  if (inputs.bootstrap) notes.push(BOOTSTRAP_NOTE);
  if (inputs.profileStripped !== undefined && inputs.profileStripped.length > 0) notes.push(profileMembersStrippedNote(inputs.profileStripped));
  if (inputs.themeStripped !== undefined && inputs.themeStripped.length > 0) notes.push(themeMembersStrippedNote(inputs.themeStripped));
  if (inputs.propsSource === 'empty') notes.push(inputs.exampleFields !== undefined ? exampleFieldsNote(inputs.exampleFields) : EMPTY_PROPS_NOTE);
  if (!inputs.judgeable) notes.push(NOT_JUDGEABLE_NOTE);
  if (!deps.mintReceipt) notes.push(MINT_RECEIPT_ABSENT_NOTE);
  const now = deps.now ?? (() => new Date());

  const t0 = Date.now();
  const contractBehavior = await runContractBehaviorCheck({
    compiledCode: inputs.compiledCode,
    contract: inputs.contract,
    ...(inputs.sampleProps !== undefined ? { sampleProps: inputs.sampleProps } : {}),
    playwright: deps.playwright,
    ...(deps.contractTimeoutMs !== undefined ? { timeoutMs: deps.contractTimeoutMs } : {}),
  });
  const contractMs = Date.now() - t0;

  const runtimeProbeVerdict = deriveRuntimeProbeVerdictFromExport(inputs.evalResult);
  if (!inputs.evalResult) notes.push(EVAL_JSON_ABSENT_REASON);

  const t1 = Date.now();
  const panelPrompt: PanelPrompt = deps.panelPrompt ?? 'arm-neutral';
  const panel = await (deps.panel ?? panelFor(panelPrompt))(inputs.sourceCode, inputs.prompt, inputs.contract);
  const panelMs = Date.now() - t1;
  if (panel === null) notes.push('aesthetic panel returned null (no judge survived)');

  let visual: CellReport['meta']['visual'];
  let visualCanvases: VisualCanvasArtefact[] | undefined;
  let visualOutcome: VisualOutcome | null = null;
  let visualUnavailable: VisualUnavailable | undefined;
  const t2 = Date.now();
  if (!deps.visual) {
    notes.push('visual judge not configured');
  } else {
    const outcome = await deps.visual({
      compiledCode: inputs.compiledCode,
      originalPrompt: inputs.prompt,
      ...(inputs.profile !== undefined ? { profile: inputs.profile } : {}),
      ...(inputs.theme !== undefined ? { theme: inputs.theme } : {}),
      contract: inputs.contract,
      ...(inputs.sampleProps !== undefined ? { sampleProps: inputs.sampleProps } : {}),
    });
    if (isVisualUnavailable(outcome)) {
      visualUnavailable = outcome;
      notes.push(`visual judge unavailable — ${outcome.unavailableReason}${outcome.canvas ? ` (canvas ${outcome.canvas})` : ''}`);
    } else if (outcome === null) {
      notes.push('visual judge returned null');
    } else {
      visualOutcome = outcome;
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
  // ggui#1042: a judge that ran but returned no design receipt is named, never assumed.
  if (visualOutcome !== null && visualOutcome.design === undefined) notes.push(VISUAL_DESIGN_UNSTAMPED_NOTE);
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
      propsSource: inputs.propsSource,
      ...(inputs.judgeable ? {} : { judgeable: false as const }),
      ...(inputs.exampleFields !== undefined ? { exampleFields: inputs.exampleFields } : {}),
      ...(inputs.profile !== undefined ? { profile: inputs.profile } : {}),
      ...(inputs.theme !== undefined ? { themeApplied: true as const } : {}),
      ...(visualUnavailable !== undefined
        ? {
            visualUnavailableReason: visualUnavailable.unavailableReason,
            ...(visualUnavailable.canvas !== undefined ? { visualUnavailableCanvas: visualUnavailable.canvas } : {}),
          }
        : {}),
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
      ...(deps.visual && deps.visualJudge
        ? {
            visualJudge: {
              ...deps.visualJudge,
              ...(visualOutcome?.design !== undefined ? { designSrcSha256: visualOutcome.design.srcSha256 } : {}),
              ...(visualOutcome?.themeMode !== undefined ? { themeMode: visualOutcome.themeMode } : {}),
            },
          }
        : {}),
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
