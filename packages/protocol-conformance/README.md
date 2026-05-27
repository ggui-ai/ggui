# @ggui-ai/protocol-conformance

Conformance test kit for the ggui protocol. Ships a JSON fixture catalog + a runner that drives each fixture against a live implementation over WebSocket and reports scorecard-style pass / fail / skip output.

This kit is the protocol's conformance surface: it lets a third-party MCP builder prove their implementation is protocol-conformant without reimplementing the test harness.

## Transport

**v1.0 is WebSocket-only.** The canonical ggui transport is WS (see SPEC §12 Transport Bindings). `TransportConfig` is shaped as an extensibly-closed union so later transports (stdio MCP, HTTP long-poll) can be added post-v1.1 without breaking the public API.

## Path-A vs Path-B matchability

The fixture catalog spans both wire-observable claims and surface-observable claims. The kit's runner (`runConformance()`) handles the **Path-A** subset — behaviors a runner can assert from WS frames alone, with no MCP-Apps-host adapter and no Playwright page.

Path-A-matchable kinds (`matchBehavior` returns `pass` / `fail`):

- `bootstrap-success` — subscribe → `ack` round-trip
- `version-mismatch` — `error` frame with `code: UPGRADE_REQUIRED`
- `contract-error` — `_ggui:contract-error` envelope on the reserved channel
- `stream-update` — `stream` frame on a named channel matching the declared value
- `no-op` — silence after input dispatch
- `observability-event` — `wired-tool-invoked` and `contract-error-emitted` arms (the WS evidence the protocol-and-contract bar mandates a conformant host mirror-emit on)

Path-B-only kinds (`matchBehavior` returns `unmatchable-on-ws` → runner records SKIP):

- `bootstrap-failure` — fault surface is the host's bootstrap-fetch + `ui/initialize` postMessage round-trip; `renderer-url-override` / `ui-initialize-response-override` setup directives are MCP-Apps-host concerns, not WS server concerns.
- `props-update` — assertion is on rendered DOM after `_ggui:props` is emitted; matchable on WS only as "frame was emitted", not as "DOM reflects it".
- Future `observability-event` arms beyond the two above (e.g. `schema-version-mismatch`, `subscribe-failed`).

A Path-B browser-host harness drives these fixtures via Playwright + `page.route()` fault injection + DOM assertion. A future packaged browser-host adapter will fold that capability into the kit so third-party adopters don't reimplement it.

The partition is intentional: Path-A FAILs are vendor-neutrality bugs the server owns; Path-B SKIPs are not fails — they are claims a different driver is responsible for.

## Pure-function conformance catalogs

The behavioral fixture catalog above asserts what an implementation _does_ over the wire. Some protocol obligations aren't transport-observable at all — they are deterministic _validation functions_: given an input, accept or reject it. SPEC §7.7.2's gadget obligations are exactly this. Modeling them as WebSocket fixtures would mean faking wire frames the protocol never emits; instead the kit ships **pure-function catalogs** — accept/reject cases graded against a caller-supplied function, with no host, render, or transport.

Each catalog ships its cases as raw JSON so a non-TypeScript implementer can grade their own implementation, and each runner takes the implementation as a callback — the kit never hard-binds a concrete one. Three catalogs ship today:

- **`@ggui-ai/protocol-conformance/schema-conformance`** — which `DataContract.clientCapabilities` payloads a conformant parser MUST accept / reject (the gadget wire shape).
- **`@ggui-ai/protocol-conformance/registration-conformance`** — which `(contract, appGadgets)` pairs the push-time gadget registry gate MUST accept / reject, and with which precise reject code (`gadget_not_registered` / `gadget_package_mismatch`).
- **`@ggui-ai/protocol-conformance/resolution-conformance`** — which bundle + style URLs the server MUST compute for a gadget descriptor's transport fields (`bundleHost` precedence, default host, loopback `http` scheme).

```ts
import { runSchemaConformance } from "@ggui-ai/protocol-conformance/schema-conformance";
import { runRegistrationConformance } from "@ggui-ai/protocol-conformance/registration-conformance";
import { runResolutionConformance } from "@ggui-ai/protocol-conformance/resolution-conformance";

const schema = runSchemaConformance((clientCapabilities) =>
  myGadgetWireParser.isValid(clientCapabilities)
);
const gate = runRegistrationConformance((contract, appGadgets) =>
  myGadgetGate(contract, appGadgets)
);
const urls = runResolutionConformance((entry) => myGadgetUrlResolver(entry));

if (schema.failed.length + gate.failed.length + urls.failed.length > 0) {
  process.exit(1);
}
```

The `schema-conformance` meta-test binds its catalog to the live `@ggui-ai/protocol` `clientCapabilitiesSpecSchema` — a drift-catch if the wire schema diverges from the §7.7.2 obligations the catalog freezes. The `registration-conformance` and `resolution-conformance` meta-tests verify catalog coherence against faithful in-test implementations (the kit stays vendor-neutral — it does not depend on a server implementation); grading the _shipping_ gate / resolver is an implementation-side test that drives the corresponding runner.

## Public API (target)

```ts
import { runConformance } from "@ggui-ai/protocol-conformance";

const result = await runConformance({
  serverUrl: "ws://localhost:3000/ws",
  auth: { kind: "bearer", token: process.env.TOKEN! },
});

if (result.failed.length > 0) {
  process.exit(1);
}
```

CLI equivalent:

```
npx @ggui-ai/protocol-conformance --url ws://localhost:3000/ws --auth bearer:$TOKEN
```

Full adoption guide + fixture-to-contract mapping table land with the fixture-extraction commit.

## License

Apache 2.0 — see `../LICENSE`.
