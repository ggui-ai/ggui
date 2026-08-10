/**
 * Unbound durable stores cost a deployment nothing (#430, cost gate).
 *
 * Both durable write paths this issue added — the per-render identity
 * record and the blueprint write-through — take their store as an
 * OPTIONAL dep and are entered unconditionally from the render path.
 * The entire "a deployment that predates the table is unchanged"
 * posture rests on those functions returning before they touch
 * anything, and on their doing so QUIETLY: a deployment that never
 * bound a store is not failing at anything, so an event for it would be
 * noise on every render forever.
 *
 * This is the pin under the whole env-gated wiring chain. Compose and
 * the pod's render tool pin "env absent ⇒ dep absent"; this pins
 * "dep absent ⇒ no round trip, no event". Neither half is worth much
 * alone — together they are the cost gate.
 *
 * Stores here are hostile rather than merely observed: every method
 * throws. A call is then a loud failure with a stack pointing at the
 * caller, instead of a spy count that could read zero for some other
 * reason.
 */
import { describe, expect, it, vi } from 'vitest';
import type {
  CodeStore,
  RenderIdentityRecord,
  RenderIdentityStore,
} from '@ggui-ai/mcp-server-core';
import type { StoredGguiSession } from '@ggui-ai/mcp-server-core';
import type { DataContract } from '@ggui-ai/protocol';
import type { Blueprint as RegistryBlueprint } from './blueprint-registry.js';
import {
  refreshRenderIdentity,
  writeRenderIdentity,
} from './render-identity.js';
import { writeBlueprintDurably } from './blueprint-durability.js';

const SESSION_ID = 'render_cost_gate';
const APP_ID = 'app-1';

/** Any call is a test failure carrying the caller's stack. */
const hostileIdentityStore: RenderIdentityStore = {
  durability: 'ephemeral',
  put: async (_record: RenderIdentityRecord) => {
    throw new Error('identity store was touched with no store bound');
  },
  get: async (_sessionId: string) => {
    throw new Error('identity store was touched with no store bound');
  },
};

const STORED: StoredGguiSession = {
  id: SESSION_ID,
  appId: APP_ID,
  eventSequence: 3,
  createdAt: 1_700_000_000_000,
  lastActivityAt: 1_700_000_001_000,
  expiresAt: 1_700_000_900_000,
  render: {
    type: 'component',
    id: SESSION_ID,
    appId: APP_ID,
    componentCode: 'export default function C(){return null;}',
    eventSequence: 3,
    createdAt: 1_700_000_000_000,
    lastActivityAt: 1_700_000_001_000,
    expiresAt: 1_700_000_900_000,
  },
};

const CONTRACT: DataContract = {
  propsSpec: { properties: { city: { schema: { type: 'string' } } } },
};

const REGISTRY_BLUEPRINT: RegistryBlueprint = {
  id: 'bp_00000000-0000-4000-8000-000000000001',
  kind: 'template',
  contractKey: '0123456789abcdef',
  variantKey: 'default',
  variance: {},
  contract: CONTRACT,
  intent: 'a weather card',
  componentCode: 'export default function C(){return null;}',
  createdAt: '2026-08-01T00:00:00.000Z',
  hitCount: 0,
  source: { kind: 'user' },
};

describe('an unbound render-identity store is free and silent', () => {
  it('writes nothing on the commit-time write-through', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeRenderIdentity(undefined, STORED, {
        blueprintId: null,
        contractKey: '0123456789abcdef',
        variantKey: 'default',
      });
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('reads nothing on the mutation-path refresh', async () => {
    // The refresh READS before it writes, so an unguarded version costs
    // a round trip even on a deployment that could never have a record.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await refreshRenderIdentity(undefined, STORED);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('is the store, not the record shape, that decides — a bound store IS reached', async () => {
    // Non-vacuity for the three above: with a store bound, the same
    // calls do reach it. Without this, a guard that returned on every
    // input would pass all of them.
    // `writeRenderIdentity` catches its own store faults by design, so
    // reaching the store surfaces as the logged failure event rather
    // than a throw. That IS the observation — and the spy goes up
    // first, so the deliberate warn never reaches the suite's stderr.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await expect(
        writeRenderIdentity(hostileIdentityStore, STORED, {
          blueprintId: null,
          contractKey: '0123456789abcdef',
          variantKey: 'default',
        }),
      ).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });
});

describe('an unbound durable blueprint pair is free and silent', () => {
  it('writes nothing when no pair is bound at all', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeBlueprintDurably(undefined, APP_ID, REGISTRY_BLUEPRINT);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('writes nothing when the pair carries only a body store', async () => {
    // The row store is the gate: a body with no row to reference it is
    // pure orphan, so a codeStore-only pair must not upload one.
    const codeStore: CodeStore & { put: ReturnType<typeof vi.fn> } = {
      durability: 'ephemeral',
      hashOf: vi.fn(() => 'deadbeef'),
      put: vi.fn(async () => undefined),
      get: vi.fn(async () => null),
      delete: vi.fn(async () => undefined),
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      await writeBlueprintDurably({ codeStore }, APP_ID, REGISTRY_BLUEPRINT);
      expect(codeStore.put).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
