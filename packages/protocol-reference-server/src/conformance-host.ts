/**
 * `ConformanceHost` adapter — wires the `@ggui-ai/protocol-conformance`
 * setup/teardown directive dispatcher onto this package's
 * `ReferenceServer` instance.
 *
 * Directives split into "implement" and "throw":
 *
 *   Implement:
 *     - create-session            → `renders.create()` (+
 *       `renders.declareActionSpec()` when the directive carries one,
 *       mapped onto the protocol's `ActionSpec` — declared entry
 *       schemas included, via `toReferenceActionSpec`)
 *     - server-version-override   → `renders.setVersionOverride()`
 *     - emit-envelope             → wrap the directive's body in the
 *       SPEC §12.2 channel-3 delivery frame `{type:'data', payload:
 *       StreamEnvelope}` → `renders.injectFrame()`
 *
 *   Throw (kit records SKIP, not FAIL):
 *     - renderer-url-override     — unimplemented (browser-level)
 *     - ui-initialize-response-override — unimplemented
 *
 * The "throw" set matches the conformance kit's `unmatchable-on-ws`
 * skip expectations — browser-level fault injection that requires a
 * richer host harness. Throwing surfaces "directive not implemented"
 * with the error message as the skip reason.
 *
 * Beyond directives, the host implements the kit's `readSessionField`
 * introspection seam — `session-state` fixtures (stateful obligations
 * with no wire response, e.g. `host-context-observed-persists`) grade
 * by reading the GguiSession field back after the observation window.
 * Readable fields: `hostContext`. Unknown fields throw with a clear
 * message so the kit records an honest SKIP, never a weakened pass.
 *
 * The kit validates every fixture-authored directive against its
 * closed `SetupStep` vocabulary before dispatch, so this adapter only
 * ever receives shape-valid steps of a known kind — narrowing is by
 * the `kind` discriminant; no defensive re-parsing.
 *
 * Note: render-termination directive (`close-render`) is intentionally
 * absent — render lifecycle is implicit (created → active → TTL-expired);
 * there is no agent-facing close tool, and no kit directive to invoke.
 */
import {
  DEFAULT_STREAM_CHANNEL_MODE,
  jsonSchemaSchema,
  makeStreamEnvelope,
  type ActionSpec,
  type JsonValue,
} from '@ggui-ai/protocol';
import type {
  ConformanceHost,
  HostSetupStep,
} from '@ggui-ai/protocol-conformance';

import type { ReferenceServer } from './server.js';

export interface CreateReferenceConformanceHostInput {
  readonly serverInstance: ReferenceServer;
}

/**
 * Build a `ConformanceHost` bound to the given `ReferenceServer`
 * instance. Pass the return value to `runConformance({host})` to
 * drive the kit against the server.
 *
 * The server MUST be `start()`-ed before the first dispatch — the
 * kit calls `create-session` via `dispatchSetup` before any subscribe,
 * so the GguiSession store must be reachable. The caller owns the
 * server lifecycle (`start()` + `stop()`).
 */
export function createReferenceConformanceHost({
  serverInstance,
}: CreateReferenceConformanceHostInput): ConformanceHost {
  return {
    async dispatchSetup(step: HostSetupStep): Promise<void> {
      if (step.kind === 'create-session') {
        serverInstance.renders.create(step.sessionId, step.appId ?? 'conformance');
        if (step.actionSpec !== undefined) {
          serverInstance.renders.declareActionSpec(
            step.sessionId,
            toReferenceActionSpec(step.actionSpec),
          );
        }
        return;
      }
      if (step.kind === 'server-version-override') {
        serverInstance.renders.setVersionOverride(step.sessionId, step.advertiseVersion);
        return;
      }
      if (step.kind === 'emit-envelope') {
        // The directive carries `channel` + `payload` but no sessionId
        // — it's scoped to the most-recently-created render (the
        // fixture-authoring convention is that `create-session`
        // immediately precedes it).
        if (step.channel.length === 0) {
          throw new Error(
            `emit-envelope directive missing channel: ${JSON.stringify(step)}`,
          );
        }
        // The directive types `payload` as `unknown` (opaque to the
        // runner) but `StreamEnvelope.payload` is `JsonValue`.
        // Fixture-sourced bodies are JSON by construction; direct host
        // embedders could pass anything — validate, never cast.
        const body = step.payload;
        if (!isJsonValue(body)) {
          throw new Error(
            'emit-envelope payload must be a JSON value (string / finite number / boolean / null / array / object)',
          );
        }
        const sessionId = serverInstance.renders.lastCreatedSessionId();
        if (sessionId === undefined) {
          throw new Error(
            'reference-server: emit-envelope invoked before create-session — no render scope to bind to',
          );
        }
        // Wire-format wrapping: the directive's `payload` is the
        // envelope body; the host wraps it in the SPEC §12.2 channel-3
        // delivery frame `{type:'data', payload: StreamEnvelope}`
        // before fan-out. Per the kit directive contract, the host
        // owns the wire framing — sequence stamp + schema-version
        // stamp included:
        //   - `mode`: the server declares no streamSpec, so each
        //     delivery carries the protocol's declared default.
        //   - `seq`: per-render monotonic outbound cursor, assigned at
        //     emission time (mirrors buffer-backed servers that assign
        //     `seq` at append, regardless of who is subscribed).
        //   - `schemaVersion`: the version this server advertises for
        //     THIS render — same per-render-override precedence the
        //     subscribe handler uses.
        const envelope = makeStreamEnvelope({
          sessionId,
          channel: step.channel,
          mode: DEFAULT_STREAM_CHANNEL_MODE,
          payload: body,
          seq: serverInstance.renders.nextStreamSeq(sessionId),
          schemaVersion:
            serverInstance.renders.get(sessionId)?.versionOverride ??
            serverInstance.advertisedVersion,
        });
        const fanned = serverInstance.renders.injectFrame(sessionId, {
          type: 'data',
          payload: envelope,
        });
        if (!fanned) {
          // No subscribers attached — the directive's emission is
          // unobservable. Surface for fixture-authoring debuggability
          // (the canonical sequence is create-session → subscribe →
          // emit-envelope; fixtures that swap order silently lose the
          // injection). Not a throw — the directive itself succeeded;
          // the unobservability is a fixture concern.
          // eslint-disable-next-line no-console
          console.warn(
            `[@ggui-ai/protocol-reference-server] emit-envelope on render '${sessionId}' channel '${step.channel}' had no subscribers — frame dropped`,
          );
        }
        return;
      }
      if (step.kind === 'renderer-url-override') {
        throw new Error(
          'reference server does not implement renderer-url-override — browser-level fault injection, out of scope',
        );
      }
      if (step.kind === 'ui-initialize-response-override') {
        throw new Error(
          'reference server does not implement ui-initialize-response-override — MCP Apps host concern, out of scope',
        );
      }
      return unreachableSetupStep(step);
    },

    async readSessionField(sessionId: string, field: string): Promise<unknown> {
      // Honest-grade contract: return the GguiSession's TRUE
      // post-dispatch state. A render that never received the
      // observation message returns `undefined` here — the kit's
      // deep-equal then FAILS the fixture (a server that drops the
      // message must not pass), while an unknown field throws so the
      // kit records a SKIP ("cannot observe" is not "observed and
      // matched").
      const render = serverInstance.renders.get(sessionId);
      if (render === undefined) {
        throw new Error(
          `reference server has no GguiSession '${sessionId}' — readSessionField cannot introspect a render that was never created`,
        );
      }
      if (field === 'hostContext') {
        return render.hostContext;
      }
      throw new Error(
        `reference server does not expose GguiSession field '${field}' via readSessionField — readable fields: hostContext`,
      );
    },

    async dispatchTeardown(): Promise<void> {
      // The kit's teardown vocabulary is empty (`HostTeardownStep` is
      // `never`) — the runner rejects any fixture-authored teardown
      // directive before dispatch, so this is statically unreachable
      // today. Throw so a future kit version that grows a teardown
      // vocabulary surfaces here as an honest "not implemented"
      // (reporter warning) rather than a silent success.
      throw new Error('reference server does not implement any teardown directive');
    },
  };
}

/**
 * Compile-time exhaustiveness lock: the kit's setup vocabulary is a
 * closed union. When a future kit version adds a directive arm, this
 * call stops compiling — forcing this host to either implement the
 * directive or throw "not implemented" explicitly. Silently ignoring
 * a directive (the fall-through default) is the one behavior the
 * `ConformanceHost` contract forbids.
 */
function unreachableSetupStep(step: never): never {
  throw new Error(
    `reference server received a setup directive outside the kit's closed vocabulary: ${JSON.stringify(step)}`,
  );
}

/**
 * Map the kit's declared actionSpec (name → `ActionSpecEntryDecl`)
 * onto the protocol's `ActionSpec` the server's action router
 * enforces with (`validateActionData`). `ActionEntry.label` is
 * required by the protocol type, so the action name doubles as its
 * label; an entry's declared `schema` installs as the action's
 * payload contract (`ActionEntry.schema`) through the protocol's
 * `jsonSchemaSchema` validating parse. A declared schema the
 * protocol's grammar rejects throws — the kit records the fixture as
 * SKIPPED — rather than silently downgrading the declaration to
 * name-membership.
 */
function toReferenceActionSpec(
  decl: Readonly<Record<string, { readonly schema?: unknown }>>,
): ActionSpec {
  const spec: ActionSpec = {};
  for (const [action, entry] of Object.entries(decl)) {
    if (entry.schema === undefined) {
      spec[action] = { label: action };
      continue;
    }
    const parsed = jsonSchemaSchema.safeParse(entry.schema);
    if (!parsed.success) {
      throw new Error(
        `reference server cannot install the entry schema declared on action '${action}' — not a valid protocol JsonSchema node: ${parsed.error.message}`,
      );
    }
    spec[action] = { label: action, schema: parsed.data };
  }
  return spec;
}

/**
 * Validating narrower: is `value` representable as a protocol
 * `JsonValue`? Rejects functions, symbols, bigints, `undefined`, and
 * non-finite numbers anywhere in the tree. Used to gate the
 * `emit-envelope` directive's opaque body before it's stamped into a
 * `StreamEnvelope`.
 */
function isJsonValue(value: unknown): value is JsonValue {
  if (value === null) return true;
  if (typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (typeof value === 'object') {
    return Object.values(value).every(isJsonValue);
  }
  return false;
}
