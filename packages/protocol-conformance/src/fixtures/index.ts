/**
 * Fixture catalog — every conformance fixture, classified by the
 * contract or protocol criterion it exercises.
 *
 * The sub-module layout (one directory per contract) is load-bearing:
 * it is how the reporter groups results on the bar-scorecard output,
 * and how third-party implementers understand which criterion each
 * fixture asserts. Renaming a sub-module directory breaks the
 * reporter's output shape — treat the classification as the public
 * API.
 *
 * ## Why static imports
 *
 * The fixture JSON files are statically imported (`import … from
 * './foo.json' with { type: 'json' }`) so tsc inlines the fixture
 * data into `dist/fixtures/`. Third-party TS consumers get typed
 * arrays without a runtime file-read. Non-TS consumers (Python, Go,
 * Rust) read the raw `.json` files directly — they ship in `dist/`
 * via the package's `files` field.
 *
 * ## Current coverage
 *
 * Seven sub-modules with content (18 fixtures). Three additional
 * sub-modules (`data-contract`, `tool-name-uniqueness`,
 * `contract-error-payload`) are reserved for additive fixture
 * expansion and not yet materialized — adding fixtures there is a
 * kit minor version.
 *
 * `canvas-mode-wire-shapes` (4 fixtures) ships the canvas-mode wire
 * contract intent: `canvasMode` bootstrap discriminator,
 * `_ggui:lifecycle` channel + payload, `canvas_navigated` +
 * `host_context_observed` C→S WS messages. Runner activation is a
 * follow-up kit minor once the reference `ConformanceHost` exposes
 * `set-app-mode` + `assert-session-field` + `assert-channel-envelope`
 * directives.
 *
 * ## What is NOT here — the gadget pure-function obligations
 *
 * SPEC §7.7.2's gadget obligations are pure-function obligations, not
 * transport-observable behaviors: which `clientCapabilities` payloads
 * a parser accepts (`../schema-conformance`) and which `(contract,
 * appGadgets)` pairs the push-time registry gate accepts / rejects
 * (`../registration-conformance`). They are graded against a
 * caller-supplied function — there is no session, transport, or wire
 * frame to drive — so they do NOT belong in this behavioral fixture
 * catalog.
 */

export { bootstrapProtocolFixtures } from './bootstrap-protocol/index.js';
export { canvasModeWireShapesFixtures } from './canvas-mode-wire-shapes/index.js';
export { observabilityEventsFixtures } from './observability-events/index.js';
export { refreshSemanticsFixtures } from './refresh-semantics/index.js';
export { reservedChannelAuthorityFixtures } from './reserved-channel-authority/index.js';
export { schemaVersionHandshakeFixtures } from './schema-version-handshake/index.js';
export { wiredActionDispatchFixtures } from './wired-action-dispatch/index.js';

import type { TestCase } from '../types.js';
import { bootstrapProtocolFixtures } from './bootstrap-protocol/index.js';
import { canvasModeWireShapesFixtures } from './canvas-mode-wire-shapes/index.js';
import { observabilityEventsFixtures } from './observability-events/index.js';
import { refreshSemanticsFixtures } from './refresh-semantics/index.js';
import { reservedChannelAuthorityFixtures } from './reserved-channel-authority/index.js';
import { schemaVersionHandshakeFixtures } from './schema-version-handshake/index.js';
import { wiredActionDispatchFixtures } from './wired-action-dispatch/index.js';

/**
 * Contract slugs — match the sub-module directory names. The
 * reporter uses these verbatim as group headers on the scorecard.
 * Extensibly-closed via `(string & {})` so additive sub-modules
 * register without an API break.
 */
export type ContractSlug =
  | 'bootstrap-protocol'
  | 'canvas-mode-wire-shapes'
  | 'observability-events'
  | 'refresh-semantics'
  | 'reserved-channel-authority'
  | 'schema-version-handshake'
  | 'wired-action-dispatch'
  | (string & {});

/**
 * Every fixture the kit ships, grouped by the contract it exercises.
 * Order within each group matches the sub-module's `export` order.
 *
 * Map shape is load-bearing — the runner iterates
 * `Object.entries(fixturesByContract)` to produce the bar scorecard,
 * and consumers iterate it for custom reporters.
 */
export const fixturesByContract: Readonly<Record<ContractSlug, readonly TestCase[]>> = {
  'bootstrap-protocol': bootstrapProtocolFixtures,
  'canvas-mode-wire-shapes': canvasModeWireShapesFixtures,
  'observability-events': observabilityEventsFixtures,
  'refresh-semantics': refreshSemanticsFixtures,
  'reserved-channel-authority': reservedChannelAuthorityFixtures,
  'schema-version-handshake': schemaVersionHandshakeFixtures,
  'wired-action-dispatch': wiredActionDispatchFixtures,
};

/**
 * Every fixture flat, in deterministic lexicographic order by
 * `name`. Runners that don't care about classification iterate this
 * list directly.
 */
export const allFixtures: readonly TestCase[] = Object.values(fixturesByContract)
  .flat()
  .slice()
  .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
