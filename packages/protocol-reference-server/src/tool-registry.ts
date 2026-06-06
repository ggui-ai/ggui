/**
 * Tool registry — the 4 handler kinds the reference server wires
 * through wired-action dispatch. Names match the `handler` enumeration
 * in `packages/protocol-conformance/src/conformance-host.ts`'s
 * `RegisterToolSetup` so the conformance kit's `register-tool`
 * directive drops through cleanly.
 *
 * The four handler kinds:
 *
 *   - `echo`     — returns `{received: args}`.
 *   - `throw`    — rejects with `Error('tool_threw_for_fixture')`.
 *   - `timeout`  — never resolves; router enforces a 500ms timeout.
 *   - `malformed`— returns `{wrong: 'shape'}` to exercise
 *                  SCHEMA_VIOLATION.
 *
 * `TOOL_NOT_FOUND` is the 5th failure path — exercised by dispatching
 * to an action whose tool is NOT in the registry; no handler needed.
 *
 * Handlers are declarative: they return `{status: 'resolved', value}`
 * or throw. The router consults the return shape against the
 * declared channel schema (minimal — currently only `malformed` is
 * flagged) and maps unsupported cases to `_ggui:contract-error` with
 * the matching ContractErrorCode.
 */

/**
 * One tool's executable behavior. Async so `timeout` can return a
 * never-resolving promise the router bounds with a timer.
 */
export type ToolHandler = (args: unknown) => Promise<unknown>;

export type ToolHandlerKind =
  | 'echo'
  | 'throw'
  | 'timeout'
  | 'malformed'
  | 'malformed-stream'
  | 'list-snapshot'
  | (string & {});

/**
 * Registered tool — the handler + its declared behavior kind so
 * the router can match against fixture expectations.
 */
export interface RegisteredTool {
  readonly name: string;
  readonly kind: ToolHandlerKind;
  readonly handler: ToolHandler;
}

/**
 * Returns a never-resolving promise. The router pairs it with a
 * timer to emit `TOOL_TIMEOUT` contract-error after N ms.
 */
function neverResolve(): Promise<unknown> {
  return new Promise(() => {
    /* deliberate: never settles */
  });
}

/**
 * Build one of the four canonical handlers by kind. Unknown kinds
 * throw — the caller (ConformanceHost adapter or setup-step
 * dispatcher) MUST surface this as an honest "handler not implemented"
 * error so the kit records a SKIP with the error message as reason.
 */
export function buildHandler(kind: ToolHandlerKind): ToolHandler {
  switch (kind) {
    case 'echo':
      return async (args: unknown) => ({ received: args });
    case 'throw':
      return async () => {
        throw new Error('tool_threw_for_fixture');
      };
    case 'timeout':
      return () => neverResolve();
    case 'malformed':
    case 'malformed-stream':
      // Both kinds return a shape that does not match the declared
      // channel schema — router maps to SCHEMA_VIOLATION.
      // `malformed-stream` is the fixture-authored alias used by
      // `stream-schema-violation` in the kit.
      return async () => ({ wrong: 'shape' });
    case 'list-snapshot':
      // Refresh-tool kind: returns a deterministic empty list snapshot
      // (`{ items: [] }`). Models the "list-fresh-state" role of a
      // streamSpec refresh tool (real ggui blueprints' `tasks_list` /
      // `notes_list` etc.). The reference server runs handlers
      // statelessly — the snapshot intentionally does NOT reflect
      // prior `tasks_create` calls, since modeling stateful in-memory
      // stores is out of scope for the smallest conformant impl. The
      // kit's `stream-refresh-success` matcher only asserts the
      // channel-update arrived with the declared shape, not that the
      // payload reflects mutation history.
      return async () => ({ items: [] });
    default:
      throw new Error(
        `reference-server: tool handler kind '${String(kind)}' is not recognized — supported: echo, throw, timeout, malformed, malformed-stream, list-snapshot`,
      );
  }
}

/**
 * In-memory tool registry. Scoped to a GguiSession via the action router
 * (the plan's register-tool directive wires a handler under the
 * GguiSession's tool namespace). No-persistence by design.
 */
export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  register(name: string, kind: ToolHandlerKind): void {
    this.tools.set(name, { name, kind, handler: buildHandler(kind) });
  }

  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  get(name: string): RegisteredTool | undefined {
    return this.tools.get(name);
  }

  has(name: string): boolean {
    return this.tools.has(name);
  }

  /** Name of the first tool registered on this registry, or
   *  `undefined` if none. Used by the action-router as a fallback
   *  when no explicit action→tool binding exists. */
  firstRegistered(): string | undefined {
    const it = this.tools.keys().next();
    return it.done === true ? undefined : it.value;
  }
}
