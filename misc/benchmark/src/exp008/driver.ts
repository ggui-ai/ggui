import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import type { CanvasClass } from '@ggui-ai/ui-gen/evaluation';
import type { DesignMode } from '@ggui-ai/ui-gen';
import { BENCHMARK_COMMITS } from '../multi-sdk/commits.js';

/**
 * Exp 008 Stage-1 driver core (#973; run mechanics per cloud's #975 and the
 * design's §6/§7). Pure: builds the cell matrix and the two RunTask override
 * payloads; `scripts/exp008-drive.mjs` does the AWS calls. Every cell is
 * minted in the pod's EXPERIMENT mode — the commit's contract rides inline
 * (`MINT_CONTRACT`), nothing is seeded into an app store, no serving-index
 * binding, every cell generates.
 */

/** §6: the six actionSpec bearers (the contract axis) + the two visual-only commits. */
export const STAGE1_COMMITS = [
  'kanban-board', 'product-page', 'survey-form', 'chat-interface', 'onboarding-wizard', 'todo-toggle',
  'release-notes', 'periodic-table',
] as const;

/** ECS caps the whole RunTask `overrides` payload (every env name + value) at 8 KiB. */
export const RUNTASK_OVERRIDES_CAP_BYTES = 8192;

export interface ArmSpec {
  readonly designMode: DesignMode;
}

export interface StageCell {
  readonly runId: string;
  readonly cellId: string;
  readonly commitRef: string;
  readonly arm: string;
  readonly designMode: DesignMode;
  readonly canvas: CanvasClass;
  readonly model: string;
  readonly replicate: number;
  /** `blueprintKey(contract)` — asserted equal by the mint. */
  readonly contractKey: string;
  /** The commit's `DataContract`, serialized once (what `MINT_CONTRACT` carries). */
  readonly contractJson: string;
}

/** `<commit>-<arm>-<model short id>-<n>` — reads by name in the evidence dir and the verdict. */
export function cellIdOf(c: { commitRef: string; arm: string; model: string; replicate: number }): string {
  const short = c.model.includes('/') ? c.model.slice(c.model.indexOf('/') + 1) : c.model;
  return `${c.commitRef}-${c.arm}-${short}-${c.replicate}`;
}

export function buildStage1Cells(spec: {
  readonly runId: string;
  readonly n: number;
  readonly models: readonly string[];
  readonly arms: Readonly<Record<string, ArmSpec>>;
  readonly canvas: CanvasClass;
}): StageCell[] {
  const cells: StageCell[] = [];
  for (const commitRef of STAGE1_COMMITS) {
    const commit = BENCHMARK_COMMITS.find((c) => c.id === commitRef);
    if (!commit) throw new Error(`exp008: Stage-1 commit '${commitRef}' is not in BENCHMARK_COMMITS`);
    const contractJson = JSON.stringify(commit.contract);
    const contractKey = blueprintKey(commit.contract);
    for (const [arm, armSpec] of Object.entries(spec.arms)) {
      for (const model of spec.models) {
        for (let replicate = 1; replicate <= spec.n; replicate++) {
          const cell = { commitRef, arm, model, replicate };
          cells.push({
            runId: spec.runId,
            cellId: cellIdOf(cell),
            commitRef,
            arm,
            designMode: armSpec.designMode,
            canvas: spec.canvas,
            model,
            replicate,
            contractKey,
            contractJson,
          });
        }
      }
    }
  }
  return cells;
}

export interface ContainerOverride {
  readonly containerName: string;
  readonly environment: ReadonlyArray<{ readonly name: string; readonly value: string }>;
}

/** The exact wire shape ECS measures: `overrides.containerOverrides[]` with `name` + `environment`. */
export function runTaskOverridesPayload(o: ContainerOverride): { containerOverrides: Array<{ name: string; environment: ContainerOverride['environment'] }> } {
  return { containerOverrides: [{ name: o.containerName, environment: o.environment }] };
}

function assertOverrideSize(o: ContainerOverride, cellId: string): ContainerOverride {
  const bytes = Buffer.byteLength(JSON.stringify(runTaskOverridesPayload(o)));
  if (bytes >= RUNTASK_OVERRIDES_CAP_BYTES) {
    throw new Error(
      `exp008: RunTask overrides for cell ${cellId} are ${bytes} bytes — over ECS's ${RUNTASK_OVERRIDES_CAP_BYTES}-byte cap; the contract cannot ride inline`,
    );
  }
  return o;
}

/** awsvpc configuration as cloud publishes it in SSM (`subnets`/`securityGroups`, optional `assignPublicIp`); loud on any other shape. */
export function parseNetworkParameter(json: string, parameterName: string): {
  awsvpcConfiguration: { subnets: string[]; securityGroups: string[]; assignPublicIp: 'ENABLED' | 'DISABLED' };
} {
  const v: { subnets?: unknown; securityGroups?: unknown; assignPublicIp?: unknown } = JSON.parse(json);
  const strings = (x: unknown): x is string[] => Array.isArray(x) && x.length > 0 && x.every((s) => typeof s === 'string');
  if (!strings(v.subnets) || !strings(v.securityGroups)) {
    throw new Error(`exp008: SSM ${parameterName} must carry non-empty string arrays 'subnets' and 'securityGroups'`);
  }
  const assignPublicIp = v.assignPublicIp === undefined ? 'ENABLED' : v.assignPublicIp;
  if (assignPublicIp !== 'ENABLED' && assignPublicIp !== 'DISABLED') {
    throw new Error(`exp008: SSM ${parameterName}: assignPublicIp must be ENABLED or DISABLED`);
  }
  return { awsvpcConfiguration: { subnets: v.subnets, securityGroups: v.securityGroups, assignPublicIp } };
}

export function cellPrefixUri(bucket: string, cell: { runId: string; cellId: string }): string {
  return `s3://${bucket}/exp008/${cell.runId}/${cell.cellId}/`;
}

/**
 * MINT task overrides (container `mint`, experiment mode): the contract inline
 * with its key, the arm switch, the export prefix, and the coding model under
 * the env name cloud pins (`modelEnvName`). `MINT_VARIANCE` is left unset →
 * `{}` on the mint side; the mint refuses on a stamped/requested mismatch.
 */
export function buildMintOverrides(
  cell: StageCell,
  opts: { readonly appId: string; readonly bucket: string; readonly modelEnvName: string },
): ContainerOverride {
  const env: Array<{ name: string; value: string }> = [
    { name: 'MINT_APP_ID', value: opts.appId },
    { name: 'MINT_CONTRACT', value: cell.contractJson },
    { name: 'MINT_CONTRACT_KEY', value: cell.contractKey },
    { name: 'MINT_COMMIT_REF', value: cell.commitRef },
    { name: 'MINT_ARM_LABEL', value: cell.arm },
    { name: 'MINT_DESIGN_MODE', value: cell.designMode },
    { name: 'MINT_CANVAS', value: cell.canvas },
    { name: 'MINT_EXPORT_S3_URI', value: cellPrefixUri(opts.bucket, cell) },
    { name: 'MINT_CELL_ID', value: cell.cellId },
    { name: 'MINT_RUN_ID', value: cell.runId },
    { name: 'MINT_REQUEST_ID', value: `exp008_${cell.runId}_${cell.cellId}` },
    { name: opts.modelEnvName, value: cell.model },
  ];
  return assertOverrideSize({ containerName: 'mint', environment: env }, cell.cellId);
}

/** EVAL task overrides (container `eval`, cloud d2): identity + the cell prefix; no `--cell` arg, the script reads `CELL_S3_URI`. */
/** The MINT leg's receipt for a cell, as the driver's run manifest recorded it (see eval-cell's MintReceipt). */
export interface MintReceiptEnv {
  readonly image: string;
  readonly imageDigest?: string;
  readonly sourceSha: string;
  readonly promptDigestConstrained: string;
  readonly promptDigestFree: string;
}

export function buildEvalOverrides(
  cell: StageCell,
  opts: { readonly bucket: string; readonly mintReceipt?: MintReceiptEnv },
): ContainerOverride {
  const receiptEnv = opts.mintReceipt
    ? [
        { name: 'MINT_IMAGE', value: opts.mintReceipt.image },
        ...(opts.mintReceipt.imageDigest !== undefined ? [{ name: 'MINT_IMAGE_DIGEST', value: opts.mintReceipt.imageDigest }] : []),
        { name: 'MINT_SOURCE_SHA', value: opts.mintReceipt.sourceSha },
        { name: 'MINT_PROMPT_DIGEST_CONSTRAINED', value: opts.mintReceipt.promptDigestConstrained },
        { name: 'MINT_PROMPT_DIGEST_FREE', value: opts.mintReceipt.promptDigestFree },
      ]
    : [];
  return assertOverrideSize(
    {
      containerName: 'eval',
      environment: [
        { name: 'CELL_S3_URI', value: cellPrefixUri(opts.bucket, cell) },
        { name: 'CELL_ID', value: cell.cellId },
        { name: 'CELL_RUN_ID', value: cell.runId },
        { name: 'CELL_ARM', value: cell.arm },
        { name: 'CELL_MODEL', value: cell.model },
        { name: 'CELL_CONTRACT_REF', value: cell.commitRef },
        ...receiptEnv,
      ],
    },
    cell.cellId,
  );
}
