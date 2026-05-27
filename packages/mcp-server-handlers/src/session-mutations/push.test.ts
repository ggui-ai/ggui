/**
 * `ggui_push` handler tests — MVB-5 three-step handshake.
 *
 * Push input shape: `{handshakeId, decision, props?}`. The generator
 * input (intent / contract / variance) flows from the handshake record.
 *
 * These tests use the OSS in-memory deps to exercise the decision
 * discriminator (`accept` vs `override`), props validation, recoverable
 * errors, and output-shape invariants.
 */
import { describe, expect, it } from 'vitest';
import {
  InMemoryKeyValueStore,
  InMemorySessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import type { DataContract } from '@ggui-ai/protocol';
import { createGguiPushHandler } from './push';
import {
  createGguiHandshakeHandler,
  HandshakeNotFoundError,
} from './handshake';

const APP_ID = 'app-test';
const CTX = { appId: APP_ID, requestId: 'req-1' };
const SESS = 'sess-test';

interface SeedArgs {
  readonly intent?: string;
  readonly contract?: DataContract;
}

/**
 * Mint a handshake record via the production handshake handler.
 * Returns the handshakeId so the test can drive a paired push.
 */
async function seed(
  kvStore: InMemoryKeyValueStore,
  sessionStore: InMemorySessionStore,
  args: SeedArgs = {},
): Promise<{ handshakeId: string; contractHash: string }> {
  await sessionStore.create({ id: SESS, appId: APP_ID });
  const handshake = createGguiHandshakeHandler({ kvStore, sessionStore });
  const out = await handshake.handler(
    {
      sessionId: SESS,
      intent: args.intent ?? 'show weather',
      blueprintDraft: { contract: args.contract ?? {} },
    },
    CTX,
  );
  return { handshakeId: out.handshakeId, contractHash: out.contractHash };
}

describe('createGguiPushHandler — MVB-5', () => {
  describe('input schema', () => {
    it('rejects when handshakeId is absent', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await expect(
        handler.handler({ decision: { kind: 'accept' } }, CTX),
      ).rejects.toThrow();
    });

    it('rejects when decision is absent', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await expect(
        handler.handler({ handshakeId }, CTX),
      ).rejects.toThrow();
    });

    it('rejects when decision kind is override but blueprintDraft is missing', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await expect(
        handler.handler(
          { handshakeId, decision: { kind: 'override' } },
          CTX,
        ),
      ).rejects.toThrow();
    });
  });

  describe('decision: accept', () => {
    it('returns well-shaped output', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      expect(out.sessionId).toBeTruthy();
      expect(out.stackItemId).toBeTruthy();
      expect(out.shortCode).toBeTruthy();
      expect(out.action).toBe('reuse');
      expect(out.handshakeId).toBe(handshakeId);
      expect(out.contractHash).toBeDefined();
    });

    it('handshake is single-use — replay → HandshakeNotFoundError', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      await expect(
        handler.handler(
          { handshakeId, decision: { kind: 'accept' } },
          CTX,
        ),
      ).rejects.toBeInstanceOf(HandshakeNotFoundError);
    });

    it('echoes the suggestion contract hash on the output', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const contract: DataContract = {};
      const { handshakeId, contractHash } = await seed(kvStore, sessionStore, {
        contract,
      });
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      expect(out.contractHash).toBe(contractHash);
    });
  });

  describe('decision: override', () => {
    it('mints fresh blueprintId implicitly + gens against override contract', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const originalContract: DataContract = {};
      const overrideContract: DataContract = {
        propsSpec: {
          properties: { city: { schema: { type: 'string' } } },
        },
      };
      const { handshakeId } = await seed(kvStore, sessionStore, {
        contract: originalContract,
      });
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        {
          handshakeId,
          decision: {
            kind: 'override',
            blueprintDraft: { contract: overrideContract },
          },
          props: { city: 'Berlin' },
        },
        CTX,
      );
      expect(out.contractHash).toBeTruthy();
      // The override contract's hash should appear on the output
      // (not the original draft's hash).
      const { blueprintKey } = await import('@ggui-ai/protocol/blueprint-key');
      expect(out.contractHash).toBe(blueprintKey(overrideContract));
    });
  });

  describe('handshake-not-found', () => {
    it('unknown handshakeId → HandshakeNotFoundError', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await expect(
        handler.handler(
          { handshakeId: 'unknown-id', decision: { kind: 'accept' } },
          CTX,
        ),
      ).rejects.toBeInstanceOf(HandshakeNotFoundError);
    });

    it('cross-tenant handshakeId surfaces as HandshakeNotFoundError', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      await expect(
        handler.handler(
          { handshakeId, decision: { kind: 'accept' } },
          { appId: 'other-tenant', requestId: 'r' },
        ),
      ).rejects.toBeInstanceOf(HandshakeNotFoundError);
    });
  });

  describe('output shape', () => {
    it('emits nextStep when contract has actionSpec', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const contract: DataContract = {
        actionSpec: {
          submit: { label: 'Submit' },
        },
      };
      const { handshakeId } = await seed(kvStore, sessionStore, { contract });
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      expect(out.nextStep).toBeDefined();
      expect(out.nextStep?.tool).toBe('ggui_consume');
    });

    it('omits nextStep on pure-display contracts', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore, {
        contract: {},
      });
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      expect(out.nextStep).toBeUndefined();
    });
  });

  describe('resultMeta — per-push resourceUri', () => {
    // Post-displayMode-unification: every push stamps `_meta.ui.resourceUri`
    // regardless of the app's display-mode hint. There is no longer a
    // canvas-mode branch that omits `_meta` — the wire mechanism is
    // identical inline vs fullscreen; `ui.displayMode` is the only
    // presentation hint that differs (and is only stamped when the app
    // declares a non-default `defaultDisplayMode`).
    it('stamps per-push resourceUri on every push', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      const meta = await handler.resultMeta?.(out, {}, CTX);
      expect(meta).toBeDefined();
      expect((meta as { ui?: { resourceUri?: string } }).ui?.resourceUri)
        .toBeTruthy();
    });
  });

  describe('Integration 4 — canvas lifecycle emit (push_started)', () => {
    it('fires push_started with stackItemId + intent after handshake', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const emits: Array<{
        sessionId: string;
        payload: { kind: string; [k: string]: unknown };
      }> = [];
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
        canvasLifecycle: {
          emit(sessionId, payload) {
            emits.push({ sessionId, payload: payload as never });
          },
        },
      });
      const out = await handler.handler(
        { handshakeId, decision: { kind: 'accept' } },
        CTX,
      );
      const pushStarted = emits.find((e) => e.payload.kind === 'push_started');
      expect(pushStarted).toBeDefined();
      expect(pushStarted?.sessionId).toBe(SESS);
      expect(pushStarted?.payload.stackItemId).toBe(out.stackItemId);
    });

    it('does NOT throw when emitter is absent', async () => {
      const kvStore = new InMemoryKeyValueStore();
      const sessionStore = new InMemorySessionStore();
      const { handshakeId } = await seed(kvStore, sessionStore);
      const handler = createGguiPushHandler({
        sessionStore,
        handshakeStore: kvStore,
        // No canvasLifecycle dep — must no-op cleanly.
      });
      await expect(
        handler.handler({ handshakeId, decision: { kind: 'accept' } }, CTX),
      ).resolves.toBeDefined();
    });
  });
});
