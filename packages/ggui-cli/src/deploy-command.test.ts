import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  planDeploySteps,
  resolveDeployMcpUrl,
  upsertEnvLocal,
  readEnvLocalValue,
  type DeployState,
} from './deploy-command.js';

describe('resolveDeployMcpUrl', () => {
  it('uses the connectUrl VERBATIM — the bare per-app endpoint, no /mcp suffix', () => {
    // The per-app cloud pod serves MCP at the bare endpoint; a /mcp suffix 404s.
    expect(resolveDeployMcpUrl('https://ggui-main.mcp.sandbox.ggui.ai/apps/abc123', 'abc123')).toBe(
      'https://ggui-main.mcp.sandbox.ggui.ai/apps/abc123',
    );
    expect(resolveDeployMcpUrl('https://mcp.ggui.ai/apps/xyz', 'xyz')).toBe(
      'https://mcp.ggui.ai/apps/xyz',
    );
  });

  it('falls back to the PRODUCTION bare per-app URL when no connectUrl this session', () => {
    expect(resolveDeployMcpUrl(undefined, 'app_1')).toBe('https://mcp.ggui.ai/apps/app_1');
  });

  it('NEVER appends /mcp (regression: the per-app pod serves MCP at the bare root)', () => {
    expect(resolveDeployMcpUrl('https://mcp.ggui.ai/apps/x', 'x')).not.toMatch(/\/mcp$/);
    expect(resolveDeployMcpUrl(undefined, 'x')).not.toMatch(/\/mcp$/);
  });
});

describe('planDeploySteps', () => {
  it('full first deploy: all three gates missing → login+create-app+mint-key+push+push-config+wire-env', () => {
    const state: DeployState = { authed: false, appId: undefined, hasKey: false };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual([
      'login',
      'create-app',
      'mint-key',
      'push',
      'push-config',
      'wire-env',
    ]);
  });

  it('idempotent re-deploy: authed + appId set + hasKey → push+push-config+wire-env only', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: true };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual(['push', 'push-config', 'wire-env']);
  });

  it('partial: authed + appId set + no key → mint-key+push+push-config+wire-env', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: false };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual(['mint-key', 'push', 'push-config', 'wire-env']);
  });

  it('authed but no appId and no key → create-app+mint-key+push+push-config+wire-env', () => {
    const state: DeployState = { authed: true, appId: undefined, hasKey: false };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual([
      'create-app',
      'mint-key',
      'push',
      'push-config',
      'wire-env',
    ]);
  });

  it('authed + no appId + hasKey → create-app+push+push-config+wire-env (key present, just need app)', () => {
    const state: DeployState = { authed: true, appId: undefined, hasKey: true };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual(['create-app', 'push', 'push-config', 'wire-env']);
  });

  it('not authed + has appId + has key → login+push+push-config+wire-env', () => {
    const state: DeployState = { authed: false, appId: 'app_xyz', hasKey: true };
    const steps = planDeploySteps({ state });
    expect(steps.map((s) => s.kind)).toEqual(['login', 'push', 'push-config', 'wire-env']);
  });

  it('push-config step is always included, after push and before wire-env', () => {
    // Full first deploy: all gates missing
    const fullState: DeployState = { authed: false, appId: undefined, hasKey: false };
    const fullSteps = planDeploySteps({ state: fullState }).map((s) => s.kind);
    expect(fullSteps).toContain('push-config');
    const pushIdx = fullSteps.indexOf('push');
    const pushConfigIdx = fullSteps.indexOf('push-config');
    const wireEnvIdx = fullSteps.indexOf('wire-env');
    expect(pushConfigIdx).toBeGreaterThan(pushIdx);
    expect(pushConfigIdx).toBeLessThan(wireEnvIdx);

    // Idempotent re-deploy: authed + appId + hasKey
    const redeployState: DeployState = { authed: true, appId: 'app_abc123', hasKey: true };
    const redeploySteps = planDeploySteps({ state: redeployState }).map((s) => s.kind);
    expect(redeploySteps).toEqual(['push', 'push-config', 'wire-env']);
  });

  it('push-keys step appears AFTER push-config and BEFORE wire-env when pushKeys=true', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: true };
    const steps = planDeploySteps({ state, pushKeys: true }).map((s) => s.kind);
    expect(steps).toContain('push-keys');
    const pushConfigIdx = steps.indexOf('push-config');
    const pushKeysIdx = steps.indexOf('push-keys');
    const wireEnvIdx = steps.indexOf('wire-env');
    expect(pushKeysIdx).toBeGreaterThan(pushConfigIdx);
    expect(pushKeysIdx).toBeLessThan(wireEnvIdx);
  });

  it('push-keys step is NOT included when pushKeys is false/absent', () => {
    const state: DeployState = { authed: true, appId: 'app_abc123', hasKey: true };
    const steps = planDeploySteps({ state }).map((s) => s.kind);
    expect(steps).not.toContain('push-keys');

    const stepsExplicit = planDeploySteps({ state, pushKeys: false }).map((s) => s.kind);
    expect(stepsExplicit).not.toContain('push-keys');
  });

  it('full first deploy with pushKeys: login+create-app+mint-key+push+push-config+push-keys+wire-env', () => {
    const state: DeployState = { authed: false, appId: undefined, hasKey: false };
    const steps = planDeploySteps({ state, pushKeys: true }).map((s) => s.kind);
    expect(steps).toEqual([
      'login',
      'create-app',
      'mint-key',
      'push',
      'push-config',
      'push-keys',
      'wire-env',
    ]);
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
