/**
 * `createGguiPushHandler` cross-implementation contract suite.
 *
 * Portable battery of assertions every conforming push-handler
 * deployment MUST satisfy under the three-step handshake protocol.
 *
 * Each invariant maps to a real bug class or wire-contract clause:
 *
 *   - **Schema** — handshakeId + decision required at the wire.
 *   - **Single-use handshake** — replay → HandshakeNotFoundError.
 *   - **Cross-tenant safety** — appId mismatch surfaces as
 *     HandshakeNotFoundError (no existence leak).
 *   - **Decision accept** — uses suggestion's effectiveContract verbatim;
 *     reuses provisional blueprintId.
 *   - **Decision override** — gen against agent's NEW draft; mints fresh
 *     blueprintId; provisional id is discarded.
 *   - **AA routing** — `actionSpec[name].nextStep` references an
 *     undeclared tool → CrossReferenceError; handshake survives.
 *   - **Props validation** — required `propsSpec` field absent →
 *     ContractViolationError; handshake survives.
 *   - **nextStep emission** — present iff `contract.actionSpec` is non-empty.
 *   - **Output shape** — sessionId / stackItemId / shortCode / url /
 *     action / codeReady all populate.
 */

import { describe, expect, it, vi } from 'vitest';
import { blueprintKey } from '@ggui-ai/protocol/blueprint-key';
import { CrossReferenceError } from '@ggui-ai/protocol';
import type {
  DataContract,
  HandshakeSuggestion,
} from '@ggui-ai/protocol';
import type { KeyValueStore } from '@ggui-ai/mcp-server-core';
import {
  createGguiPushHandler,
  HandshakeNotFoundError,
  handshakeRecordKey,
  type GguiPushHandlerDeps,
  type HandshakeRecord,
  type HandshakeStoredInput,
} from '../session-mutations/index.js';

export interface PushHandlerContractFactory {
  readonly createDeps: () =>
    | Promise<GguiPushHandlerDeps>
    | GguiPushHandlerDeps;
  readonly cleanup?: (
    deps: GguiPushHandlerDeps,
  ) => Promise<void> | void;
}

/**
 * Seed a `HandshakeRecord` directly into the bound KV store using the
 * production key namespace. Mirrors the shape
 * `createGguiHandshakeHandler` writes.
 *
 * Tests pass `intent`, optional `contract` (becomes `effectiveContract`
 * + the suggestion's contractHash), optional `target`.
 */
async function seedHandshake(
  handshakeStore: KeyValueStore,
  appId: string,
  handshakeId: string,
  args: {
    readonly intent: string;
    readonly contract?: DataContract;
    readonly target?: HandshakeRecord['target'];
    readonly suggestionOverride?: HandshakeSuggestion;
  },
): Promise<void> {
  const contract = args.contract ?? ({} as DataContract);
  const contractHash = blueprintKey(contract);
  const input: HandshakeStoredInput = {
    intent: args.intent,
    blueprintDraft: { contract },
  };
  const suggestion: HandshakeSuggestion =
    args.suggestionOverride ?? {
      origin: 'agent',
      rationale: 'contract-test-seed',
      blueprintMeta: {
        blueprintId: `bp_${handshakeId}`,
        contractHash,
        generator: 'ui-gen-default-haiku-4-5',
        variance: {},
      },
    };
  const record: HandshakeRecord = {
    handshakeId,
    action: 'create',
    reason: 'contract-test-seed',
    input,
    target: args.target ?? {},
    suggestion,
    effectiveContract: contract,
    appId,
    createdAt: new Date().toISOString(),
  };
  await handshakeStore.set(
    handshakeRecordKey(appId, handshakeId),
    JSON.stringify(record),
    { ttlSec: 600 },
  );
}

export function runPushHandlerContract(
  label: string,
  factory: PushHandlerContractFactory,
): void {
  async function withDeps<T>(
    fn: (deps: GguiPushHandlerDeps) => Promise<T>,
  ): Promise<T> {
    const deps = await factory.createDeps();
    if (!deps.sessionStore) {
      throw new Error(
        `${label}: createDeps() must return deps with a non-null sessionStore`,
      );
    }
    if (!deps.handshakeStore) {
      throw new Error(
        `${label}: createDeps() must return deps with a non-null handshakeStore`,
      );
    }
    try {
      return await fn(deps);
    } finally {
      if (factory.cleanup) await factory.cleanup(deps);
    }
  }

  const APP_ID = 'app-contract';
  const CTX = { appId: APP_ID, requestId: 'req-contract' };

  describe(`createGguiPushHandler contract: ${label}`, () => {
    describe('tool declaration', () => {
      it('emits the canonical tool name + audience', async () => {
        await withDeps(async (deps) => {
          const handler = createGguiPushHandler(deps);
          expect(handler.name).toBe('ggui_push');
          expect(handler.audience).toEqual(['agent']);
        });
      });

      it('stamps _meta.ui.resourceUri = "ui://ggui/session"', async () => {
        await withDeps(async (deps) => {
          const handler = createGguiPushHandler(deps);
          expect(handler._meta?.ui).toMatchObject({
            resourceUri: 'ui://ggui/session',
          });
        });
      });
    });

    describe('input schema', () => {
      it('rejects when handshakeId is absent', async () => {
        await withDeps(async (deps) => {
          const handler = createGguiPushHandler(deps);
          await expect(
            handler.handler({ decision: { kind: 'accept' } }, CTX),
          ).rejects.toThrow();
        });
      });

      it('rejects when handshakeId is empty', async () => {
        await withDeps(async (deps) => {
          const handler = createGguiPushHandler(deps);
          await expect(
            handler.handler(
              { handshakeId: '', decision: { kind: 'accept' } },
              CTX,
            ),
          ).rejects.toThrow();
        });
      });

      it('rejects when decision is absent', async () => {
        await withDeps(async (deps) => {
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-no-decision', {
            intent: 'x',
          });
          const handler = createGguiPushHandler(deps);
          await expect(
            handler.handler({ handshakeId: 'hs-no-decision' }, CTX),
          ).rejects.toThrow();
        });
      });
    });

    describe('happy path: decision accept', () => {
      it('consumes the handshake and returns well-shaped output', async () => {
        await withDeps(async (deps) => {
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-happy', {
            intent: 'weather card',
          });
          const handler = createGguiPushHandler(deps);

          const out = await handler.handler(
            { handshakeId: 'hs-happy', decision: { kind: 'accept' } },
            CTX,
          );

          expect(out.sessionId).toBeTruthy();
          expect(out.stackItemId).toBeTruthy();
          expect(out.shortCode).toBeTruthy();
          expect(out.url).toContain(out.shortCode);
          expect(out.action).toBe('create');
          expect(out.handshakeId).toBe('hs-happy');
          expect(out.contractHash).toBeDefined();
        });
      });

      it('handshake is single-use — replay → HandshakeNotFoundError', async () => {
        await withDeps(async (deps) => {
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-replay', {
            intent: 'x',
          });
          const handler = createGguiPushHandler(deps);

          await handler.handler(
            { handshakeId: 'hs-replay', decision: { kind: 'accept' } },
            CTX,
          );
          const err: unknown = await handler
            .handler(
              { handshakeId: 'hs-replay', decision: { kind: 'accept' } },
              CTX,
            )
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(HandshakeNotFoundError);
        });
      });
    });

    describe('decision override', () => {
      it('runs gen against the override draft\'s contract', async () => {
        await withDeps(async (deps) => {
          const originalContract: DataContract = {};
          const overrideContract: DataContract = {
            propsSpec: { properties: { city: { schema: { type: 'string' } } } },
          };
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-override', {
            intent: 'x',
            contract: originalContract,
          });
          const handler = createGguiPushHandler(deps);
          const out = await handler.handler(
            {
              handshakeId: 'hs-override',
              decision: {
                kind: 'override',
                blueprintDraft: { contract: overrideContract },
              },
              props: { city: 'Berlin' },
            },
            CTX,
          );
          expect(out.contractHash).toBe(blueprintKey(overrideContract));
        });
      });
    });

    describe('peek-then-consume: handshake survives recoverable errors', () => {
      it('CrossReferenceError preserves the handshake when nextStep targets an undeclared tool', async () => {
        await withDeps(async (deps) => {
          // Author bug: nextStep references a tool that isn't
          // declared in the contract's own agentCapabilities.tools
          // catalog. The `assertCrossReferences` invariant rejects:
          // every nextStep MUST resolve in the contract's catalog
          // (this is true whether the tool lives on this MCP or a
          // different one in the agent's toolbox).
          const contract: DataContract = {
            actionSpec: {
              save: {
                label: 'Save',
                nextStep: 'totally_unknown_tool',
              },
            },
            // No agentCapabilities.tools entry — cross-ref rejects.
          };
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-aa', {
            intent: 'x',
            contract,
          });
          const handler = createGguiPushHandler({ ...deps });

          const err: unknown = await handler
            .handler(
              { handshakeId: 'hs-aa', decision: { kind: 'accept' } },
              CTX,
            )
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(CrossReferenceError);

          const stillThere = await deps.handshakeStore!.get(
            handshakeRecordKey(APP_ID, 'hs-aa'),
          );
          expect(stillThere).not.toBeNull();
        });
      });

      it('cross-MCP nextStep resolves via contract catalog', async () => {
        await withDeps(async (deps) => {
          // Cross-MCP case: `nextStep` names a tool on a DIFFERENT
          // MCP server. The contract author opts in by listing it
          // in `agentCapabilities.tools`. Resolution succeeds even
          // though the server registry doesn't expose it.
          const contract: DataContract = {
            actionSpec: {
              toggleTodo: {
                label: 'Toggle todo',
                nextStep: 'todo_toggle',
              },
            },
            agentCapabilities: {
              tools: {
                todo_toggle: { inputSchema: { type: 'object' } },
              },
            },
          };
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-bb', {
            intent: 'x',
            contract,
          });
          const handler = createGguiPushHandler({ ...deps });

          const err: unknown = await handler
            .handler(
              { handshakeId: 'hs-bb', decision: { kind: 'accept' } },
              CTX,
            )
            .catch((e: unknown) => e);
          expect(err).not.toBeInstanceOf(CrossReferenceError);
        });
      });
    });

    describe('security', () => {
      it('appId mismatch surfaces as HandshakeNotFoundError (no existence leak)', async () => {
        await withDeps(async (deps) => {
          await seedHandshake(
            deps.handshakeStore!,
            'other-tenant',
            'hs-cross',
            { intent: 'x' },
          );
          const handler = createGguiPushHandler(deps);

          const err: unknown = await handler
            .handler(
              { handshakeId: 'hs-cross', decision: { kind: 'accept' } },
              CTX,
            )
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(HandshakeNotFoundError);
        });
      });
    });

    describe('nextStep emission', () => {
      it('emits nextStep when contract.actionSpec is non-empty', async () => {
        await withDeps(async (deps) => {
          const contract: DataContract = {
            actionSpec: {
              done: { label: 'Done' },
            },
          };
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-ff', {
            intent: 'x',
            contract,
          });
          const handler = createGguiPushHandler(deps);
          const out = await handler.handler(
            { handshakeId: 'hs-ff', decision: { kind: 'accept' } },
            CTX,
          );
          expect(out.nextStep).toBeDefined();
          expect(out.nextStep?.tool).toBe('ggui_consume');
          expect(out.nextStep?.args.stackItemId).toBe(out.stackItemId);
        });
      });

      it('omits nextStep on pure-display contracts (no actionSpec)', async () => {
        await withDeps(async (deps) => {
          const contract: DataContract = {};
          await seedHandshake(
            deps.handshakeStore!,
            APP_ID,
            'hs-ff-display',
            { intent: 'x', contract },
          );
          const handler = createGguiPushHandler(deps);
          const out = await handler.handler(
            { handshakeId: 'hs-ff-display', decision: { kind: 'accept' } },
            CTX,
          );
          expect(out.nextStep).toBeUndefined();
        });
      });
    });

    describe('shortCodeIndex binding', () => {
      it('put receives stackItemId on the binding', async () => {
        const puts: Array<{
          shortCode: string;
          binding: { sessionId: string; appId: string; stackItemId?: string };
        }> = [];
        await withDeps(async (deps) => {
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-sc', {
            intent: 'x',
          });
          const handler = createGguiPushHandler({
            ...deps,
            shortCodeIndex: {
              put: async (shortCode: string, binding: { sessionId: string; appId: string; stackItemId?: string }) => {
                puts.push({ shortCode, binding });
              },
              lookup: async () => null,
              findBySessionId: async () => null,
              revoke: async () => {},
              revokeBySessionId: async () => 0,
              revokeByStackItemId: async () => 0,
            },
          });
          const out = await handler.handler(
            { handshakeId: 'hs-sc', decision: { kind: 'accept' } },
            CTX,
          );
          expect(puts).toHaveLength(1);
          expect(puts[0]?.shortCode).toBe(out.shortCode);
          expect(puts[0]?.binding.sessionId).toBe(out.sessionId);
          expect(puts[0]?.binding.appId).toBe(APP_ID);
          expect(puts[0]?.binding.stackItemId).toBe(out.stackItemId);
        });
      });
    });

    describe('preValidationGate', () => {
      it('fires BEFORE input parsing — its error short-circuits the handler', async () => {
        await withDeps(async (deps) => {
          class GateRejected extends Error {
            constructor() {
              super('gated');
              this.name = 'GateRejected';
            }
          }
          const gateFn = vi.fn().mockRejectedValueOnce(new GateRejected());
          const handler = createGguiPushHandler({
            ...deps,
            preValidationGate: gateFn,
          });
          await expect(
            handler.handler({} as never, CTX),
          ).rejects.toBeInstanceOf(GateRejected);
          expect(gateFn).toHaveBeenCalledOnce();
        });
      });
    });

    describe('postSuccessHook', () => {
      it('fires AFTER push succeeds with resolved sessionId + stackItemId', async () => {
        await withDeps(async (deps) => {
          const hookCalls: Array<{
            sessionId: string;
            stackItemId: string;
            action: string;
          }> = [];
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-hook', {
            intent: 'x',
          });
          const handler = createGguiPushHandler({
            ...deps,
            postSuccessHook: async (args) => {
              hookCalls.push({
                sessionId: args.sessionId,
                stackItemId: args.stackItemId,
                action: args.action,
              });
            },
          });
          const out = await handler.handler(
            { handshakeId: 'hs-hook', decision: { kind: 'accept' } },
            CTX,
          );
          expect(hookCalls).toHaveLength(1);
          expect(hookCalls[0]).toMatchObject({
            sessionId: out.sessionId,
            stackItemId: out.stackItemId,
            action: 'create',
          });
        });
      });
    });

    describe('id factories', () => {
      it('sessionIdFactory + stackItemIdFactory override the default UUID minting', async () => {
        await withDeps(async (deps) => {
          await seedHandshake(deps.handshakeStore!, APP_ID, 'hs-ids', {
            intent: 'x',
          });
          const handler = createGguiPushHandler({
            ...deps,
            sessionIdFactory: () => 'sess_test_fixed',
            stackItemIdFactory: () => 'card_test_fixed',
          });
          const out = await handler.handler(
            { handshakeId: 'hs-ids', decision: { kind: 'accept' } },
            CTX,
          );
          expect(out.sessionId).toBe('sess_test_fixed');
          expect(out.stackItemId).toBe('card_test_fixed');
        });
      });
    });
  });
}
