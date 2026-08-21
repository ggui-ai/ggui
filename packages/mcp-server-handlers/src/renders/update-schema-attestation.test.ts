/**
 * ggui#560 — schema attestation on the mutation legs (pin 6 executed).
 *
 * Every successful `ggui_update` / `ggui_amend` output carries
 * `propsSchemaHash` + `propsSchemaProfile` — the identity of the
 * enforced schema derived from the COMMITTED session's propsSpec (the
 * schema the next mutation will be validated against). No value field:
 * the spec cannot change on these legs (`override.contract` exists
 * only on `ggui_render` and is agent-authored), so the attestation
 * joins the handshake disclosure; a mismatch = the SESSION CONTINUITY
 * obligation broken, observable per-turn.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { JsonObject, PropsSpec } from '@ggui-ai/protocol';
import {
  buildEnforcedPropsSchema,
  classifyPropsSchemaProfile,
  ContractViolationError,
} from '@ggui-ai/protocol';
import { computePropsSchemaHash } from '@ggui-ai/protocol/props-schema-hash';
import type { ComponentGguiSession } from '@ggui-ai/protocol';
import { InMemoryGguiSessionStore } from '@ggui-ai/mcp-server-core/in-memory';
import { createGguiUpdateHandler } from './update.js';
import { createGguiAmendHandler } from './amend.js';

const APP = 'app-attest';
const NOW_MS = Date.parse('2026-08-21T00:00:00.000Z');

const SPEC: PropsSpec = {
  properties: {
    status: {
      schema: { type: 'string', enum: ['open', 'busy', 'tentative'] },
      required: true,
    },
    count: { schema: { type: 'number' } },
  },
};

function expectedHash(spec: PropsSpec | undefined): string {
  return computePropsSchemaHash(
    buildEnforcedPropsSchema(spec ?? { properties: {} }),
  );
}

async function seed(
  store: InMemoryGguiSessionStore,
  opts: { propsSpec?: PropsSpec; props?: JsonObject } = {},
): Promise<string> {
  const sessionId = 'attest-1';
  const render: ComponentGguiSession = {
    id: sessionId,
    appId: APP,
    type: 'component',
    componentCode: 'export default function X(){return null}',
    props: opts.props ?? { count: 0 },
    ...(opts.propsSpec ? { propsSpec: opts.propsSpec } : {}),
    eventSequence: 0,
    createdAt: NOW_MS,
    lastActivityAt: NOW_MS,
    expiresAt: NOW_MS + 60_000,
  };
  await store.commit({ render, appId: APP });
  return sessionId;
}

const ctx = () => ({ appId: APP, requestId: 'r-attest' });

describe('ggui_update output — schema attestation (ggui#560)', () => {
  let store: InMemoryGguiSessionStore;
  beforeEach(() => {
    store = new InMemoryGguiSessionStore();
  });

  it('a real update attests the committed spec: hash + profile ride the output', async () => {
    const handler = createGguiUpdateHandler({ renderStore: store });
    const sessionId = await seed(store, {
      propsSpec: SPEC,
      props: { status: 'open', count: 0 },
    });
    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { status: 'busy', count: 1 } },
      ctx(),
    );
    expect(out.updated).toBe(true);
    expect(out.propsSchemaHash).toBe(expectedHash(SPEC));
    expect(out.propsSchemaHash).toMatch(/^[0-9a-f]{64}$/);
    expect(out.propsSchemaProfile).toBe(
      classifyPropsSchemaProfile(buildEnforcedPropsSchema(SPEC)),
    );
  });

  it('a no-op update still attests (every successful output)', async () => {
    const handler = createGguiUpdateHandler({ renderStore: store });
    const sessionId = await seed(store, {
      propsSpec: SPEC,
      props: { status: 'open', count: 0 },
    });
    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { status: 'open', count: 0 } },
      ctx(),
    );
    expect(out.updated).toBe(false);
    expect(out.propsSchemaHash).toBe(expectedHash(SPEC));
  });

  it('a spec-less session carries NO attestation — the mutation leg enforces nothing there, and attesting the closed wrapper would be false', async () => {
    // The mutation legs' validation no-ops on an absent propsSpec
    // (accepts any patch shape). The closed empty wrapper — the
    // RENDER leg's spec-less artifact — REJECTS every key, so
    // attesting its hash here would claim an enforcement this leg
    // does not perform. Honest absence instead.
    const handler = createGguiUpdateHandler({ renderStore: store });
    const sessionId = await seed(store);
    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { count: 2 } },
      ctx(),
    );
    expect(out.propsSchemaHash).toBeUndefined();
    expect(out.propsSchemaProfile).toBeUndefined();
  });

  it('a mutation-leg contract violation carries the enforced-schema hash (§2.3.2 Obligation 4 — the docs-drift audit found this path dropped it)', async () => {
    const handler = createGguiUpdateHandler({ renderStore: store });
    const sessionId = await seed(store, {
      propsSpec: SPEC,
      props: { status: 'open', count: 0 },
    });
    let caught: unknown;
    try {
      await handler.handler(
        // The live-incident vocabulary miss: out-of-enum member.
        { sessionId, kind: 'replace' as const, props: { status: 'booked', count: 1 } },
        ctx(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ContractViolationError);
    expect((caught as ContractViolationError).propsSchemaHash).toBe(
      expectedHash(SPEC),
    );
  });

  it('ggui_amend mirrors the attestation', async () => {
    const handler = createGguiAmendHandler({ renderStore: store });
    const sessionId = await seed(store, {
      propsSpec: SPEC,
      props: { status: 'open', count: 0 },
    });
    const out = await handler.handler(
      { sessionId, kind: 'replace' as const, props: { status: 'busy', count: 3 } },
      ctx(),
    );
    expect(out.propsSchemaHash).toBe(expectedHash(SPEC));
    expect(out.propsSchemaProfile).toBe(
      classifyPropsSchemaProfile(buildEnforcedPropsSchema(SPEC)),
    );
  });
});
