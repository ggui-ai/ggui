/**
 * Identity-default-helper contract.
 *
 * Pin the per-`Identity.kind` semantics of `defaultAppIdFromIdentity`
 * and `defaultThreadOwnerFromIdentity` so future widening of the
 * `Identity` union (e.g. a fourth caller class) cannot silently fall
 * through to the builder default and erase the tenant id.
 *
 * Two regressions these tests catch by construction:
 *
 *   1. After widening `Identity` with `kind: 'app'`, leaving
 *      `defaultAppIdFromIdentity` as a `kind === 'user'`-only branch
 *      would silently bucket every API-key caller into
 *      `DEFAULT_BUILDER_APP_ID` — every app would see every other
 *      app's blueprints / vectors / sessions. (Caught at C1.)
 *   2. `defaultThreadOwnerFromIdentity` falling through to
 *      `DEFAULT_BUILDER_OWNER_ID` for a `kind: 'app'` caller would let
 *      two apps see each other's persistent threads.
 */
import { describe, expect, it } from 'vitest';
import type { AuthResult } from '@ggui-ai/mcp-server-core';
import {
  DEFAULT_BUILDER_APP_ID,
  defaultAppIdFromIdentity,
} from './auth.js';
import { defaultThreadOwnerFromIdentity } from './thread-transport.js';

const builder: AuthResult = {
  identity: { kind: 'builder' },
  source: 'dev',
};

const userWithWorkspace: AuthResult = {
  identity: {
    kind: 'user',
    userId: 'sub-123',
    workspaceId: 'ws-456',
    roles: ['admin'],
  },
  source: 'cognito',
};

const userNoWorkspace: AuthResult = {
  identity: {
    kind: 'user',
    userId: 'sub-789',
    roles: [],
  },
  source: 'cognito',
};

const app: AuthResult = {
  identity: {
    kind: 'app',
    appId: 'gguiapp-abc',
    apiKeyHash: 'sha256-hex',
  },
  source: 'apikey',
};

describe('defaultAppIdFromIdentity', () => {
  it("returns workspaceId for kind:'user' when present", () => {
    expect(defaultAppIdFromIdentity(userWithWorkspace)).toBe('ws-456');
  });

  it("falls back to userId for kind:'user' without workspaceId", () => {
    expect(defaultAppIdFromIdentity(userNoWorkspace)).toBe('sub-789');
  });

  it("returns appId for kind:'app' (NOT the builder default)", () => {
    expect(defaultAppIdFromIdentity(app)).toBe('gguiapp-abc');
    expect(defaultAppIdFromIdentity(app)).not.toBe(DEFAULT_BUILDER_APP_ID);
  });

  it("returns the builder default for kind:'builder'", () => {
    expect(defaultAppIdFromIdentity(builder)).toBe(DEFAULT_BUILDER_APP_ID);
  });
});

describe('defaultThreadOwnerFromIdentity', () => {
  it("prefers a metadata.pairingId when present (paired viewer)", () => {
    const paired: AuthResult = {
      identity: { kind: 'builder' },
      source: 'pairing',
      metadata: { pairingId: 'pair-xyz' },
    };
    expect(defaultThreadOwnerFromIdentity(paired)).toBe('paired_pair-xyz');
  });

  it("returns user_<workspaceId|userId> for kind:'user'", () => {
    expect(defaultThreadOwnerFromIdentity(userWithWorkspace)).toBe(
      'user_ws-456',
    );
    expect(defaultThreadOwnerFromIdentity(userNoWorkspace)).toBe(
      'user_sub-789',
    );
  });

  it("returns app_<appId> for kind:'app' (apps must NOT pool into the builder bucket)", () => {
    expect(defaultThreadOwnerFromIdentity(app)).toBe('app_gguiapp-abc');
  });

  it("returns the builder default for plain kind:'builder' with no pairing", () => {
    expect(defaultThreadOwnerFromIdentity(builder)).toBe('builder');
  });
});
