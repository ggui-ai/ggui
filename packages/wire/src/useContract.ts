// packages/wire/src/useContract.ts
//
// Contract-aware hook factory. Provides typed versions of all wire hooks
// where names are constrained and payloads are auto-inferred from the contract.
//
// Two paths:
//   1. Auto-inferred: pass a defineContract() value → types inferred from JSON Schema
//   2. Manual: pass a ContractTypeMap as generic → types from the manual interface
//
// The contract's `agentTools` catalog declares tools the AGENT
// invokes; component code does NOT call them directly. There is NO
// component hook for invoking agent tools — user gestures fire via
// `useAction(name)`, and the optional `nextStep` field on the action
// entry names the tool the agent SHOULD invoke on its next turn. The
// runtime forwards `nextStep` as event metadata; the agent owns the
// call.

import type { DataContract } from '@ggui-ai/protocol';
import type {
  ContractTypeMap,
  InferActionNames,
  InferActionPayload,
  InferStreamNames,
  InferStreamPayload,
  ActionNames,
  ActionPayload,
  StreamNames,
  StreamPayloadOf,
} from '@ggui-ai/protocol';
import { useAction } from './useAction';
import { useStream, type StreamResult } from './useStream';

// =============================================================================
// Auto-inferred path (from defineContract literal)
// =============================================================================

/** Typed hooks bound to a defineContract() literal. */
export interface InferredContractHooks<T extends DataContract> {
  /** Fire an action to the agent. Name autocompletes, payload type inferred from schema. */
  useAction: <N extends InferActionNames<T>>(name: N) => (data: InferActionPayload<T, N>) => void;
  /** Subscribe to agent stream events. Name autocompletes, payload type inferred from schema. */
  useStream: <N extends InferStreamNames<T>>(name: N) => StreamResult<InferStreamPayload<T, N>>;
}

/** Typed hooks bound to a manual ContractTypeMap. */
export interface ManualContractHooks<C extends ContractTypeMap> {
  useAction: <N extends ActionNames<C>>(name: N) => (data: ActionPayload<C, N>) => void;
  useStream: <N extends StreamNames<C>>(name: N) => StreamResult<StreamPayloadOf<C, N>>;
}

// =============================================================================
// useContract — the factory
// =============================================================================

/**
 * Create contract-aware hooks with full type inference.
 *
 * **Auto-inferred path** — pass a `defineContract()` value:
 * ```typescript
 * const contract = defineContract({ ... } as const);
 * const { useAction, useStream } = useContract(contract);
 * const refresh = useAction('refresh');  // name autocompletes, payload typed
 * ```
 *
 * **Manual type map path** — pass a ContractTypeMap generic:
 * ```typescript
 * const { useAction } = useContract<MyContractTypeMap>();
 * ```
 */
export function useContract<const T extends DataContract>(contract: T): InferredContractHooks<T>;
export function useContract<C extends ContractTypeMap>(): ManualContractHooks<C>;
export function useContract(_contract?: DataContract): {
  useAction: (name: string) => (data: unknown) => void;
  useStream: (name: string) => StreamResult<unknown>;
} {
  // The contract parameter is used only for type inference — it's not needed at runtime.
  // All actual dispatch/subscribe goes through WireContext which is injected by the provider.
  return {
    useAction: (name: string) => useAction(name),
    useStream: (name: string) => useStream(name),
  };
}
