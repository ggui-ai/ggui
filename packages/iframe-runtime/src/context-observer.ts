/**
 * Runtime owns Provider tree + useState per slot.
 *
 * **Architecture:**
 *
 * 1. At iframe boot, for each slot declared in the bootstrap's
 *    `contextSlots`, the runtime synthesizes one
 *    `React.createContext([default, () => {}])` and registers it under
 *    `globalThis.__ggui__.contexts[contextName]`. The Context value
 *    type is `readonly [value, setter]` — same shape `useState`
 *    returns — so the wire-package `useGguiContext` hook can read it
 *    via plain `useContext`.
 * 2. The runtime mounts the user's component INSIDE a nested tree of
 *    `<SingleSlotProvider>`s. Each SingleSlotProvider owns the slot's
 *    `useState`, debounces value changes, validates against the slot's
 *    `schema`, and posts `ui/update-model-context` to the parent.
 * 3. The Provider value passed downward is `[value, setValue] as const`
 *    — the user component reads both via
 *    `const [v, setV] = useGguiContext<T>(slotName)` (auto-generated
 *    by the boilerplate, one line per declared slot).
 * 4. The last-emitted value per slot lives in a module-level
 *    `Map<slotName, value>` so the reconnect path can re-emit after a
 *    re-mount.
 *
 * **Why the runtime hoists the Provider tree.** An earlier design had
 * the boilerplate emit `useState` + `<Provider>` wraps INSIDE the user
 * component's return; the runtime mounted observers as SIBLINGS,
 * outside the user component, which meant every observer's
 * `useContext` read the `createContext(default)` argument — never the
 * live Provider value. The fix is to move both useState AND the
 * Provider into the runtime layer; the user component now reads via a
 * plain `useContext`-backed hook (`useGguiContext`).
 *
 * **Idempotency on re-mount.** Context references must stay stable
 * across re-mounts so the LLM's destructured component code keeps
 * working. {@link ensureContext} reuses an existing entry by
 * `contextName` and only creates when absent. The `setter` placeholder
 * stored alongside the default is overwritten at mount time by each
 * SingleSlotProvider's real `setValue`.
 *
 * **JSON safety.** Each post validates the value against the slot's
 * `schema` via {@link validateContextValue}. Mismatches log a dev-only
 * `console.warn` and drop silently in production (per Q4 design lock).
 */
import type { Context, ReactElement, ReactNode } from 'react';
import type {
  ContextSpec,
  JsonSchema,
} from '@ggui-ai/protocol';
import { DEFAULT_CONTEXT_DEBOUNCE_MS } from '@ggui-ai/protocol';
import { validateContextValue } from './validation.js';
import type { GguiContextRegistry } from './globals.js';

/**
 * Wire-shape entry for a single contextSpec slot, mirrored from
 * {@link import('@ggui-ai/protocol/integrations/mcp-apps').McpAppAiGguiRenderMeta.contextSlots}.
 */
export interface ContextSlotInfo {
  readonly name: string;
  readonly contextName: string;
  readonly schema: JsonSchema;
  /** Provider seed value. Always populated by the server — the
   * runtime owns useState per slot, so the seed is load-bearing. */
  readonly default: unknown;
  readonly debounceMs?: number;
}

/**
 * Resolved slot metadata after the runtime has synthesized (or reused)
 * the React Context object. Carried into {@link SingleSlotProvider} so
 * the Provider can reuse the same Context reference across renders.
 */
export interface ResolvedContextSlot {
  readonly name: string;
  readonly contextName: string;
  readonly schema: JsonSchema;
  readonly debounceMs: number;
  readonly default: unknown;
  readonly contextRef: Context<
    readonly [unknown, (next: unknown) => void]
  >;
}

/**
 * Module-level map keyed by `name` (the camelCase slot key, NOT the
 * PascalCase contextName) tracking the most-recently-emitted value
 * per slot. Used by the reconnect re-emission path so a new mount
 * after WS reopen seeds the LLM context with the last-known values.
 *
 * Exported for unit tests.
 */
export const contextSlotLastValues = new Map<string, unknown>();

/**
 * Ensure a React Context is registered for `slot.contextName`. Idempotent —
 * an entry already in the registry is REUSED (the LLM's destructured
 * Context reference must remain stable across re-mounts). Only the
 * absent case calls `react.createContext`.
 *
 * The Context value shape is `readonly [value, setter]` — same as
 * `useState`, so the user-component's `useGguiContext` hook reads it
 * via plain `useContext`. The setter stored at registration time is a
 * no-op placeholder — each {@link SingleSlotProvider} mount overwrites
 * it via the Provider's `value` prop.
 *
 * Returns the resolved slot with the live Context reference attached.
 */
export function ensureContext(
  registry: GguiContextRegistry,
  reactMod: {
    createContext: <T>(defaultValue: T) => Context<T>;
  },
  slot: ContextSlotInfo,
): ResolvedContextSlot {
  // The registry is typed as `Context<unknown>` at the boundary
  // (open-ended — different slots have different value types). When
  // we read OR create, the runtime invariant is that every entry is
  // a `Context<readonly [unknown, (next: unknown) => void]>`.
  const existing = registry[slot.contextName] as
    | Context<readonly [unknown, (next: unknown) => void]>
    | undefined;
  let contextRef: Context<readonly [unknown, (next: unknown) => void]>;
  if (existing !== undefined) {
    contextRef = existing;
  } else {
    contextRef = reactMod.createContext<
      readonly [unknown, (next: unknown) => void]
    >([slot.default, () => {}]);
    contextRef.displayName = slot.contextName;
    registry[slot.contextName] = contextRef as Context<unknown>;
  }
  return {
    name: slot.name,
    contextName: slot.contextName,
    schema: slot.schema,
    debounceMs: slot.debounceMs ?? DEFAULT_CONTEXT_DEBOUNCE_MS,
    default: slot.default,
    contextRef,
  };
}

/**
 * Install React Context objects for every entry in `slots` into
 * `registry`. Returns the resolved slot list so callers can mount one
 * SingleSlotProvider per entry. Idempotent — slots whose `contextName`
 * is already in the registry reuse the existing Context.
 */
export function installContextRegistry(
  registry: GguiContextRegistry,
  reactMod: {
    createContext: <T>(defaultValue: T) => Context<T>;
  },
  slots: ReadonlyArray<ContextSlotInfo>,
): ReadonlyArray<ResolvedContextSlot> {
  const resolved: ResolvedContextSlot[] = [];
  for (const slot of slots) {
    resolved.push(ensureContext(registry, reactMod, slot));
    // Pre-seed the shared snapshot map with each slot's default
    // value at boot. Snapshot posts (REPLACE semantics) need every
    // declared slot present from the very first post; if a Provider's
    // initial useEffect happens before another's, the early post would
    // otherwise omit the un-fired slot and the host would track it as
    // missing. Pre-seeding closes that race.
    contextSlotLastValues.set(slot.name, slot.default);
  }
  return resolved;
}

/**
 * Build a ContextSpec from the resolved slot list. Used internally by
 * the SingleSlotProvider to validate values before posting
 * ({@link validateContextValue} expects a ContextSpec; we hold
 * resolved slots, so re-derive the spec shape on demand).
 */
function specFor(slot: ResolvedContextSlot): ContextSpec {
  return { [slot.name]: { schema: slot.schema } };
}

/**
 * Identity bundle carried alongside every snapshot post. The runtime
 * captures these from the bootstrap envelope at boot and threads
 * them through `createContextStateHost` so each snapshot's two
 * destinations (host + server) carry the same authoritative render
 * binding. Absent on dev / test code paths that don't have a real
 * bootstrap; the server mirror is skipped in that case.
 *
 * Post-render-identity-collapse (2026-05-27): the previous
 * `{sessionId, appId, stackItemId}` tuple collapsed to
 * `{renderId, appId}` — render is the single identity key.
 */
export interface ContextPostIdentity {
  readonly renderId: string;
  readonly appId: string;
}

/**
 * Post a context snapshot to BOTH destinations:
 *   1. `ui/update-model-context` to the parent host (claude.ai et al)
 *      — the existing path; agent's LLM reads these via
 *      `read_widget_context` for in-turn awareness.
 *   2. `tools/call` for `ggui_runtime_sync_context` — the server mirror.
 *      Server stores the snapshot on the active Render; chat-
 *      history rehydrate seeds `contextSlots[i].default` with the
 *      snapshotted values, restoring the user's last-known state.
 *
 * Both posts are postMessage to the parent — fire-and-forget,
 * non-blocking, naturally concurrent (queued back-to-back to the
 * postMessage channel; the host receives them in order without
 * blocking either delivery on the other). No explicit `Promise.all`
 * is needed: postMessage isn't a promise-returning API; both calls
 * return synchronously and the channel handles the ordering. This
 * is the right primitive for a snapshot mirror — neither destination
 * needs to wait for the other to ACK.
 *
 * Snapshot replaces an earlier per-slot delta format
 * (`[ggui:context-slot] {slot,value}`). Empirical: claude.ai's host
 * treats each `ui/update-model-context` post as a REPLACE of the
 * widget's tracked context, not a per-slot merge. Server mirror
 * matches: REPLACE-per-renderId, last-write-wins. Both destinations
 * therefore stay structurally consistent.
 *
 * Server-mirror skipped when `identity` is undefined — dev/test code
 * paths that don't supply a real bootstrap shouldn't pollute the
 * server's store with synthetic ids.
 */
function postContextSnapshot(
  postToParent: (envelope: unknown) => void,
  snapshot: Record<string, unknown>,
  identity?: ContextPostIdentity,
): void {
  // Destination 1: host. Always fires.
  const text = `[ggui:context] ${JSON.stringify(snapshot)}`;
  postToParent({
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'ui/update-model-context',
    params: {
      content: [
        {
          type: 'text',
          text,
        },
      ],
    },
  });
  // Destination 2: server mirror. Skipped when identity is absent
  // (dev / test paths without a real bootstrap). Both destinations
  // are postMessage — the channel queues these back-to-back, no
  // sequential dependency between them.
  if (identity) {
    postToParent({
      jsonrpc: '2.0',
      id: Math.floor(Math.random() * 1e9),
      method: 'tools/call',
      params: {
        name: 'ggui_runtime_sync_context',
        arguments: {
          renderId: identity.renderId,
          appId: identity.appId,
          snapshot,
        },
      },
    });
  }
}

/**
 * Build a snapshot object from the shared `contextSlotLastValues` map.
 * Each post sees the full current state of every slot the runtime is
 * tracking — including slots whose Providers haven't yet fired their
 * initial `useEffect` (those entries come from the boot-time pre-seed
 * in {@link installContextRegistry}).
 */
function buildSnapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [slotName, value] of contextSlotLastValues) {
    out[slotName] = value;
  }
  return out;
}

/**
 * React surface the host factories need. Production callers pass
 * `typeof import('react')` directly; tests pass the same namespace
 * (the real `react` module). Picking specific keys from the React
 * module type lets the factories accept the namespace without
 * hand-rolling structural-compat shims.
 */
export type ReactCoreForHost = Pick<
  typeof import('react'),
  'createElement' | 'Fragment' | 'useState' | 'useEffect' | 'useRef'
>;

/**
 * Build the `<SingleSlotProvider>` React component — owns one slot's
 * useState + observer + Provider wrap. The runtime composes one of
 * these per declared slot (via {@link createContextStateHost}).
 *
 * Built as a factory so the runtime can pass dependencies (`react`,
 * `postToParent`, `consoleWarn`) without re-importing in this module
 * — keeps the file pure and unit-testable.
 *
 * Exported because `__tests__/context-observer.test.ts` mounts it
 * standalone to verify the value→post→Provider cycle.
 */
export function createSingleSlotProvider(deps: {
  readonly react: ReactCoreForHost;
  readonly postToParent: (envelope: unknown) => void;
  readonly consoleWarn?: (...args: unknown[]) => void;
  /** Identity bundle threaded into every snapshot post — server
   *  mirror skipped when undefined. */
  readonly identity?: ContextPostIdentity;
}): (props: {
  readonly slot: ResolvedContextSlot;
  readonly children?: ReactNode;
}) => ReactElement {
  const { react, postToParent, consoleWarn, identity } = deps;
  const SingleSlotProvider = (props: {
    readonly slot: ResolvedContextSlot;
    readonly children?: ReactNode;
  }): ReactElement => {
    const { slot, children } = props;
    // Slot-owned state. Re-mounts re-seed from `slot.default` because
    // a fresh useState begins at the seed; cross-mount state survival
    // is NOT a contextSpec promise (the agent owns durable state via
    // propsSpec / streamSpec — contextSpec is an ephemeral
    // client-side reflection).
    const [value, setValue] = react.useState<unknown>(slot.default);

    // Debounced post-on-change. The timer ref keeps a fluttering
    // value (multiple changes inside the debounce window) coalesced
    // to a single post.
    const timerRef = react.useRef<ReturnType<typeof setTimeout> | null>(
      null,
    );

    react.useEffect(
      () => {
        if (timerRef.current !== null) {
          clearTimeout(timerRef.current);
          timerRef.current = null;
        }

        const post = (): void => {
          // Validate against the slot's schema. Per Q4 design lock:
          // dev `console.warn` + silent drop on mismatch.
          const validation = validateContextValue(
            specFor(slot),
            slot.name,
            value,
          );
          if (!validation.valid) {
            if (consoleWarn !== undefined) {
              consoleWarn(
                `[ggui:context] slot '${slot.name}' value rejected:`,
                validation.violations,
              );
            }
            return;
          }
          // Write to the shared map first, then post the FULL
          // snapshot. Snapshot semantics give the host a complete +
          // internally-consistent state at every post (claude.ai
          // treats `ui/update-model-context` as REPLACE, so deltas
          // wiped the un-mentioned slots).
          contextSlotLastValues.set(slot.name, value);
          postContextSnapshot(postToParent, buildSnapshot(), identity);
        };

        if (slot.debounceMs <= 0) {
          // Immediate path — tests + step / tab switches use this.
          post();
        } else {
          timerRef.current = setTimeout(post, slot.debounceMs);
        }

        return () => {
          if (timerRef.current !== null) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
        };
      },
      // `value` drives. `slot.name`/`slot.debounceMs` are stable across
      // a slot's lifetime; listing them keeps exhaustive-deps quiet.
      [value, slot.name, slot.debounceMs, slot.schema],
    );

    // Provider passes the LIVE `[value, setValue]` tuple — overrides
    // the placeholder seed registered in `ensureContext`. The user
    // component's `useGguiContext` reads this exact tuple.
    return react.createElement(
      slot.contextRef.Provider,
      // The runtime invariant: every Context registered under
      // `globalThis.__ggui__.contexts` is `Context<readonly [unknown,
      // setter]>`. The value passed here matches that shape. We
      // construct a tuple via `as const` semantics inline.
      { value: [value, setValue] as const },
      children,
    );
  };
  return SingleSlotProvider;
}

/**
 * Build the `ContextStateHost` component — composes
 * {@link createSingleSlotProvider} once per declared slot to nest
 * Providers around the user's component.
 *
 * The composed shape is:
 *
 * ```tsx
 * <SingleSlotProvider slot={slots[0]}>
 *   <SingleSlotProvider slot={slots[1]}>
 *     {userComponent}
 *   </SingleSlotProvider>
 * </SingleSlotProvider>
 * ```
 *
 * Outermost Provider = first declared slot. Order doesn't affect
 * `useGguiContext` lookups (each Context is independent), but it's
 * stable for snapshot debugging.
 *
 * When `slots` is empty, the host renders children unchanged (no
 * extra wrapper).
 */
export function createContextStateHost(deps: {
  readonly react: ReactCoreForHost;
  readonly postToParent: (envelope: unknown) => void;
  readonly consoleWarn?: (...args: unknown[]) => void;
  /** Identity bundle for the server-mirror destination. Threaded
   *  unchanged into `createSingleSlotProvider` so every slot's debounced
   *  post carries the same authoritative session binding. */
  readonly identity?: ContextPostIdentity;
}): (props: {
  readonly slots: ReadonlyArray<ResolvedContextSlot>;
  readonly children: ReactNode;
}) => ReactElement {
  const SingleSlotProvider = createSingleSlotProvider(deps);
  const ContextStateHost = (props: {
    readonly slots: ReadonlyArray<ResolvedContextSlot>;
    readonly children: ReactNode;
  }): ReactElement => {
    const { slots, children } = props;
    if (slots.length === 0) {
      // Render children inside a no-op Fragment so the return type is
      // ReactElement uniformly (children is ReactNode).
      return deps.react.createElement(
        deps.react.Fragment,
        null,
        children,
      );
    }
    // Compose right-to-left so slots[0] is the outermost Provider.
    return slots.reduceRight<ReactElement>(
      (inner, slot) =>
        deps.react.createElement(
          SingleSlotProvider,
          { key: slot.contextName, slot },
          inner,
        ),
      // Initial accumulator must be a ReactElement so reduceRight's
      // generic resolves; wrap children in a Fragment.
      deps.react.createElement(deps.react.Fragment, null, children),
    );
  };
  return ContextStateHost;
}

/**
 * Walk {@link contextSlotLastValues} and re-post each entry to the
 * parent, filtered to slot names that the new mount actually
 * declares. Used by the re-mount path — when a fresh boot completes
 * after the previous mount torn down, re-seed the LLM context with
 * the LAST values from the previous mount.
 *
 * Filter behavior. An earlier version walked the whole map without
 * filtering, which leaked stale values across contracts: a re-mount
 * with a different `contextSpec` (different slot names) re-emitted
 * entries the new contract didn't declare. The current signature takes
 * the active slot names; entries whose key is NOT in the set get
 * dropped from the map AND skipped on emit.
 *
 * Pass `undefined` to skip filtering (kept for tests that exercise the
 * bare module). Runtime call sites pass the active slots so the leak
 * path is closed by construction.
 */
export function reemitLastContextValues(
  postToParent: (envelope: unknown) => void,
  activeSlotNames?: ReadonlySet<string>,
  identity?: ContextPostIdentity,
): void {
  if (activeSlotNames !== undefined) {
    // Drain stale keys before re-emitting. Keep the map a faithful
    // reflection of the active mount.
    for (const key of Array.from(contextSlotLastValues.keys())) {
      if (!activeSlotNames.has(key)) {
        contextSlotLastValues.delete(key);
      }
    }
  }
  // Single snapshot post on reattach. An earlier version fired one
  // delta per slot which then got REPLACE-wiped by the next-fired
  // delta on the host side; the host ended up with only the
  // LAST-fired slot. One snapshot delivers all slots atomically.
  if (contextSlotLastValues.size > 0) {
    postContextSnapshot(postToParent, buildSnapshot(), identity);
  }
}
