/**
 * Slice 11.5 C10 — Playwright E2E + fixture-kit seed (Phase 3.1 format).
 *
 * Data-driven conformance spec. Every test row is one JSON fixture
 * under `e2e/ggui-oss/tests/fixtures/contract-kit/cases/`. The spec
 * demonstrates that:
 *
 *   1. The C10 fixture format is loadable today
 *      (`loadFixture(name)` returns a shape-valid {@link TestCase}).
 *   2. Fixtures that can drive against today's Phase-2 harness
 *      (`ggui serve` + `playground/` + existing blueprints)
 *      produce a green assertion through the real MCP Apps iframe
 *      host path.
 *   3. Fixtures authored for Phase 3.1's `ConformanceHost` dispatcher
 *      skip cleanly with their `skipReason` reported — proving the
 *      format is forward-loadable without the runner that will
 *      un-skip them.
 *
 * ## Why this spec is the "MCP Apps iframe" spec
 *
 * Every assertion in a RUN-tier fixture exercises the RENDERER
 * CONTRACT through the real postMessage host-bridge path. The
 * console's live session viewer at `/s/<shortCode>` IS an MCP Apps
 * iframe host — it mounts the thin shell, the shell fetches the
 * renderer bundle, the renderer opens WS + subscribes, and
 * contract-error / observability frames the renderer emits are
 * forwarded via postMessage into the host DOM where the
 * `contract-probe` blueprint's `useStream('_ggui:contract-error')`
 * subscription paints them as `data-ggui-contract-error-*`
 * attributes we assert on.
 *
 * The spec is NOT the `<McpAppIframe>` component's unit test — that
 * lives at `packages/ggui-react/src/McpAppIframe/McpAppIframe.test.tsx`.
 * This spec asserts the wire-observable RENDERER outputs a correct
 * MCP Apps host would receive, through a real live-rendering path.
 * Phase 3.1 ships the packaged runner that reuses this fixture
 * catalog against vendor-neutral host implementations.
 *
 * ## Why no custom `harness.html`
 *
 * An earlier iteration of the brief considered a vanilla-JS harness
 * page mounting its own `<iframe>` to mimic `<McpAppIframe>` without
 * React. On review, the console's live session viewer (already
 * served by `ggui serve` at `/s/<shortCode>`) IS that harness for the
 * Phase-2 harness surface — it runs through the same postMessage
 * protocol `<McpAppIframe>` uses. Standing up a second harness would
 * duplicate the host bridge without adding assertion value, and
 * the "no bundler" constraint in the brief explicitly bans the path
 * that would make a standalone React harness easy (importing the
 * built `@ggui-ai/react` bundle via a module script). The console
 * SPA already carries a bundled version — reusing it stays within
 * the brief's intent and keeps the spec path isolated to
 * `mcp-app-iframe.spec.ts` + `fixtures/contract-kit/**`.
 *
 * Phase 3.1's runner CAN stand up its own vanilla harness under the
 * packaged kit's test infrastructure — that's the right layer to
 * host a non-React implementation of the MCP Apps iframe host.
 */
import { test, expect, type Page, type Route } from '@playwright/test';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import {
  attachServeArtifacts,
  DEVTOOL_DIST,
  GGUI_CLI_DIST,
  installNetworkGate,
  spawnGguiServeInCwd,
  type GguiServeHandle,
} from './ggui-serve-harness';
import {
  listFixtures,
  loadFixture,
  type BootstrapFailureBehavior,
  type ContractErrorBehavior,
  type ObservabilityBehavior,
  type TestCase,
} from './fixtures/contract-kit/index.js';
import {
  runConformance,
  type ConformanceHost,
} from '@ggui-ai/protocol-conformance';
import {
  ReferenceServer,
  createReferenceConformanceHost,
} from '@ggui-ai/protocol-reference-server';

const FIXTURE_CWD = resolve(__dirname, 'fixtures/playground');
const TEST_TIMEOUT_MS = 60_000;

// =============================================================================
// Fixture → blueprint mapping
// =============================================================================

/**
 * Which playground blueprint drives a given fixture to the point of
 * assertion. Phase-2 coverage mapping — Phase 3.1 replaces this table
 * with its `ConformanceHost` dispatcher. Fixtures not in this map
 * but with `skipReason === null` are a red flag the loader catches at
 * test-registration time.
 *
 * - `todo-list`      — happy-path wired action (tasks_complete + tasks_list
 *                      refresh). Drives `wired-action-success`.
 * - `contract-probe` — pathological coverage spanning every canonical
 *                      contract-error code:
 *                        - `tasks_broken` throws            → TOOL_THREW
 *                        - `tasks_malformed_list` shape     → SCHEMA_VIOLATION
 *                        - `doesNotExist` (unregistered)    → TOOL_NOT_FOUND
 *                        - `hanging_tool` (sleeps)          → TOOL_TIMEOUT
 *                      Tool names match the conformance fixtures'
 *                      `expectedBehavior.toolName` verbatim — the
 *                      Lane-1 spec asserts those on each row's
 *                      `data-tool` attribute.
 */
const FIXTURE_BLUEPRINTS: Readonly<Record<string, string>> = {
  'wired-action-success': 'todo-list',
  'wired-action-tool-threw': 'contract-probe',
  'wired-action-tool-not-found': 'contract-probe',
  'wired-action-tool-timeout': 'contract-probe',
  'stream-schema-violation': 'contract-probe',
  // `bootstrap-success` asserts the happy-path boot landed — any
  // blueprint satisfies that, since `openLiveSession` already waits
  // for `data-ggui-code-ready="true"` on the first stack entry (which
  // is itself proof the bootstrap-failed envelope did NOT fire).
  // `todo-list` is the cheapest (no synthetic probe traffic).
  'bootstrap-success': 'todo-list',
  // Slice O props_update round-trip — `props-echo` blueprint pairs
  // with the `props-echo-mount.mjs` fixture's `bump_count` tool. The
  // dispatcher (`driveBrowserPropsUpdateFixture`) clicks the bump
  // button and asserts `data-ggui-prop-count` flips from `"0"` to
  // `"1"` within a small budget — evidence the props_update emission
  // seam round-tripped end-to-end (mount → channel-server →
  // iframe-runtime → DOM).
  'props-update-roundtrip': 'props-echo',
};

// =============================================================================
// Helpers
// =============================================================================

/**
 * Navigate the page to `/preview/<blueprintId>`, click "Try live →",
 * and wait for the SPA to land on `/s/<shortCode>` with the blueprint
 * mounted inside the session viewer. Returns the resolved `shortCode`.
 *
 * Post Phase-2-Wave-2 C9.5 the live session viewer wraps the rendered
 * UI in `<McpAppIframe>`; the inner stack-item attributes
 * (`data-ggui-stack-entry`, `data-ggui-code-ready`) live INSIDE the
 * iframe child and are unreachable from the outer page locator. The
 * lifecycle protocol locked in `@ggui-ai/protocol/integrations/mcp-
 * apps` (`McpAppLifecycleMessage`) gives us an outer-DOM signal:
 * `<McpAppIframe>` mirrors the renderer's `code-ready` transition
 * onto `iframe[data-ggui-mcp-app-iframe-lifecycle="code-ready"]`. We
 * pin on that attribute here — it is the protocol-defined ready
 * signal observers (this spec, third-party hosts, accessibility
 * scanners) consume.
 *
 * Mirrors the pattern locked by `runtime-contract.spec.ts::openLiveSession`
 * — intentionally duplicated here so this spec stays self-contained
 * against its path-scope (the helper is not exported from the
 * harness).
 */
async function openLiveSession(
  page: Page,
  baseUrl: string,
  blueprintId: string,
): Promise<string> {
  await page.goto(`${baseUrl}/preview/${blueprintId}`, {
    waitUntil: 'networkidle',
  });
  const tryBtn = page.locator(
    `button[data-ggui-try-live][data-ggui-blueprint-id="${blueprintId}"]`,
  );
  await expect(tryBtn).toBeVisible({ timeout: 15_000 });
  await tryBtn.click();
  // Short code is the URL-safe lowercase alphabet from
  // `generateShortCode()` in `packages/mcp-server-handlers/src/
  // session-mutations/push.ts`. Length is not pinned here — the
  // generator's length has drifted across slices.
  await page.waitForURL(/\/s\/[a-z0-9]+$/, { timeout: 15_000 });
  const match = page.url().match(/\/s\/([a-z0-9]+)$/);
  if (!match) {
    throw new Error(`expected /s/<shortCode> URL, got ${page.url()}`);
  }
  const liveIframe = page
    .locator('iframe[data-ggui-mcp-app-iframe]')
    .first();
  await expect(liveIframe).toHaveAttribute(
    'data-ggui-mcp-app-iframe-lifecycle',
    'code-ready',
    { timeout: 15_000 },
  );
  return match[1]!;
}

/**
 * Lazy accessor for the renderer-iframe Playwright locator, so
 * downstream interactions (click probes, assert on rendered DOM rows)
 * scope inside the iframe. Outer-DOM lifecycle is the protocol
 * surface; inner DOM is host-implementation detail and reachable
 * only via Playwright's `frameLocator` from the spec side.
 */
function rendererFrame(page: Page) {
  return page.frameLocator('iframe[data-ggui-mcp-app-iframe]').first();
}

/**
 * Drive a `wired-action-success` fixture through the todo-list
 * blueprint: click "add" to bootstrap the refresh cycle, wait for
 * seed-1 to render, click the checkbox, assert it flips to 'done'.
 *
 * The assertion evidence is DOM-level (data-task-status), which is
 * downstream of the `wired-tool-invoked` observability signal — the
 * fixture's `expectedBehavior.kind === 'observability-event'`
 * targets the same invocation. If the DOM flips, the wired tool
 * fired + the refresh tool fired + both observability events
 * emitted; the fixture assertion is satisfied by the DOM evidence
 * under the no-mocks rule.
 */
async function driveWiredActionSuccess(page: Page): Promise<void> {
  // The rendered todo-list lives inside the renderer iframe (post C9.5
  // pivot). Outer-DOM lifecycle gating already happened in
  // `openLiveSession`; below we interact with rendered DOM through
  // Playwright's frameLocator, which transparently descends into the
  // iframe's contentDocument.
  const frame = rendererFrame(page);
  const bootstrapInput = frame.getByLabel('new task');
  await bootstrapInput.fill('ck-bootstrap');
  await frame.getByRole('button', { name: 'add' }).click();

  const seed1 = frame.locator('[data-task-id="seed-1"]');
  await expect(seed1).toBeVisible({ timeout: 15_000 });

  // seed-1's initial state depends on whether prior tests in the same
  // serial describe touched it. In this data-driven spec we run
  // wired-action-success once per serve lifetime (FIXTURE_BLUEPRINTS
  // maps exactly one fixture to todo-list), so seed-1 starts 'todo'
  // every time.
  const initialStatus = await seed1.getAttribute('data-task-status');
  const checkbox = seed1.locator('input[type="checkbox"]');
  await checkbox.click();
  const expectedAfter = initialStatus === 'todo' ? 'done' : 'todo';
  await expect(seed1).toHaveAttribute('data-task-status', expectedAfter, {
    timeout: 10_000,
  });
}

/**
 * Drive a contract-error fixture through the contract-probe blueprint:
 * click the probe button matching the fixture's expected code, wait
 * for `data-ggui-contract-error-codes` to contain the expected code,
 * then assert the per-row attributes. Mirrors
 * `runtime-contract.spec.ts::tool-throws` + schema-violation rows.
 */
async function driveContractErrorFixture(
  page: Page,
  fixture: TestCase,
): Promise<void> {
  const behavior = fixture.expectedBehavior as ContractErrorBehavior;
  const probeSelector =
    behavior.code === 'TOOL_THREW'
      ? 'button[data-ggui-probe="break"]'
      : behavior.code === 'TOOL_NOT_FOUND'
        ? 'button[data-ggui-probe="not-found"]'
        : behavior.code === 'TOOL_TIMEOUT'
          ? 'button[data-ggui-probe="timeout"]'
          : 'button[data-ggui-probe="malformed"]'; // SCHEMA_VIOLATION

  // Contract-probe DOM lives inside the renderer iframe; pin all locators
  // through the frameLocator (outer-DOM lifecycle gating already happened
  // in `openLiveSession`).
  const frame = rendererFrame(page);
  const panel = frame.locator('[data-ggui-contract-error-count]').first();
  const button = frame.locator(probeSelector);
  await expect(button).toBeVisible({ timeout: 10_000 });
  await button.click();

  // The reserved-channel replay + append mode means a single
  // `toHaveAttribute` with a tolerant regex matches whether this is
  // the 1st or Nth envelope on the channel. Matches the pattern in
  // `runtime-contract.spec.ts::schema-violation-on-refresh` which
  // must tolerate prior rows.
  await expect(panel).toHaveAttribute(
    'data-ggui-contract-error-codes',
    new RegExp(behavior.code),
    { timeout: 10_000 },
  );

  const row = panel
    .locator(`[data-ggui-contract-error][data-code="${behavior.code}"]`)
    .first();
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute('data-tool', behavior.toolName);
  if (behavior.sourceAction !== undefined) {
    await expect(row).toHaveAttribute('data-source', behavior.sourceAction);
  }

  // Session-alive invariant: the probe button stays interactive after
  // the error row lands. A React error boundary firing would unmount
  // either the button or the panel.
  await expect(button).toBeVisible();
  await expect(button).toBeEnabled();
}

/**
 * Dispatch one fixture against the running `ggui serve`. Returns
 * without asserting when the fixture is skipReason'd — the caller's
 * `test.skip()` gate handles the reporter narrative.
 */
async function runFixture(
  page: Page,
  handle: GguiServeHandle,
  fixture: TestCase,
): Promise<void> {
  const blueprintId = FIXTURE_BLUEPRINTS[fixture.name];
  if (blueprintId === undefined) {
    throw new Error(
      `contract-kit: fixture '${fixture.name}' has skipReason=null but no blueprint mapping — either add it to FIXTURE_BLUEPRINTS, or (if no consumer harness can drive it) author a fixture-level skipReason.`,
    );
  }
  await openLiveSession(page, handle.baseUrl, blueprintId);

  switch (fixture.expectedBehavior.kind) {
    case 'contract-error':
      await driveContractErrorFixture(page, fixture);
      return;
    case 'observability-event': {
      const behavior = fixture.expectedBehavior as ObservabilityBehavior;
      if (behavior.event.kind === 'wired-tool-invoked') {
        await driveWiredActionSuccess(page);
        return;
      }
      throw new Error(
        `contract-kit: observability fixture '${fixture.name}' — kind '${behavior.event.kind}' not yet driveable by Phase 2 C10 harness; add a skipReason.`,
      );
    }
    case 'bootstrap-success':
      // `openLiveSession` above already waited for
      // `data-ggui-code-ready="true"` on the first stack entry, which
      // is the renderer's "ready to accept actions" signal — i.e.,
      // bootstrap succeeded end-to-end (thin shell loaded the bundle,
      // WS handshake completed, `ui/initialize` returned valid
      // `_meta.ggui.bootstrap`). No further assertion needed; the
      // caller already verified the behavior this fixture targets.
      return;
    case 'bootstrap-failure':
    case 'version-mismatch':
    case 'props-update':
    case 'stream-update':
    case 'no-op':
      throw new Error(
        `contract-kit: fixture '${fixture.name}' has skipReason=null but expectedBehavior.kind='${fixture.expectedBehavior.kind}' requires a dispatcher this spec does not implement; mark skipReason.`,
      );
    default:
      throw new Error(
        `contract-kit: fixture '${fixture.name}' has an unknown expectedBehavior.kind='${(fixture.expectedBehavior as { kind: string }).kind}' — author a skipReason.`,
      );
  }
}

// =============================================================================
// Phase 3.1 kit-driven fixtures (Slice G — un-skip path)
// =============================================================================

/**
 * Fixtures driven by `@ggui-ai/protocol-conformance::runConformance()`
 * against an in-process `@ggui-ai/protocol-reference-server` rather
 * than through the `<McpAppIframe>` host path. These are the eight
 * Phase-3.1 fixtures whose JSON `skipReason` was nulled in Slice G —
 * the kit is now responsible for dispatching their setup directives,
 * driving subscribe + input envelope over WS, and matching the
 * resulting frames against `expectedBehavior.kind`.
 *
 * Why a separate path: the existing `runFixture()` switch maps each
 * `expectedBehavior.kind` to a DOM-level driver against the
 * `playground/` blueprints served by `ggui serve`. Those drivers
 * cover only `contract-error`, `observability-event::wired-tool-
 * invoked`, and `bootstrap-success` — every other kind hits the
 * "requires a dispatcher this spec does not implement" throw. The kit
 * already implements those dispatchers (per `match-behavior.ts` +
 * `run-conformance.ts`); routing the eight fixtures through it lifts
 * the gap without re-authoring DOM drivers and without coupling the
 * conformance assertions to `<McpAppIframe>`.
 *
 * Path A (host-agnostic WS) — strong default per the protocol-bar
 * Phase 3.1 design: vendor neutrality is proven by an implementation
 * that is NOT `@ggui-ai/mcp-server`-derived satisfying the kit. The
 * reference server is exactly that implementation.
 *
 * Per-fixture expected runtime outcome (today's v0 reference server):
 *   - `bootstrap-bundle-fetch-failed` — host throws on
 *     `renderer-url-override` → kit SKIP. Browser-host harness (Path
 *     B) needed for true assertion.
 *   - `bootstrap-meta-missing` — host throws on
 *     `ui-initialize-response-override` → kit SKIP. Path B needed.
 *   - `observability-contract-error-emitted` — matcher returns
 *     `unmatchable-on-ws` → kit SKIP. Path B needed (postMessage
 *     capture).
 *   - `observability-wired-tool-invoked` — matcher returns
 *     `unmatchable-on-ws` → kit SKIP. Path B needed.
 *   - `stream-refresh-success` — Slice I added refresh-stream
 *     dispatch to the reference-server router; the fixture declares
 *     `register-streamspec` for channel `tasks` and the kit's matcher
 *     observes the resulting `stream-update` → kit PASS.
 *   - `version-match` — matcher matches the ack as bootstrap-success
 *     → kit PASS.
 *   - `version-mismatch` — host throws on `server-version-override`
 *     → kit SKIP. Two-instance reference-server boot or Path B
 *     needed.
 *
 * Net Lane 1 outcome: `version-match` flips to `✓` (Path A clean
 * pass). The other seven flip from "Phase 2 placeholder skipReason"
 * to "Path B browser-host harness needed" — same skip, honest reason.
 * Follow-up tracking: see comment block on `KIT_DRIVEN_KNOWN_GAPS`.
 */
const KIT_DRIVEN_FIXTURES: ReadonlySet<string> = new Set([
  'observability-contract-error-emitted',
  'observability-wired-tool-invoked',
  'stream-refresh-success',
  'version-match',
  'version-mismatch',
]);

/**
 * Fixtures whose kit-driven outcome is a documented Path-A FAIL the
 * spec absorbs as a `test.skip` with a clearer reason. Each entry is
 * a known scope-limitation in the v0 reference server — when the
 * limitation is closed (e.g., a future Path-B browser-host adapter
 * ships), the entry MUST be removed and the fixture's verdict
 * re-evaluated.
 *
 * Currently empty: Slice I added refresh-stream dispatch via
 * `register-streamspec` (closing the historical
 * `stream-refresh-success` gap), Slice K added the per-session
 * `server-version-override` directive, Slice L grounded the
 * `observability-event` matcher, and Slice M's Path-B Playwright
 * dispatch covers the bootstrap-failure browser-only directives.
 * The dispatcher's `knownGap` branch is retained as the contract for
 * future scope-limited Path-A FAILs to land here rather than crash
 * the suite; do NOT delete the lookup unless the contract pattern
 * itself is being retired.
 */
const KIT_DRIVEN_KNOWN_GAPS: Readonly<Record<string, string>> = {};

/**
 * Kit fixtures that freeze a protocol surface ahead of a reference
 * host/driver that can drive them — the runner activation is a pending
 * kit minor. They have `skipReason: null` (the kit no longer JSON-gates
 * skips, per Slice G) but neither the DOM-level `runFixture()` path nor
 * the pure-WS `runFixtureViaKit()` path can drive them yet, so this
 * spec skips them honestly with a pointer to the freezing rationale.
 *
 *   - `canvas-mode-wire-shapes` (4) — need `set-app-mode` +
 *     `assert-session-field` + `assert-channel-envelope` host
 *     directives (see that sub-module's `index.ts`).
 *
 * (SPEC §7.7.2's gadget obligations are NOT here — they are
 * pure-function conformance, graded by the kit's `schema-conformance`
 * and `registration-conformance` catalogs, not behavioral WS fixtures.)
 *
 * When a driver lands, the fixture's entry MUST move out of this set
 * into `KIT_DRIVEN_FIXTURES` (or a DOM driver) and its verdict be
 * re-evaluated.
 */
const PENDING_DRIVER_FIXTURES: ReadonlySet<string> = new Set([
  'canvas-bootstrap-mutual-exclusion',
  'canvas-lifecycle-channel-emits-handshake-started',
  'canvas-navigated-updates-active-stack-item',
  'host-context-observed-persists',
]);

/**
 * Drive one Phase-3.1 fixture through the kit against the in-process
 * reference server. Returns nothing on success (the test passes), or
 * calls `test.skip()` for kit-skips and known-gap fails.
 *
 * Failure mode in the kit other than known-gap fails: a genuine
 * vendor-neutrality bug — the matcher saw frames it shouldn't have,
 * or the reference server emitted a wire shape that doesn't match
 * `match-behavior.ts`. Surfaced as a Playwright failure with the
 * kit's `ConformanceFailure` message attached.
 *
 * The spec does NOT attach the network gate here — the kit drives
 * pure WS against the in-process reference server and never reaches
 * the Playwright page; the OSS clean-room invariant the gate enforces
 * is asserted on the iframe-host path only.
 */
async function runFixtureViaKit(
  fixture: TestCase,
  refServer: ReferenceServer,
  host: ConformanceHost,
): Promise<void> {
  const result = await runConformance({
    serverUrl: refServer.baseUrl,
    auth: { kind: 'bearer', token: 'reference' },
    host,
    only: [fixture.name],
    // 1500ms matches the reference-server CI test — comfortably above
    // the action-router's 500ms TOOL_TIMEOUT bound and well below the
    // spec's 60s per-test budget.
    observationTimeoutMs: 1500,
  });
  if (result.passed.includes(fixture.name)) return;
  const skip = result.skipped.find((s) => s.name === fixture.name);
  if (skip !== undefined) {
    test.skip(true, `kit (Path A) skipped: ${skip.reason}`);
    return;
  }
  const fail = result.failed.find((f) => f.name === fixture.name);
  if (fail !== undefined) {
    const knownGap = KIT_DRIVEN_KNOWN_GAPS[fixture.name];
    if (knownGap !== undefined) {
      test.skip(true, `kit (Path A) reached a known v0 gap: ${knownGap}`);
      return;
    }
    throw new Error(
      `kit-driven fixture '${fixture.name}' failed unexpectedly — ${fail.message}\n` +
        `expected: ${JSON.stringify(fail.expected)}\n` +
        `received: ${JSON.stringify(fail.received)}`,
    );
  }
  throw new Error(
    `kit run for fixture '${fixture.name}' produced neither pass, fail, nor skip — ` +
      `runConformance({only}) returned: ${JSON.stringify({
        passed: result.passed,
        failed: result.failed.map((f) => f.name),
        skipped: result.skipped.map((s) => s.name),
      })}`,
  );
}

// =============================================================================
// Browser-driven bootstrap-failure fixtures (Slice M)
// =============================================================================

/**
 * Fixtures driven directly through Playwright against the live `ggui
 * serve` + console surface, with `page.route()`-based fault injection
 * on the host's `/ggui/console/session-bootstrap` response. These are
 * the bootstrap-failure fixtures whose expected behavior is observable
 * ONLY on the iframe-host side — the conformance kit's reference
 * server speaks pure WS and has no concept of the host's bootstrap-
 * fetch / `ui/initialize` round-trip, so its `renderer-url-override`
 * + `ui-initialize-response-override` setup directives throw and the
 * kit returns SKIP. Driving the live OSS host with mutated bootstrap
 * payloads is the right shape for these two fixtures: the bootstrap
 * round-trip IS the surface they target.
 *
 * Why a separate set from `KIT_DRIVEN_FIXTURES`: the kit path runs
 * against the in-process reference server and never opens a Playwright
 * page. The browser-driven path uses the same `ggui serve` handle as
 * the iframe host fixtures (`runFixture()`), so it pays the SPA-load +
 * try-live cost — but only twice. Two disjoint sets, dispatched
 * BEFORE the kit set in the registration loop.
 *
 * Per-fixture pattern:
 *   - `bootstrap-bundle-fetch-failed` — intercept the host's bootstrap
 *     response and rewrite `bootstrap.runtimeUrl` to the unreachable
 *     URL the fixture's `renderer-url-override` directive specifies
 *     (`http://127.0.0.1:1/does-not-exist.js`). The `<McpAppIframe>`
 *     forwards the mutated bootstrap to the thin shell via
 *     `ui/initialize`'s `_meta.ggui.bootstrap`; the shell's
 *     `<script src=runtimeUrl>` errors and the shell posts
 *     `{type:'ggui:bootstrap-failed', reason:'BUNDLE_FETCH_FAILED', message}`
 *     to the parent. `<McpAppIframe>::onError` fires, the console's
 *     `<IframeErrorPane>` paints, and the assertion pins on the
 *     `data-ggui-console-iframe-error` container with the fixture's
 *     `messageContains` substring.
 *
 *   - `bootstrap-meta-missing` — same interception point, but rewrite
 *     the bootstrap to OMIT the `runtimeUrl` field (matching the
 *     fixture's `ui-initialize-response-override.toolOutput._meta.ggui`
 *     empty object — the host's bootstrap-fetch surface still requires
 *     a non-null `bootstrap` key, so we strip `runtimeUrl` rather than
 *     return `{}` outright; the shell's parse rejects on the empty
 *     `runtimeUrl` per the same code path the fixture asserts).
 *     Shell posts `{type:'ggui:bootstrap-failed',
 *     reason:'BOOTSTRAP_META_MISSING', message}`.
 *
 * The `data-ggui-console-iframe-error` outer-DOM attribute lives on the
 * SessionViewer's `<IframeErrorPane>`, NOT on the `<McpAppIframe>` itself
 * — `<McpAppIframe>` only mirrors `ggui:lifecycle` envelopes onto its
 * outer attribute, never bootstrap-failure. The error pane's badge
 * carries `err.kind === 'bootstrap'` and the body carries `err.message`,
 * which is the operator-visible `messageContains` surface.
 */
const BROWSER_DRIVEN_FIXTURES: ReadonlySet<string> = new Set([
  'bootstrap-bundle-fetch-failed',
  'bootstrap-meta-missing',
]);

/**
 * Mutate the host's `/ggui/console/session-bootstrap` JSON response
 * via `page.route()` so the bootstrap forwarded onto `ui/initialize`
 * triggers the fixture's expected `bootstrap-failed` reason. Returns
 * an unroute function so each test cleans its own interception.
 *
 * The route is registered INSIDE the test (per fixture) so each spec
 * scopes its own mutation — no cross-test bleed. Playwright matches
 * later-registered routes first, so this handler runs ahead of the
 * `installNetworkGate` catch-all even though the gate is
 * registered earlier in the test body.
 */
async function installBootstrapFailureRoute(
  page: Page,
  fixtureName: string,
): Promise<() => Promise<void>> {
  const pattern = '**/ggui/console/session-bootstrap*';
  const handler = async (route: Route): Promise<void> => {
    const response = await route.fetch();
    const status = response.status();
    if (status !== 200) {
      // Pass non-200s through untouched — the SessionViewer's own
      // `resource-failed` path renders the upstream status, and the
      // fixture's expected message wouldn't land if we masked the
      // failure.
      await route.fulfill({ response });
      return;
    }
    const body = (await response.json()) as {
      readonly bootstrap: Record<string, unknown>;
    };
    const original = body.bootstrap;
    let mutated: Record<string, unknown>;
    if (fixtureName === 'bootstrap-bundle-fetch-failed') {
      // Match the fixture's `renderer-url-override` setup directive:
      // unreachable URL on a port the shell's `<script>` onerror is
      // guaranteed to fire on. Same string the conformance fixture
      // declares verbatim.
      mutated = {
        ...original,
        runtimeUrl: 'http://127.0.0.1:1/does-not-exist.js',
      };
    } else if (fixtureName === 'bootstrap-meta-missing') {
      // Strip `runtimeUrl` so the shell's
      // `if(!b||typeof b.runtimeUrl!=='string'||b.runtimeUrl.length===0)`
      // gate trips. Mirrors the fixture's
      // `ui-initialize-response-override.toolOutput._meta.ggui = {}`
      // intent — the host's bootstrap-fetch surface itself still
      // requires the `bootstrap` key (SessionViewer transitions to
      // `resource-failed` on missing key), so we remove the inner
      // field that the shell's parse actually validates.
      const { runtimeUrl: _ignored, ...withoutRuntimeUrl } = original;
      void _ignored;
      mutated = withoutRuntimeUrl;
    } else {
      // Unknown fixture in the browser-driven set — fail loud rather
      // than passing the response through silently.
      throw new Error(
        `installBootstrapFailureRoute: no mutation rule for fixture '${fixtureName}'`,
      );
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({ bootstrap: mutated }),
    });
  };
  await page.route(pattern, handler);
  return () => page.unroute(pattern, handler);
}

/**
 * Drive a browser-driven bootstrap-failure fixture against the live
 * `ggui serve` SPA. Navigates to `/preview/<blueprint>` → clicks
 * try-live → waits for the SessionViewer to land on `/s/<shortCode>`
 * → asserts the `<IframeErrorPane>` paints with the fixture's
 * expected message substring.
 *
 * Cannot reuse `openLiveSession()` — that helper waits for the
 * iframe's `data-ggui-mcp-app-iframe-lifecycle="code-ready"` mirror,
 * which by definition will NEVER be set on a bootstrap-failed run
 * (the renderer never reaches `code-ready` because the bundle never
 * finishes loading or the meta is unparseable).
 */
async function runBrowserDrivenBootstrapFailureFixture(
  page: Page,
  handle: GguiServeHandle,
  fixture: TestCase,
): Promise<void> {
  // Any blueprint will do — the fixture targets the host's
  // bootstrap-fetch round-trip, which is upstream of blueprint-
  // specific code. `todo-list` is the cheapest playground entry
  // (no synthetic probe traffic) and is already required by the
  // happy-path fixture, so its dist is in the harness's path.
  const blueprintId = 'todo-list';
  const unroute = await installBootstrapFailureRoute(page, fixture.name);
  try {
    await page.goto(`${handle.baseUrl}/preview/${blueprintId}`, {
      waitUntil: 'networkidle',
    });
    const tryBtn = page.locator(
      `button[data-ggui-try-live][data-ggui-blueprint-id="${blueprintId}"]`,
    );
    await expect(tryBtn).toBeVisible({ timeout: 15_000 });
    await tryBtn.click();
    // Short code is the URL-safe lowercase alphabet from
    // `generateShortCode()` in `packages/mcp-server-handlers/src/
    // session-mutations/push.ts`. Length is not pinned here — the
    // generator's exact length has drifted across slices and the
    // bootstrap-failure assertion is alphabet-shape-based, not
    // length-pinned.
    await page.waitForURL(/\/s\/[a-z0-9]+$/, { timeout: 15_000 });

    // The iframe DOES mount (the bootstrap response carries the
    // `bootstrap` key — only the inner shape is malformed); we wait
    // for `<IframeErrorPane>` to render its outer-DOM marker.
    const errorPane = page.locator('[data-ggui-console-iframe-error]');
    await expect(errorPane).toBeVisible({ timeout: 15_000 });

    // ProtocolError.kind is 'bootstrap'; pane renders the kind as a
    // `<StatusBadge>` and the message via `formatProtocolErrorMessage`.
    // Both render INTO the pane, so a substring assertion against the
    // pane's text content covers both signals.
    const paneText = await errorPane.innerText();
    expect(paneText.toLowerCase()).toContain('bootstrap');
    if (fixture.expectedBehavior.kind !== 'bootstrap-failure') {
      throw new Error(
        `runBrowserDrivenBootstrapFailureFixture: fixture '${fixture.name}' kind '${fixture.expectedBehavior.kind}' is not 'bootstrap-failure' — registered in BROWSER_DRIVEN_FIXTURES by mistake?`,
      );
    }
    const behavior = fixture.expectedBehavior as BootstrapFailureBehavior;
    expect(paneText).toContain(behavior.messageContains);
  } finally {
    await unroute();
  }
}

// =============================================================================
// Browser-driven props-update fixtures (Slice O — option B)
// =============================================================================

/**
 * Fixtures driven directly through Playwright against the live `ggui
 * serve` host whose expected behavior is a `props_update` round-trip
 * — observable on the iframe's DOM after a wired-action mount handler
 * fires `ctx.sendPropsUpdate`. The conformance kit's reference server
 * doesn't implement the props_update emission seam (its setup
 * directive `emit-envelope` for channel `_ggui:props` throws), so the
 * fixture skipped under Path A. Driving the live OSS host with a
 * dedicated `props-echo` blueprint + `props-echo-mount.mjs` is the
 * right shape: the bump button's click fires the wired action, the
 * mount calls `ctx.sendPropsUpdate(ctx.pageId, {count: newValue})`,
 * the channel server fans the `props_update` frame, and the
 * iframe-runtime re-renders with the new prop. The DOM stamp on
 * `data-ggui-prop-count` is the wire-observable assertion target.
 *
 * Why a separate set from `BROWSER_DRIVEN_FIXTURES`: that set targets
 * fault injection on the bootstrap response; this set drives the
 * happy path of a runtime emission seam. Two disjoint dispatchers,
 * dispatched BEFORE the kit set in the registration loop. The
 * `installNetworkGate` clean-room invariant still applies — the
 * mount handler runs in-process and the props_update fan-out stays
 * inside the live `ggui serve` server, so no hosted/AWS reach-out can
 * occur on a clean run.
 */
const BROWSER_DRIVEN_PROPS_UPDATE_FIXTURES: ReadonlySet<string> = new Set([
  'props-update-roundtrip',
]);

/**
 * Drive the `props-update-roundtrip` fixture through the live `ggui
 * serve` SPA + `props-echo` blueprint:
 *   1. `openLiveSession` lands on `/s/<shortCode>` with the renderer
 *      iframe in `code-ready` lifecycle.
 *   2. Inside the iframe, assert the cold-start render stamps
 *      `data-ggui-prop-count="0"` (the component's `count ?? 0`
 *      fallback — no `props_update` has fired yet).
 *   3. Click the `[data-testid="bump"]` button. Fires `data:submit`
 *      with `action: 'bump'` → `bump_count` via the wired-action
 *      router → mount handler increments the per-session counter
 *      and calls `ctx.sendPropsUpdate(ctx.pageId, {count: 1})`.
 *   4. Assert `data-ggui-prop-count` flips to `"1"` within a small
 *      budget — evidence the channel server fanned out the props_update
 *      frame and the renderer applied the patch in-place.
 *
 * The fixture's `expectedBehavior.evidence` selector
 * (`[data-ggui-greeting]`) is for the kit-driven path only — the
 * fixture was authored against a hypothetical reference-server-driven
 * `_ggui:props` channel emission. Our blueprint stamps a different
 * attribute (`data-ggui-prop-count`) because it tests the wire-level
 * `props_update` message type round-trip end-to-end, not a reserved-
 * channel emission. Same fixture name, different driver, same wire
 * contract proven (props_update lands on the iframe).
 */
async function runBrowserDrivenPropsUpdateFixture(
  page: Page,
  handle: GguiServeHandle,
  fixture: TestCase,
): Promise<void> {
  if (fixture.name !== 'props-update-roundtrip') {
    throw new Error(
      `runBrowserDrivenPropsUpdateFixture: unknown fixture '${fixture.name}' — registered in BROWSER_DRIVEN_PROPS_UPDATE_FIXTURES by mistake?`,
    );
  }
  await openLiveSession(page, handle.baseUrl, 'props-echo');

  const frame = rendererFrame(page);
  const counter = frame.locator('[data-ggui-prop-count]');
  // Cold-start render: no props_update has fired yet, the component's
  // `count ?? 0` fallback paints `"0"` on the attribute.
  await expect(counter).toHaveAttribute('data-ggui-prop-count', '0', {
    timeout: 10_000,
  });

  // Click the bump button. The wired-action dispatch happens off the
  // main thread (router invocation + sendPropsUpdate fan-out) but
  // resolves within milliseconds — 5 s is generous, mirrors
  // `driveContractErrorFixture`'s 10 s default for the slower
  // contract-error emission.
  const bump = frame.locator('[data-testid="bump"]');
  await expect(bump).toBeVisible({ timeout: 10_000 });
  await bump.click();

  await expect(counter).toHaveAttribute('data-ggui-prop-count', '1', {
    timeout: 5_000,
  });

  // Session-alive invariant: the bump button stays interactive after
  // the props_update lands. A renderer-side error or a React error
  // boundary firing would unmount either the button or the counter
  // (mirrors the contract-probe assertion shape).
  await expect(bump).toBeVisible();
  await expect(bump).toBeEnabled();
}

// =============================================================================
// Spec
// =============================================================================

test.describe.serial('Slice 11.5 C10 — MCP Apps iframe conformance fixtures', () => {
  let handle: GguiServeHandle | null = null;
  let refServer: ReferenceServer | null = null;
  let refHost: ConformanceHost | null = null;

  test.beforeAll(async () => {
    if (!existsSync(GGUI_CLI_DIST)) {
      test.skip(
        true,
        `@ggui-ai/cli dist missing at ${GGUI_CLI_DIST}. Run \`pnpm --filter @ggui-ai/cli build\` first.`,
      );
      return;
    }
    if (!existsSync(DEVTOOL_DIST)) {
      test.skip(
        true,
        `@ggui-ai/console dist missing at ${DEVTOOL_DIST}. Run \`pnpm --filter @ggui-ai/console build\` first.`,
      );
      return;
    }
    // F4 schema-compat mode: 'warn' (not 'reject'). The `contract-probe`
    // blueprint declares an intentional schema mismatch for exercising
    // runtime SCHEMA_VIOLATION + TOOL_THREW envelopes — default
    // `'reject'` blocks try-live before the runtime error path fires.
    // See runtime-contract.spec.ts for the full rationale.
    process.env['GGUI_SCHEMA_COMPAT_MODE'] = 'warn';
    // Wired-tool timeout override. Default in
    // `session-channel.ts::DEFAULT_WIRED_TOOL_TIMEOUT_MS` is 30 s —
    // dropping to 1500 ms keeps the TOOL_TIMEOUT fixture's per-test
    // budget short. The companion `hanging_tool` handler in
    // `tasks-mount.mjs` sleeps 30 s, so it is comfortably above any
    // value chosen here. Threaded into spawned `ggui serve` via
    // `forwardEnv` (the harness's `GGUI_*` ban is whitelisted per name).
    process.env['GGUI_WIRED_TIMEOUT_MS'] = '1500';
    handle = await spawnGguiServeInCwd({
      cwd: FIXTURE_CWD,
      forwardEnv: ['GGUI_SCHEMA_COMPAT_MODE', 'GGUI_WIRED_TIMEOUT_MS'],
    });

    // Phase-3.1 reference server for kit-driven fixtures (Slice G).
    // Ephemeral port; lives for the describe's lifetime alongside the
    // `ggui serve` handle. The two servers are independent — kit
    // fixtures never touch `ggui serve`, iframe fixtures never touch
    // the reference server. See `KIT_DRIVEN_FIXTURES` block above for
    // the routing contract.
    refServer = new ReferenceServer({ port: 0 });
    await refServer.start();
    refHost = createReferenceConformanceHost({ serverInstance: refServer });
  });

  test.afterAll(async () => {
    if (handle) await handle.close();
    if (refServer) await refServer.stop();
  });

  test.afterEach(async () => {
    if (handle) await attachServeArtifacts(handle);
  });

  // Data-driven registration — one `test(…)` per fixture file. The
  // sorted order matches the `listFixtures()` return so reporter
  // output is deterministic across filesystems.
  const fixtureNames = listFixtures();
  if (fixtureNames.length === 0) {
    test('contract-kit fixture catalog is non-empty', () => {
      throw new Error(
        'contract-kit: no fixtures found under ./fixtures/contract-kit/cases/. The spec registers one test per fixture; an empty catalog would produce zero tests.',
      );
    });
  }

  for (const name of fixtureNames) {
    // Eagerly load so a malformed fixture crashes at test-registration
    // time (visible in the reporter as a load error on the whole
    // describe). Cheaper + louder than crashing inside the test.
    const fixture = loadFixture(name);
    test(`${fixture.name} — ${fixture.description.slice(0, 80)}`, async ({ page }) => {
      test.setTimeout(TEST_TIMEOUT_MS);
      if (fixture.skipReason !== null) {
        test.skip(true, fixture.skipReason);
        return;
      }

      // Slice M browser-driven path: live `ggui serve` host with
      // Playwright `page.route()` fault injection on the bootstrap
      // round-trip. Used for fixtures whose expected behavior is
      // observable on the host iframe surface but not via the kit's
      // pure-WS reference-server path. Network gate still applies —
      // these fixtures stay clean-room (the mutated bootstrap is
      // synthesized in-page, no hosted / AWS reach-out).
      if (BROWSER_DRIVEN_FIXTURES.has(fixture.name)) {
        if (!handle) throw new Error('handle not ready — beforeAll failed');
        const gate = await installNetworkGate(page);
        await runBrowserDrivenBootstrapFailureFixture(page, handle, fixture);
        expect(gate.attempts).toEqual([]);
        return;
      }

      // Slice O browser-driven path: live `ggui serve` host with the
      // `props-echo` blueprint + `props-echo-mount.mjs`. Drives the
      // wire-level `props_update` round-trip end-to-end. Network gate
      // still applies — the mount handler runs in-process and the
      // emission seam stays inside the running server.
      if (BROWSER_DRIVEN_PROPS_UPDATE_FIXTURES.has(fixture.name)) {
        if (!handle) throw new Error('handle not ready — beforeAll failed');
        const gate = await installNetworkGate(page);
        await runBrowserDrivenPropsUpdateFixture(page, handle, fixture);
        expect(gate.attempts).toEqual([]);
        return;
      }

      // Phase-3.1 kit-driven path (Slice G): drive the fixture
      // through `runConformance()` against the in-process reference
      // server. The iframe host path + network gate do NOT apply —
      // the kit speaks pure WS to a separate server.
      if (KIT_DRIVEN_FIXTURES.has(fixture.name)) {
        if (!refServer || !refHost) {
          throw new Error(
            'reference server not ready — beforeAll failed to start it',
          );
        }
        await runFixtureViaKit(fixture, refServer, refHost);
        return;
      }

      // Fixtures that freeze a protocol surface ahead of a driver —
      // canvas-mode wire shapes, SPEC §7.7.2 gadget obligations. No
      // path can drive them yet; skip honestly. See the set's doc.
      if (PENDING_DRIVER_FIXTURES.has(fixture.name)) {
        test.skip(
          true,
          `${fixture.name}: behavioral runner is a pending kit minor — fixture freezes the protocol intent (see its sub-module index.ts).`,
        );
        return;
      }

      if (!handle) throw new Error('handle not ready — beforeAll failed');

      // Every run-tier fixture passes through the real iframe host
      // path. Assert no hosted / AWS / Cognito reach-out — the OSS
      // clean-room invariant codified in the harness.
      const gate = await installNetworkGate(page);
      await runFixture(page, handle, fixture);
      expect(gate.attempts).toEqual([]);
    });
  }
});
