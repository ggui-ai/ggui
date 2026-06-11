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
 * Six sub-modules with content (12 fixtures). Additional sub-modules
 * (`data-contract`, `tool-name-uniqueness`)
 * are reserved for additive fixture expansion and not yet
 * materialized — adding fixtures there is a kit minor version.
 *
 * ## What is NOT here — the gadget pure-function obligations
 *
 * SPEC §7.7.2's gadget obligations are pure-function obligations, not
 * transport-observable behaviors: which `clientCapabilities` payloads
 * a parser accepts (`../schema-conformance`) and which `(contract,
 * appGadgets)` pairs the push-time registry gate accepts / rejects
 * (`../registration-conformance`). They are graded against a
 * caller-supplied function — there is no render, transport, or wire
 * frame to drive — so they do NOT belong in this behavioral fixture
 * catalog.
 *
 * ## What is NOT here — declared Path-A sequencing gap
 *
 * A `stream-delivery-roundtrip` fixture (an `emit-envelope`'d payload
 * observed as a canonical `{type: 'data', payload: StreamEnvelope}`
 * frame, graded by `stream-update`) is NOT authorable today without a
 * false fail: the runner dispatches every setup directive BEFORE it
 * opens the WebSocket and subscribes, and `emit-envelope` fans out to
 * live subscribers only — a fresh, `fromSeq`-less subscribe replays
 * nothing on declared channels (SPEC §12.2.1 invariant 1: "`fromSeq`
 * absent always means empty replay"), so the setup-time emission is
 * gone before the runner can observe it. The fixture's
 * `inputEnvelope` cannot carry the emission either: an input envelope
 * is by contract a Client→Server wire frame the runner sends on the
 * transport, while emission is server-side (the agent's `ggui_emit`
 * MCP tool) — routing a host directive through the wire-frame slot
 * would conflate the two vocabularies. Honest grading needs either a
 * post-subscribe host-directive phase (a runner-mechanism change) or
 * an MCP-binding driver. Declared here rather than papered over with
 * a fixture that fails conformant servers on sequencing alone.
 */

export { bootstrapProtocolFixtures } from './bootstrap-protocol/index.js';
export { consumeBufferFixtures } from './consume-buffer/index.js';
export { hostContextFixtures } from './host-context/index.js';
export { reservedChannelAuthorityFixtures } from './reserved-channel-authority/index.js';
export { schemaVersionHandshakeFixtures } from './schema-version-handshake/index.js';
export { subscribeTenancyFixtures } from './subscribe-tenancy/index.js';

import type { TestCase } from '../types.js';
import { bootstrapProtocolFixtures } from './bootstrap-protocol/index.js';
import { consumeBufferFixtures } from './consume-buffer/index.js';
import { hostContextFixtures } from './host-context/index.js';
import { reservedChannelAuthorityFixtures } from './reserved-channel-authority/index.js';
import { schemaVersionHandshakeFixtures } from './schema-version-handshake/index.js';
import { subscribeTenancyFixtures } from './subscribe-tenancy/index.js';

/**
 * Contract slugs — match the sub-module directory names. The
 * reporter uses these verbatim as group headers on the scorecard.
 * Extensibly-closed via `(string & {})` so additive sub-modules
 * register without an API break.
 */
export type ContractSlug =
  | 'bootstrap-protocol'
  | 'consume-buffer'
  | 'host-context'
  | 'reserved-channel-authority'
  | 'schema-version-handshake'
  | 'subscribe-tenancy'
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
  'consume-buffer': consumeBufferFixtures,
  'host-context': hostContextFixtures,
  'reserved-channel-authority': reservedChannelAuthorityFixtures,
  'schema-version-handshake': schemaVersionHandshakeFixtures,
  'subscribe-tenancy': subscribeTenancyFixtures,
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
