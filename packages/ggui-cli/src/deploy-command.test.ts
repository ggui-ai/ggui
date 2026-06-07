import { describe, it, expect } from 'vitest';
import { planDeploySteps, type DeployState } from './deploy-command.js';

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
