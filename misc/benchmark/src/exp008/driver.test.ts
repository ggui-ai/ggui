import { describe, it, expect } from 'vitest';
import {
  STAGE1_COMMITS,
  buildStage1Cells,
  cellIdOf,
  buildMintOverrides,
  buildEvalOverrides,
  runTaskOverridesPayload,
  parseNetworkParameter,
  RUNTASK_OVERRIDES_CAP_BYTES,
  type StageCell,
} from './driver';

const arms = { A: { designMode: 'constrained' as const }, B: { designMode: 'free' as const } };
const models = ['anthropic/claude-fable-5-1', 'openai/gpt-6-astra'];

describe('Stage 1 cell matrix (design §6: 8 commits × 2 arms × 2 models × n)', () => {
  it('names the eight commits in the registered order and builds 96 cells for n = 3', () => {
    expect(STAGE1_COMMITS).toEqual(['kanban-board', 'product-page', 'survey-form', 'chat-interface', 'onboarding-wizard', 'todo-toggle', 'release-notes', 'periodic-table']);
    const cells = buildStage1Cells({ runId: 'r1', n: 3, models, arms, canvas: 'md' });
    expect(cells).toHaveLength(96);
    const ids = new Set(cells.map((c) => c.cellId));
    expect(ids.size).toBe(96);
    expect(cells[0]).toMatchObject({ runId: 'r1', commitRef: 'kanban-board', arm: 'A', designMode: 'constrained', canvas: 'md', model: 'anthropic/claude-fable-5-1', replicate: 1 });
  });

  it('cell ids read by name: <commit>-<arm>-<model short>-<n>', () => {
    expect(cellIdOf({ commitRef: 'kanban-board', arm: 'B', model: 'openai/gpt-6-astra', replicate: 2 })).toBe('kanban-board-B-gpt-6-astra-2');
    expect(cellIdOf({ commitRef: 'todo-toggle', arm: 'A', model: 'anthropic/claude-fable-5-1', replicate: 3 })).toBe('todo-toggle-A-claude-fable-5-1-3');
  });

  it('computes each cell\'s contractKey with blueprintKey and carries the contract JSON', () => {
    const [cell] = buildStage1Cells({ runId: 'r1', n: 1, models: [models[0]!], arms: { A: arms.A }, canvas: 'md' });
    expect(cell?.contractKey).toBe('f8f203d6888cf64b'); // kanban-board, computed 2026-09-09
    expect(JSON.parse(cell!.contractJson)).toHaveProperty('actionSpec');
  });
});

describe('mint overrides (cloud #975 experiment mode)', () => {
  const cell: StageCell = buildStage1Cells({ runId: 'r1', n: 1, models: [models[1]!], arms: { B: arms.B }, canvas: 'md' })[0]!;
  const base = { appId: 'app-under-test', bucket: 'bkt', modelEnvName: 'MINT_MODEL' };

  it('passes the contract inline with its key, the commit ref, arm switch, export prefix and the model under the named env', () => {
    const o = buildMintOverrides(cell, base);
    const env = Object.fromEntries(o.environment.map((e) => [e.name, e.value]));
    expect(o.containerName).toBe('mint');
    expect(env.MINT_APP_ID).toBe('app-under-test');
    expect(env.MINT_CONTRACT_KEY).toBe(cell.contractKey);
    expect(JSON.parse(env.MINT_CONTRACT!)).toHaveProperty('actionSpec');
    expect(env.MINT_COMMIT_REF).toBe('kanban-board');
    expect(env.MINT_DESIGN_MODE).toBe('free');
    expect(env.MINT_CANVAS).toBe('md');
    expect(env.MINT_ARM_LABEL).toBe('B');
    expect(env.MINT_EXPORT_S3_URI).toBe(`s3://bkt/exp008/r1/${cell.cellId}/`);
    expect(env.MINT_CELL_ID).toBe(cell.cellId);
    expect(env.MINT_RUN_ID).toBe('r1');
    expect(env.MINT_MODEL).toBe('openai/gpt-6-astra');
    expect(env.MINT_VARIANCE).toBeUndefined(); // default {} on the mint side
  });

  it('measures the cap on the exact wire shape (containerOverrides[{name, environment}]) — boundary: one byte under passes, the cap itself refuses', () => {
    const size = (c: StageCell) => Buffer.byteLength(JSON.stringify(runTaskOverridesPayload(buildMintOverrides(c, base))));
    const under = size(cell);
    // grow the contract until the real wire payload is exactly cap - 1 bytes
    const pad = RUNTASK_OVERRIDES_CAP_BYTES - 1 - under;
    const justUnder: StageCell = { ...cell, contractJson: cell.contractJson + ' '.repeat(pad) };
    expect(size(justUnder)).toBe(RUNTASK_OVERRIDES_CAP_BYTES - 1);
    expect(() => buildMintOverrides(justUnder, base)).not.toThrow();
    const atCap: StageCell = { ...cell, contractJson: cell.contractJson + ' '.repeat(pad + 1) };
    expect(() => buildMintOverrides(atCap, base)).toThrow(/8192/);
  });

  it('refuses a payload over the ECS RunTask overrides cap instead of truncating silently', () => {
    const fat: StageCell = { ...cell, contractJson: JSON.stringify({ pad: 'x'.repeat(RUNTASK_OVERRIDES_CAP_BYTES) }) };
    expect(() => buildMintOverrides(fat, base)).toThrow(/8192/);
  });
});

describe('eval overrides (cloud #975 d2: CELL_* on container eval, no --cell arg)', () => {
  it('hands the MINT receipt to the eval task under the MINT_* names, digest optional, nothing invented when absent', () => {
    const cell = buildStage1Cells({ runId: 'r', n: 1, models: ['anthropic/claude-fable-5-1'], arms: { A: { designMode: 'constrained' } }, canvas: 'md' })[0]!;
    const withReceipt = buildEvalOverrides(cell, {
      bucket: 'bkt',
      mintReceipt: { image: 'r/ggui-agents:ggui-protocol-5a3bc54fe1b0', imageDigest: 'sha256:abc', sourceSha: '5a3bc54fe1b0ddba', promptDigestConstrained: 'c205', promptDigestFree: 'bfca' },
    });
    const env = Object.fromEntries(withReceipt.environment.map((e) => [e.name, e.value]));
    expect(env.MINT_IMAGE).toBe('r/ggui-agents:ggui-protocol-5a3bc54fe1b0');
    expect(env.MINT_IMAGE_DIGEST).toBe('sha256:abc');
    expect(env.MINT_SOURCE_SHA).toBe('5a3bc54fe1b0ddba');
    expect(env.MINT_PROMPT_DIGEST_CONSTRAINED).toBe('c205');
    expect(env.MINT_PROMPT_DIGEST_FREE).toBe('bfca');
    const noDigest = buildEvalOverrides(cell, { bucket: 'bkt', mintReceipt: { image: 'i', sourceSha: 's', promptDigestConstrained: 'c', promptDigestFree: 'f' } });
    expect(noDigest.environment.some((e) => e.name === 'MINT_IMAGE_DIGEST')).toBe(false);
    const without = buildEvalOverrides(cell, { bucket: 'bkt' });
    expect(without.environment.some((e) => e.name.startsWith('MINT_'))).toBe(false);
  });

  it('names the cell prefix and identity for the eval task', () => {
    const cell = buildStage1Cells({ runId: 'r1', n: 1, models: [models[0]!], arms: { A: arms.A }, canvas: 'md' })[0]!;
    const o = buildEvalOverrides(cell, { bucket: 'bkt' });
    const env = Object.fromEntries(o.environment.map((e) => [e.name, e.value]));
    expect(o.containerName).toBe('eval');
    expect(env).toMatchObject({
      CELL_S3_URI: `s3://bkt/exp008/r1/${cell.cellId}/`, CELL_ID: cell.cellId, CELL_RUN_ID: 'r1', CELL_ARM: 'A',
      CELL_MODEL: 'anthropic/claude-fable-5-1', CELL_CONTRACT_REF: 'kanban-board',
    });
  });
});

describe('parseNetworkParameter — the awsvpc config cloud publishes in SSM', () => {
  it('accepts subnets + securityGroups (+ optional assignPublicIp) and is loud on any other shape', () => {
    expect(parseNetworkParameter(JSON.stringify({ subnets: ['subnet-a'], securityGroups: ['sg-a'] }), '/p')).toEqual({
      awsvpcConfiguration: { subnets: ['subnet-a'], securityGroups: ['sg-a'], assignPublicIp: 'ENABLED' },
    });
    expect(parseNetworkParameter(JSON.stringify({ subnets: ['s'], securityGroups: ['g'], assignPublicIp: 'DISABLED' }), '/p').awsvpcConfiguration.assignPublicIp).toBe('DISABLED');
    expect(() => parseNetworkParameter(JSON.stringify({ subnetIds: ['s'], securityGroupIds: ['g'] }), '/p')).toThrow(/subnets/);
    expect(() => parseNetworkParameter(JSON.stringify({ subnets: [], securityGroups: ['g'] }), '/p')).toThrow(/subnets/);
    expect(() => parseNetworkParameter(JSON.stringify({ subnets: ['s'], securityGroups: ['g'], assignPublicIp: 'maybe' }), '/p')).toThrow(/assignPublicIp/);
  });
});
