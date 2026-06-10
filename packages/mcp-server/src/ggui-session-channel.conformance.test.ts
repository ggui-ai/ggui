/**
 * Kit-vs-first-party contract test — runs `@ggui-ai/protocol-conformance`
 * against THIS package's live-channel server
 * (`createGguiSessionChannelServer`), booted in-process on an ephemeral
 * port.
 *
 * ## Dependency edge
 *
 * Implementation → kit, on purpose. The conformance kit is the
 * protocol's authored grading surface; this server is one
 * implementation under test. The kit MUST NOT depend on
 * `@ggui-ai/mcp-server` (a vendor-neutral kit cannot import the vendor),
 * so the cross-check lives here as a devDependency of the
 * implementation.
 *
 * ## What drift this catches
 *
 * Without this test, the kit's fixtures could grade a frame vocabulary
 * the shipping server does not actually speak — every kit release
 * would certify only whatever reference host it was developed against.
 * Pinning the kit's verdict on the first-party server means:
 *
 *   - a kit matcher that drifts off the canonical wire shape (ack /
 *     error / data frames, echoed `requestId`, `payload.sequence`)
 *     fails HERE, against the server real traffic exercises daily;
 *   - a server change that breaks a protocol obligation (action
 *     persistence ack, declared-action rejection, subscribe ack) fails
 *     the same pinned set, with the kit as the neutral arbiter.
 *
 * ## Expected scorecard — pinned EXACTLY
 *
 * Both the pass set and the skip set are asserted as exact sets, not
 * subsets. A fixture silently degrading to a skip AND a skipped
 * fixture silently starting to pass are both regressions this file
 * must surface — a skip set that can grow unnoticed is a false gate.
 *
 * Skips are limited to setup directives this WS surface genuinely
 * cannot honor (see `createFirstPartyConformanceHost`) plus the kit's
 * own Path-B (browser-host) partition. In particular there is NO
 * version-override seam on `GguiSessionChannelOptions` — the server
 * always advertises `PROTOCOL_SCHEMA_VERSION` — and this test does not
 * add a production seam just to drive the `version-mismatch` fixture;
 * that fixture skips honestly instead.
 */
import { createServer, type Server as HttpServer } from 'node:http';
import { runConformance, type ConformanceHost } from '@ggui-ai/protocol-conformance';
import type { ActionSpec, JsonValue } from '@ggui-ai/protocol';
import {
  InMemoryAuthAdapter,
  InMemoryGguiSessionStore,
} from '@ggui-ai/mcp-server-core/in-memory';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createGguiSessionChannelServer,
  type GguiSessionChannelServer,
} from './ggui-session-channel.js';

const silentLogger = {
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  debug: () => undefined,
  child: () => silentLogger,
};

/**
 * App id every render is scoped to. MUST match the `appId` the kit's
 * runner stamps on its subscribe frame — the channel rejects
 * subscribes whose appId differs from the stored render's
 * (`APP_MISMATCH`).
 */
const CONFORMANCE_APP_ID = 'conformance';

/**
 * Fixtures the first-party server passes today. Exact set — see the
 * module docstring for why exactness (not membership) is the
 * assertion.
 *
 *   - `bootstrap-success` / `version-match`: WS subscribe → `ack`
 *     round-trip, no error frame. (`version-match` carries no
 *     version-override setup; the kit grades it as the same
 *     subscribe-ack observation.)
 *   - `action-ack-sequence`: the `create-session` directive installs
 *     `actionSpec: {toggleTask}`; the kit dispatches a canonical
 *     `data:submit` action; `handleInboundAction` validates against
 *     the declared actionSpec, appends to the GguiSession event ledger
 *     via `renderStore.appendEvent`, and acks with the assigned
 *     `payload.sequence` echoing the action's `requestId`.
 *   - `undeclared-action-rejected`: same setup, action name absent
 *     from the declared actionSpec → `assertActionContract` throws and
 *     the server replies `error{payload.code:'CONTRACT_VIOLATION'}`
 *     echoing the `requestId`, appending nothing.
 */
const EXPECTED_PASSING = [
  'action-ack-sequence',
  'bootstrap-success',
  'undeclared-action-rejected',
  'version-match',
];

/**
 * Fixtures that SKIP on the first-party server, pinned name → reason
 * substring. The substring assertion keeps each skip honest (the RIGHT
 * directive refusal / partition seam produced it) without being
 * brittle on full message copy.
 *
 *   - `bootstrap-bundle-fetch-failed` / `bootstrap-meta-missing`:
 *     setup needs `renderer-url-override` /
 *     `ui-initialize-response-override` — browser-host fault injection
 *     a WS channel server has no surface for; the host refuses.
 *   - `version-mismatch`: setup needs `server-version-override`. The
 *     channel exposes no per-render version seam (it always advertises
 *     the compiled-in `PROTOCOL_SCHEMA_VERSION`), and adding one purely
 *     for this test would be a production seam with no production
 *     caller; the host refuses.
 *   - `props-update-roundtrip`: the assertion is on rendered DOM — the
 *     kit's own matcher partitions it as Path-B (`unmatchable-on-ws`).
 */
const EXPECTED_SKIPPED: Readonly<Record<string, string>> = {
  'bootstrap-bundle-fetch-failed': 'renderer-url-override',
  'bootstrap-meta-missing': 'ui-initialize-response-override',
  'props-update-roundtrip': 'Path-B',
  'version-mismatch': 'server-version-override',
};

interface FirstPartyHarness {
  readonly store: InMemoryGguiSessionStore;
  readonly channel: GguiSessionChannelServer;
  readonly httpServer: HttpServer;
  /** Full WS endpoint, e.g. `ws://127.0.0.1:51234/ws`. */
  readonly serverUrl: string;
  readonly close: () => Promise<void>;
}

/**
 * Boot the real first-party WS surface in-process: the same
 * `createGguiSessionChannelServer` + bare `node:http` upgrade wiring
 * that `ggui-session-channel.test.ts` uses, on an ephemeral port.
 * `InMemoryAuthAdapter({devAllowAll: true})` accepts the kit's bearer
 * token on the upgrade request.
 */
async function bootFirstPartyServer(): Promise<FirstPartyHarness> {
  const store = new InMemoryGguiSessionStore();
  const channel = createGguiSessionChannelServer({
    renderStore: store,
    auth: new InMemoryAuthAdapter({ devAllowAll: true }),
    logger: silentLogger,
  });

  const httpServer = createServer();
  httpServer.on('upgrade', (req, socket, head) => {
    channel.handleUpgrade(req, socket, head);
  });
  await new Promise<void>((resolve) => {
    httpServer.listen(0, '127.0.0.1', resolve);
  });
  const addr = httpServer.address();
  if (!addr || typeof addr === 'string') {
    throw new Error('httpServer.address() did not return AddressInfo');
  }

  return {
    store,
    channel,
    httpServer,
    // Explicit path — the kit's runner uses an explicit-path URL
    // verbatim (it only appends `/ws` to bare origins).
    serverUrl: `ws://127.0.0.1:${addr.port}${channel.path}`,
    close: async () => {
      await channel.close();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
    },
  };
}

/**
 * `ConformanceHost` adapter for the first-party channel server.
 *
 * Implement:
 *   - `create-session` → commit a `ComponentGguiSession` to the
 *     channel's `GguiSessionStore` (the same write `ggui_render`
 *     performs), carrying the directive's declared actionSpec as the
 *     render's action contract.
 *   - `emit-envelope` → `channel.sendToGguiSession()` — the server's
 *     outbound fan-out API. The directive carries the envelope body;
 *     the server owns wire wrapping (seq stamp + `{type:'data'}`
 *     frame). Scoped to the most recent `create-session`, matching the
 *     fixture-authoring convention (the directive carries no
 *     sessionId).
 *
 * Refuse (kit records SKIP with the thrown message):
 *   - `renderer-url-override` / `ui-initialize-response-override` —
 *     browser-host bootstrap fault injection; a WS channel server has
 *     no renderer bundle and no `ui/initialize` responder to override.
 *   - `server-version-override` — `GguiSessionChannelOptions` exposes
 *     no version seam; the advertised version is the compiled-in
 *     `PROTOCOL_SCHEMA_VERSION` constant. No production seam is added
 *     for the test.
 */
function createFirstPartyConformanceHost(harness: FirstPartyHarness): ConformanceHost {
  let lastCreatedSessionId: string | undefined;

  return {
    async dispatchSetup(step): Promise<void> {
      switch (step.kind) {
        case 'create-session': {
          const appId = step.appId ?? CONFORMANCE_APP_ID;
          const now = Date.now();
          await harness.store.commit({
            appId,
            render: {
              id: step.sessionId,
              appId,
              type: 'component',
              componentCode: 'export default function ConformanceSurface() { return null; }',
              eventSequence: 0,
              createdAt: now,
              lastActivityAt: now,
              expiresAt: now + 60 * 60 * 1000,
              ...(step.actionSpec !== undefined
                ? { actionSpec: toFirstPartyActionSpec(step.actionSpec) }
                : {}),
            },
          });
          lastCreatedSessionId = step.sessionId;
          return;
        }
        case 'emit-envelope': {
          if (lastCreatedSessionId === undefined) {
            throw new Error(
              'emit-envelope dispatched before any create-session — no render to scope the emission to',
            );
          }
          // `mode: 'replace'` — the directive's payload is a full
          // snapshot body, and the host owns the wire wrapping per the
          // kit's EmitEnvelopeStep contract.
          await harness.channel.sendToGguiSession({
            sessionId: lastCreatedSessionId,
            channel: step.channel,
            mode: 'replace',
            payload: toJsonValue(step.payload, 'emit-envelope payload'),
          });
          return;
        }
        case 'renderer-url-override':
          throw new Error(
            'first-party channel server does not implement renderer-url-override — browser-host bootstrap fault injection; this WS surface serves no renderer bundle',
          );
        case 'ui-initialize-response-override':
          throw new Error(
            'first-party channel server does not implement ui-initialize-response-override — ui/initialize is an MCP Apps host concern, not a live-channel frame',
          );
        case 'server-version-override':
          throw new Error(
            'first-party channel server does not implement server-version-override — GguiSessionChannelOptions exposes no version seam; the server always advertises the compiled-in PROTOCOL_SCHEMA_VERSION',
          );
      }
    },

    async dispatchTeardown(): Promise<void> {
      // The kit defines no teardown vocabulary in this version
      // (renders decay via TTL). Throw so any future-authored
      // directive surfaces as an honest skip, never a silent success.
      throw new Error(
        'first-party channel server does not implement any teardown directive — the kit defines no teardown vocabulary in this version',
      );
    },
  };
}

/**
 * Map the kit's declared actionSpec (name → `ActionSpecEntryDecl`)
 * onto the protocol's `ActionSpec`. The behavioral fixtures exercise
 * name-membership only; `ActionEntry.label` is required by the
 * protocol type, so the action name doubles as its label.
 *
 * `ActionSpecEntryDecl.schema` is authoring-reserved for future
 * payload-validation fixtures. This host does NOT install entry
 * schemas yet — if a fixture starts authoring one, refuse loudly (the
 * fixture skips) rather than silently grading name-membership where
 * the fixture means payload validation.
 */
function toFirstPartyActionSpec(
  decl: Readonly<Record<string, { readonly schema?: unknown }>>,
): ActionSpec {
  const spec: ActionSpec = {};
  for (const [action, entry] of Object.entries(decl)) {
    if (entry.schema !== undefined) {
      throw new Error(
        `first-party conformance host does not install actionSpec entry schemas yet (action '${action}' declares one) — name-membership only`,
      );
    }
    spec[action] = { label: action };
  }
  return spec;
}

/**
 * Validating narrower from the directive's `payload: unknown` to the
 * protocol's `JsonValue`. Fixture payloads are JSON-authored so this
 * always passes for the shipped catalog; a programmatic TestCase
 * carrying a non-JSON value (undefined, function, NaN, …) is rejected
 * loudly instead of being silently coerced.
 */
function toJsonValue(value: unknown, context: string): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`${context} contains a non-finite number — not representable as JSON`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, i) => toJsonValue(item, `${context}[${i}]`));
  }
  if (typeof value === 'object') {
    const out: Record<string, JsonValue> = {};
    for (const [key, entry] of Object.entries(value)) {
      out[key] = toJsonValue(entry, `${context}.${key}`);
    }
    return out;
  }
  throw new Error(`${context} is not a JSON value (got ${typeof value})`);
}

describe('first-party @ggui-ai/mcp-server passes @ggui-ai/protocol-conformance', () => {
  let harness: FirstPartyHarness;

  beforeAll(async () => {
    harness = await bootFirstPartyServer();
  });

  afterAll(async () => {
    await harness.close();
  });

  it('the kit scorecard matches the pinned pass / skip partition exactly', async () => {
    const host = createFirstPartyConformanceHost(harness);
    const result = await runConformance({
      serverUrl: harness.serverUrl,
      auth: { kind: 'bearer', token: 'first-party-conformance' },
      host,
      // Every transport-driven fixture waits out the full observation
      // window — keep it short; the in-memory server's emissions
      // resolve within a few event-loop turns.
      observationTimeoutMs: 1500,
    });

    const diagnostic = [
      '',
      `passed (${result.passed.length}): ${result.passed.join(', ')}`,
      `failed (${result.failed.length}):`,
      ...result.failed.map((f) => `  - ${f.name}: ${f.message}`),
      `skipped (${result.skipped.length}):`,
      ...result.skipped.map((s) => `  - ${s.name}: ${s.reason}`),
    ].join('\n');

    // No failures, ever — a failure is either a kit matcher drifting
    // off the first-party wire shape or a server regression on a
    // protocol obligation. Both are bugs at source, never re-pinned
    // here as "known failures".
    expect(result.failed, diagnostic).toEqual([]);

    // Pass set is EXACT: a fixture leaving it is a regression; a
    // fixture entering it must be pinned deliberately.
    expect([...result.passed].sort(), diagnostic).toEqual(EXPECTED_PASSING);

    // Skip set is EXACT, and every skip carries the reason the pinned
    // directive refusal / Path-B partition produces.
    expect(
      result.skipped.map((s) => s.name).sort(),
      diagnostic,
    ).toEqual(Object.keys(EXPECTED_SKIPPED).sort());
    for (const skip of result.skipped) {
      expect(
        skip.reason,
        `fixture '${skip.name}' skipped for an unexpected reason:\n${diagnostic}`,
      ).toContain(EXPECTED_SKIPPED[skip.name]);
    }
  }, 30_000);
});
