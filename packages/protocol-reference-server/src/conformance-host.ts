/**
 * `ConformanceHost` adapter — wires the `@ggui-ai/protocol-conformance`
 * setup/teardown directive dispatcher onto this package's
 * `ReferenceServer` instance.
 *
 * Directives split into "implement" and "throw":
 *
 *   Implement:
 *     - create-session             → `renders.create()` (+
 *       `renders.declareActionSpec()` when the directive carries one)
 *     - server-version-override   → `renders.setVersionOverride()`
 *     - emit-envelope             → `renders.injectFrame()`
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
      // Discriminant-narrow via explicit casts — the extensibly-closed
      // `HostUnknownSetupStep` arm (`kind: string & {}`) widens the
      // discriminant and blocks literal-narrowing on the union.
      if (step.kind === 'create-session') {
        const s = step as CreateGguiSessionSetup;
        serverInstance.renders.create(s.sessionId, s.appId ?? 'conformance');
        if (s.actionSpec !== undefined) {
          serverInstance.renders.declareActionSpec(s.sessionId, s.actionSpec);
        }
        return;
      }
      if (step.kind === 'emit-envelope') {
        // The directive carries `channel` + `payload` but no
        // sessionId — it's scoped to the most-recently-created
        // render, matching the same fixture-authoring convention as
        // server-version-override (the kit's `narrowSetupStep` is a
        // flat `type → kind` rename pass-through, so any sessionId on
        // the directive JSON would survive, but the canonical
        // EmitEnvelopeSetup shape doesn't declare one).
        //
        // Wire-format wrapping: the directive's `payload: unknown` is
        // the envelope body; the host wraps it in the SPEC §12.2
        // `{type:'stream', payload:{channel, value}}` shape before
        // fan-out. Per the kit type docstring, "Host is responsible
        // for wrapping in the wire format (sequence stamp, timestamp,
        // etc.)" — the kit does NOT expect the directive to carry a
        // fully-formed wire frame.
        const s = step as EmitEnvelopeSetup;
        if (typeof s.channel !== 'string' || s.channel.length === 0) {
          throw new Error(
            `emit-envelope directive missing channel: ${JSON.stringify(step)}`,
          );
        }
        const lastSessionId = serverInstance.renders.lastCreatedSessionId();
        if (lastSessionId === undefined) {
          throw new Error(
            'reference-server: emit-envelope invoked before create-session — no render scope to bind to',
          );
        }
        const fanned = serverInstance.renders.injectFrame(lastSessionId, {
          type: 'stream',
          payload: {
            channel: s.channel,
            value: s.payload,
          },
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
            `[@ggui-ai/protocol-reference-server] emit-envelope on render '${lastSessionId}' channel '${s.channel}' had no subscribers — frame dropped`,
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
        // own type. The runtime `narrowSetupStep` only renames
        // `type → kind` and passes other fields verbatim, so
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
        // Same most-recently-created render scope as emit-envelope —
        // the fixture authoring convention is `create-session`
        // immediately precedes this directive, and the canonical
        // ServerVersionOverrideSetup type doesn't declare a sessionId,
        // so fixtures may omit it. Falling back to
        // `lastCreatedSessionId()` keeps the host robust to either.
        const lastSessionId = serverInstance.renders.lastCreatedSessionId();
        if (lastSessionId === undefined) {
          throw new Error(
            'reference-server: server-version-override invoked before create-session — no render scope to bind to',
          );
        }
        serverInstance.renders.setVersionOverride(lastSessionId, advertise);
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
      // No teardown directives are defined in the kit today (renders
      // decay via TTL). Throw so the kit surfaces any future-authored
      // directive as an honest skip rather than a silent success.
      const unknownKind = (step as { kind?: unknown }).kind ?? 'unknown';
      throw new Error(
        `reference server does not implement teardown kind '${String(unknownKind)}'`,
      );
    },
  };
}
