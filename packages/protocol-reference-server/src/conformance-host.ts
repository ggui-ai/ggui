/**
 * `ConformanceHost` adapter — wires the `@ggui-ai/protocol-conformance`
 * setup/teardown directive dispatcher onto this package's
 * `ReferenceServer` instance.
 *
 * Directives split into "implement" and "throw":
 *
 *   Implement:
 *     - create-render             → `renders.create()`
 *     - register-tool             → `tools.register(name, handler)`
 *     - register-actionspec       → `renders.registerActionSpec()`
 *     - register-streamspec       → `renders.registerStreamSpec()`
 *     - server-version-override   → `renders.setVersionOverride()`
 *     - emit-envelope             → `renders.injectFrame()`
 *     - unregister-tool           → `tools.unregister()`
 *
 *   Throw (kit records SKIP, not FAIL):
 *     - seed-channel              — unimplemented
 *     - renderer-url-override     — unimplemented (browser-level)
 *     - ui-initialize-response-override — unimplemented
 *
 * The "throw" set matches the conformance kit's `unmatchable-on-ws`
 * skip expectations — browser-level fault injection that requires a
 * richer host harness. Throwing surfaces "directive not implemented"
 * with the error message as the skip reason.
 *
 * Note: render-termination directive (`close-render`) is intentionally
 * absent — render lifecycle is implicit (created → active → TTL-expired);
 * there is no agent-facing close tool, and no kit directive to invoke.
 */
import type {
  ConformanceHost,
  CreateGguiSessionSetup,
  EmitEnvelopeSetup,
  HostSetupStep,
  HostTeardownStep,
  RegisterActionSpecSetup,
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
 * kit calls `create-render` via `dispatchSetup` before any subscribe,
 * so the render store must be reachable. The caller owns the
 * server lifecycle (`start()` + `stop()`).
 */
export function createReferenceConformanceHost({
  serverInstance,
}: CreateReferenceConformanceHostInput): ConformanceHost {
  return {
    async dispatchSetup(step: HostSetupStep): Promise<void> {
      // Discriminant-narrow via explicit casts — the extensibly-closed
      // `HostUnknownSetupStep` arm (`kind: string & {}`) widens the
      // discriminant and blocks literal-narrowing on the union.
      if (step.kind === 'create-render') {
        const s = step as CreateGguiSessionSetup;
        serverInstance.renders.create(s.renderId, s.appId ?? 'conformance');
        return;
      }
      if (step.kind === 'register-tool') {
        // Fixture JSON authors the field as `toolName`; the kit's
        // runtime narrowing (`run-conformance.ts::narrowSetupStep`)
        // only renames `type → kind` and passes other fields verbatim,
        // so the runtime object carries `toolName` not `name`.
        // Tolerate both for forward-compat with a kit fix.
        const raw = step as unknown as {
          readonly toolName?: string;
          readonly name?: string;
          readonly handler: string;
        };
        const toolName = raw.toolName ?? raw.name;
        if (typeof toolName !== 'string' || toolName.length === 0) {
          throw new Error(
            `register-tool directive missing toolName/name: ${JSON.stringify(step)}`,
          );
        }
        serverInstance.tools.register(toolName, raw.handler);
        return;
      }
      if (step.kind === 'register-actionspec') {
        const s = step as RegisterActionSpecSetup;
        // register-actionspec doesn't carry a renderId in the
        // directive shape — it's scoped to the most-recently-created
        // render, matching the fixture-authoring convention that
        // create-render → register-tool → register-actionspec all
        // land in order on the same render.
        const lastRenderId = serverInstance.renders.lastCreatedRenderId();
        if (lastRenderId === undefined) {
          throw new Error(
            'reference-server: register-actionspec invoked before create-render — no render scope to bind to',
          );
        }
        serverInstance.renders.registerActionSpec(lastRenderId, {
          name: s.name,
          tool: s.tool,
        });
        return;
      }
      if (step.kind === 'register-streamspec') {
        // register-streamspec is the streamSpec analogue of register-
        // actionspec — binds a stream channel to a refresh tool. The
        // kit does not export a `RegisterStreamSpecSetup` type today
        // (the directive is reference-server-specific scaffolding for
        // Slice I refresh-stream support); the runtime shape is
        // narrowed locally, matching the same convention as the
        // pre-existing `register-tool` branch above. Same most-
        // recently-created render scoping as register-actionspec.
        const raw = step as unknown as {
          readonly channel?: string;
          readonly tool?: string;
        };
        if (typeof raw.channel !== 'string' || raw.channel.length === 0) {
          throw new Error(
            `register-streamspec directive missing channel: ${JSON.stringify(step)}`,
          );
        }
        if (typeof raw.tool !== 'string' || raw.tool.length === 0) {
          throw new Error(
            `register-streamspec directive missing tool: ${JSON.stringify(step)}`,
          );
        }
        const lastRenderId = serverInstance.renders.lastCreatedRenderId();
        if (lastRenderId === undefined) {
          throw new Error(
            'reference-server: register-streamspec invoked before create-render — no render scope to bind to',
          );
        }
        serverInstance.renders.registerStreamSpec(lastRenderId, {
          channel: raw.channel,
          tool: raw.tool,
        });
        return;
      }
      if (step.kind === 'emit-envelope') {
        // The directive carries `channel` + `payload` but no
        // renderId — it's scoped to the most-recently-created
        // render, matching the same fixture-authoring convention as
        // register-actionspec / register-streamspec / server-version-
        // override (the kit's `narrowSetupStep` is a flat `type → kind`
        // rename pass-through, so any renderId on the directive JSON
        // would survive, but the canonical EmitEnvelopeSetup shape
        // doesn't declare one).
        //
        // Wire-format wrapping: the directive's `payload: unknown` is
        // the envelope body; the host wraps it in the SPEC §12.2
        // `{type:'stream', payload:{channel, value}}` shape (matching
        // the existing reference-server stream emissions in
        // action-router.ts) before fan-out. Per the kit type docstring,
        // "Host is responsible for wrapping in the wire format
        // (sequence stamp, timestamp, etc.)" — the kit does NOT
        // expect the directive to carry a fully-formed wire frame.
        const s = step as EmitEnvelopeSetup;
        if (typeof s.channel !== 'string' || s.channel.length === 0) {
          throw new Error(
            `emit-envelope directive missing channel: ${JSON.stringify(step)}`,
          );
        }
        const lastRenderId = serverInstance.renders.lastCreatedRenderId();
        if (lastRenderId === undefined) {
          throw new Error(
            'reference-server: emit-envelope invoked before create-render — no render scope to bind to',
          );
        }
        const fanned = serverInstance.renders.injectFrame(lastRenderId, {
          type: 'stream',
          payload: {
            channel: s.channel,
            value: s.payload,
          },
        });
        if (!fanned) {
          // No subscribers attached — the directive's emission is
          // unobservable. Surface for fixture-authoring debuggability
          // (the canonical sequence is create-render → subscribe →
          // emit-envelope; fixtures that swap order silently lose the
          // injection). Not a throw — the directive itself succeeded;
          // the unobservability is a fixture concern.
          // eslint-disable-next-line no-console
          console.warn(
            `[@ggui-ai/protocol-reference-server] emit-envelope on render '${lastRenderId}' channel '${s.channel}' had no subscribers — frame dropped`,
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
      if (step.kind === 'server-version-override') {
        // Fixture JSON authors `advertiseVersion` (matches the
        // semantic — "advertise this version on the wire"); the kit's
        // exported `ServerVersionOverrideSetup` interface uses
        // `version`. Tolerate both for forward-compat with the kit's
        // own type, mirroring the same name-tolerance pattern in
        // register-tool above. The runtime `narrowSetupStep` only
        // renames `type → kind` and passes other fields verbatim, so
        // whichever the fixture authors arrives unchanged.
        const raw = step as unknown as {
          readonly advertiseVersion?: string;
          readonly version?: string;
        };
        const advertise = raw.advertiseVersion ?? raw.version;
        if (typeof advertise !== 'string' || advertise.length === 0) {
          throw new Error(
            `server-version-override directive missing advertiseVersion/version: ${JSON.stringify(step)}`,
          );
        }
        // Same most-recently-created render scope as register-
        // actionspec / register-streamspec — the fixture authoring
        // convention is `create-render` immediately precedes this
        // directive, and the kit's narrowSetupStep doesn't surface a
        // renderId on the directive object even when the fixture
        // JSON includes one (only `type → kind` is renamed; the rest
        // is a flat passthrough, so a `renderId` field WOULD survive
        // — but the canonical ServerVersionOverrideSetup type doesn't
        // declare one, so fixtures may omit it. Falling back to
        // `lastCreatedRenderId()` keeps the host robust to either.
        const lastRenderId = serverInstance.renders.lastCreatedRenderId();
        if (lastRenderId === undefined) {
          throw new Error(
            'reference-server: server-version-override invoked before create-render — no render scope to bind to',
          );
        }
        serverInstance.renders.setVersionOverride(lastRenderId, advertise);
        return;
      }
      // Unknown kind — extensibly-closed. Throw so the kit records
      // SKIP with an honest reason.
      const unknownKind = (step as { kind?: unknown }).kind ?? 'unknown';
      throw new Error(
        `reference server does not implement setup kind '${String(unknownKind)}'`,
      );
    },

    async dispatchTeardown(step: HostTeardownStep): Promise<void> {
      if (step.kind === 'unregister-tool') {
        // Same toolName/name tolerance as register-tool.
        const raw = step as unknown as {
          readonly toolName?: string;
          readonly name?: string;
        };
        const toolName = raw.toolName ?? raw.name;
        if (typeof toolName === 'string' && toolName.length > 0) {
          serverInstance.tools.unregister(toolName);
        }
        return;
      }
      const unknownKind = (step as { kind?: unknown }).kind ?? 'unknown';
      throw new Error(
        `reference server does not implement teardown kind '${String(unknownKind)}'`,
      );
    },
  };
}
