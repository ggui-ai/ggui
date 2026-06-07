import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planDeploySteps,
  upsertEnvLocal,
  readEnvLocalValue,
  type DeployState,
} from './deploy-command.js';

describe('planDeploySteps', () => {
  it('full first deploy: all three gates missing → login+create-app+mint-key+push+wire-env', () => {
    const state: DeployState = { authed: false, appId: undefined, hasKey: false };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual([
      'login',
      'create-app',
      'mint-key',
      'push',
      'wire-env',
    ]);
  });

  it('idempotent re-deploy: authed + appId set + hasKey → push+wire-env only', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: true };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual(['push', 'wire-env']);
  });

  it('partial: authed + appId set + no key → mint-key+push+wire-env', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: false };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual(['mint-key', 'push', 'wire-env']);
  });

  it('authed but no appId and no key → create-app+mint-key+push+wire-env', () => {
    const state: DeployState = { authed: true, appId: undefined, hasKey: false };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual([
      'create-app',
      'mint-key',
      'push',
      'wire-env',
    ]);
  });

  it('authed + no appId + hasKey → create-app+push+wire-env (key present, just need app)', () => {
    const state: DeployState = { authed: true, appId: undefined, hasKey: true };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual(['create-app', 'push', 'wire-env']);
  });

  it('not authed + has appId + has key → login+push+wire-env', () => {
    const state: DeployState = { authed: false, appId: 'app_xyz', hasKey: true };
    const steps = planDeploySteps(state);
    expect(steps.map((s) => s.kind)).toEqual(['login', 'push', 'wire-env']);
  });
});

describe('upsertEnvLocal + readEnvLocalValue', () => {
  let dir: string;
  let envPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ggui-deploy-test-'));
    envPath = join(dir, '.env.local');
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('creates the file when absent', () => {
    upsertEnvLocal(envPath, 'GGUI_MCP_URL', 'https://x/mcp');
    expect(readFileSync(envPath, 'utf-8')).toBe('GGUI_MCP_URL=https://x/mcp\n');
  });

  it('appends without clobbering existing keys', () => {
    writeFileSync(envPath, 'ANTHROPIC_API_KEY=sk-ant-abc\n', 'utf-8');
    upsertEnvLocal(envPath, 'GGUI_MCP_BEARER', 'ggui_user_xyz');
    const out = readFileSync(envPath, 'utf-8');
    expect(out).toContain('ANTHROPIC_API_KEY=sk-ant-abc');
    expect(out).toContain('GGUI_MCP_BEARER=ggui_user_xyz');
  });

  it('replaces an existing key in-place, preserving others', () => {
    writeFileSync(
      envPath,
      'ANTHROPIC_API_KEY=sk-ant-abc\nGGUI_MCP_URL=http://localhost:6781/mcp\n',
      'utf-8',
    );
    upsertEnvLocal(envPath, 'GGUI_MCP_URL', 'https://mcp.ggui.ai/apps/app_1/mcp');
    const out = readFileSync(envPath, 'utf-8');
    expect(out).toContain('ANTHROPIC_API_KEY=sk-ant-abc');
    expect(out).toContain('GGUI_MCP_URL=https://mcp.ggui.ai/apps/app_1/mcp');
    expect(out).not.toContain('localhost:6781');
  });

  it('readEnvLocalValue returns undefined for absent file / key / empty value', () => {
    expect(readEnvLocalValue(envPath, 'GGUI_MCP_URL')).toBeUndefined();
    writeFileSync(envPath, 'GGUI_MCP_URL=\nOTHER=val\n', 'utf-8');
    expect(readEnvLocalValue(envPath, 'GGUI_MCP_URL')).toBeUndefined();
    expect(readEnvLocalValue(envPath, 'MISSING')).toBeUndefined();
    expect(readEnvLocalValue(envPath, 'OTHER')).toBe('val');
  });

  it('readEnvLocalValue strips quotes and the export prefix', () => {
    writeFileSync(
      envPath,
      'export GGUI_MCP_BEARER="ggui_user_quoted"\n',
      'utf-8',
    );
    expect(readEnvLocalValue(envPath, 'GGUI_MCP_BEARER')).toBe('ggui_user_quoted');
  });
});
