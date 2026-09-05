# @ggui-ai/protocol-conformance

Conformance test kit for the ggui protocol. Ships JSON case catalogs + runners that drive them against a live implementation — the behavioral fixtures over WebSocket, the `resources/read` cases over the MCP binding — and report scorecard-style pass / fail / skip output.

This kit is the protocol's conformance surface: it lets a third-party MCP builder prove their implementation is protocol-conformant without reimplementing the test harness.

## Grading mechanisms

The kit grades protocol obligations through **four mechanisms**, each matched to where the obligation is observable:

1. **Path-A WS fixtures** — wire-observable behaviors graded from frames the runner collects over the live channel (acks, error frames, canonical `data` deliveries).
2. **Pure-function catalogs** — deterministic validation obligations (the SPEC §7.7.2 gadget obligations) graded against a caller-supplied function; no host, render, or transport.
3. **Session-state host read-back** — stateful obligations with no wire response (e.g. `host_context_observed` persisting onto `GguiSession.hostContext`): the runner dispatches the C→S frame, waits out the observation window, then reads the GguiSession field back through `ConformanceHost.readSessionField()` and deep-equals it against the fixture's `expected`. No host (or a host without the method, or a read that throws) → the fixture SKIPS with the reason — a host that cannot read state cannot grade it, and the kit never converts that gap into a pass.
4. **MCP-binding scenario driver** — request/response obligations on the MCP surface, where the deployment shape is part of what is under test. The `resources/read` catalog is the first: a case declares a server shape, a caller identity and a seed set, the adopter's driver brings a server up that way, and the kit reads locators against it and grades the raw JSON-RPC frames. A driver that cannot express a scenario throws, and the case SKIPS — never passes.

A fifth surface — the **Path-B browser-host driver** for DOM-level claims (`bootstrap-failure`, `props-update`) — is honestly absent: it is not yet packaged, and those fixtures skip wherever the kit runs (see below).

## Transport

**The behavioral fixture catalog is WebSocket-only.** The canonical ggui live-channel transport is WS (see SPEC §12 Transport Bindings). `TransportConfig` is shaped as an extensibly-closed union so later live-channel transports (HTTP long-poll) can be added without breaking the public API.

The MCP surface is graded separately, by catalog rather than by transport config — see `resource-read-conformance` below. Its cases are deliberately NOT registered in `fixturesByContract`: everything in that map is driven over a WebSocket, so an MCP case there would be a permanent skip on every WS run, which is the false gate the kit's exact skip-set pinning exists to prevent. `resources/read` is the only MCP method bound today; `tools/call` has no driver yet.

## Path-A vs Path-B matchability

The fixture catalog spans both wire-observable claims and surface-observable claims. The kit's runner (`runConformance()`) handles the **Path-A** subset — behaviors a runner can assert from WS frames alone, with no MCP-Apps-host adapter and no Playwright page.

Path-A-matchable kinds (`matchBehavior` returns `pass` / `fail`):

- `bootstrap-success` — subscribe → `ack` round-trip; optionally (`serverVersion: 'current'`) the ack must also advertise `payload.serverVersion` equal to the kit's compiled `PROTOCOL_SCHEMA_VERSION` — the server half of SPEC §12.2.2's version handshake
- `version-mismatch` — `error` frame with `code: UPGRADE_REQUIRED`; the provoking client declaration travels on the fixture's `subscribe.supportedVersions` knob (`'current'` resolves to the compiled canonical, keeping fixtures evergreen across version bumps)
- `action-ack` — the action's `ack` frame (matched by echoed `requestId`) carries a numeric `payload.sequence`, proving the action event persisted to the GguiSession's consume buffer before the ack
- `error-frame` — `error` frame with the expected `payload.code` (e.g. `CONTRACT_VIOLATION` for an action absent from the declared actionSpec, or one whose `data` violates the declared entry's payload schema)
- `stream-update` — canonical channel-3 delivery frame (`{type: 'data', payload: StreamEnvelope}`, SPEC §12.2) whose envelope names the declared channel and carries the declared value as its `payload` body — exact deep-equal by default, or declared-keys-subset when the fixture authors `valueMatch: 'subset'` (for payloads carrying non-deterministic fields like generated ids)
- `no-op` — silence after input dispatch

One kind is neither Path A nor Path B: `session-state` is graded by the **runner**, not the frame matcher — a post-observation-window read-back via `ConformanceHost.readSessionField()` (mechanism 3 above). `matchBehavior` returns `unmatchable-on-ws` for it, because frames cannot prove state.

Path-B-only kinds (`matchBehavior` returns `unmatchable-on-ws` → runner records SKIP):

- `bootstrap-failure` — fault surface is the host's bootstrap-fetch + `ui/initialize` postMessage round-trip; `renderer-url-override` / `ui-initialize-response-override` setup directives are MCP-Apps-host concerns, not WS server concerns.
- `props-update` — assertion is on rendered DOM after `_ggui:props` is emitted; matchable on WS only as "frame was emitted", not as "DOM reflects it".

The Path-B driver is not yet packaged — no browser-host harness ships with the kit today, so Path-B fixtures skip wherever the kit runs. A future packaged browser-host adapter will fold that capability into the kit so third-party adopters don't reimplement it.

The partition is intentional: Path-A FAILs are vendor-neutrality bugs the server owns; Path-B SKIPs are not fails — they are claims a different driver is responsible for.

One declared grading gap on the action loop: `action-ack` proves the append half of the consume-buffer contract; the retrieval half (the agent draining the buffer via `ggui_consume`) is an MCP **tool call**, which a WS runner cannot drive. The resource-read catalog below does not close it — that driver binds `resources/read`, and `tools/call` is a different method with a different seam. Grading it needs a tool-call driver, not a weaker WS assertion.

## Pure-function conformance catalogs

The behavioral fixture catalog above asserts what an implementation _does_ over the wire. Some protocol obligations aren't transport-observable at all — they are deterministic _validation functions_: given an input, accept or reject it. SPEC §7.7.2's gadget obligations are exactly this. Modeling them as WebSocket fixtures would mean faking wire frames the protocol never emits; instead the kit ships **pure-function catalogs** — accept/reject cases graded against a caller-supplied function, with no host, render, or transport.

Each catalog ships its cases as raw JSON so a non-TypeScript implementer can grade their own implementation, and each runner takes the implementation as a callback — the kit never hard-binds a concrete one. Nine catalogs ship today:

- **`@ggui-ai/protocol-conformance/schema-conformance`** — which `DataContract.clientCapabilities` payloads a conformant parser MUST accept / reject (the gadget wire shape).
- **`@ggui-ai/protocol-conformance/registration-conformance`** — which `(contract, appGadgets, appPublicEnv)` triples the push-time gadget gate stack MUST accept / reject, and with which precise SPEC §7.9 reject code (`gadget_not_registered` / `gadget_package_mismatch` / `gadget_public_env_missing` / `duplicate_gadget_hook`).
- **`@ggui-ai/protocol-conformance/resolution-conformance`** — which bundle + style URLs the server MUST compute for a gadget descriptor's transport fields (`bundleHost` precedence, default host, loopback `http` scheme).
- **`@ggui-ai/protocol-conformance/binding-conformance`** — which MCP tool-binding set a manifest resolves to (a declared `mcpTools` list wins entirely; blueprints without it derive bare tool-name entries from contract tool names) and which artifacts the registry `tool=` / `server=` search filters MUST match (SPEC §7.7.4.1).
- **`@ggui-ai/protocol-conformance/props-schema-conformance`** — the schema-precise render arbiter (SPEC §2.3.2): the enforced-props-schema builder (drift), its RFC 8785 sha256 hash, the grammar-safe profile verdict, and returned-schema AUTHORITY (sample validity under the case's own `propsSchema`, including the 2026-08-19 out-of-vocabulary enum incident pinned as a permanent sample).
- **`@ggui-ai/protocol-conformance/host-helper-conformance`** — which render coordinates a HOST-HELPER library MUST extract from a `tools/call` result, and which malformed results it MUST decline rather than guess at.
- **`@ggui-ai/protocol-conformance/refusal-envelope-conformance`** — the tool result a server MUST project for a PRE-GENERATION refusal (SPEC §7.1's refused arm): an in-result `isError` (never a throw), `content[0].text` leading with the code, `structuredContent` carrying `{outcome: 'refused', refusal}` and nothing else, no `_meta` — and no envelope at all for a registered code whose surfaces exclude the render gate.
- **`@ggui-ai/protocol-conformance/registry-completeness`** — the structural obligations a deployment's closed refusal-code registry MUST satisfy: `surfaces` non-empty, `code === key`, every `after-fix` entry naming who acts (`fixBy`), and `retry` inside the closed four-value set. Grades DATA rather than a function — the caller passes their registry.
- **`@ggui-ai/protocol-conformance/transport-refusal-conformance`** — the JSON-RPC error a per-app MCP endpoint MUST answer with when it refuses a request for a typed reason (SPEC §7.1's endpoint-level refusal, ggui#825): HTTP 403 with `{ code: -32003, message: 'App not found', data: { refusal } }`, where `refusal` is the registry projection without the render-only fields (`code`, `message`, `fix`, `retry`) — and no envelope at all for a registered code whose surfaces exclude `mcp-endpoint` (an untyped authorization failure answers 403 with `-32001` and no `data`, by contract — ggui#836). Runner: `runTransportRefusalConformance(project)`; folded into `runConformance()` via `transportRefusalProjector`.

```ts
import { runSchemaConformance } from "@ggui-ai/protocol-conformance/schema-conformance";
import { runRegistrationConformance } from "@ggui-ai/protocol-conformance/registration-conformance";
import { runResolutionConformance } from "@ggui-ai/protocol-conformance/resolution-conformance";

const schema = runSchemaConformance((clientCapabilities) =>
  myGadgetWireParser.isValid(clientCapabilities)
);
const gate = runRegistrationConformance((contract, appGadgets, appPublicEnv) =>
  myGadgetGate(contract, appGadgets, appPublicEnv)
);
const urls = runResolutionConformance((entry) => myGadgetUrlResolver(entry));

if (schema.failed.length + gate.failed.length + urls.failed.length > 0) {
  process.exit(1);
}
```

The `schema-conformance` meta-test binds its catalog to the live `@ggui-ai/protocol` `clientCapabilitiesSpecSchema` — a drift-catch if the wire schema diverges from the §7.7.2 obligations the catalog freezes. The `registration-conformance`, `resolution-conformance`, and `binding-conformance` meta-tests verify catalog coherence against faithful in-test implementations (the kit stays vendor-neutral — it does not depend on a server implementation); grading the _shipping_ gate / resolver is an implementation-side test that drives the corresponding runner. The two ggui#786 catalogs split the same way, and for the same reason: `registry-completeness` binds the LIVE `@ggui-ai/protocol` `PRE_GENERATION_REFUSAL_CODES` (the obligation IS a protocol declaration, so the drift-catch belongs kit-side, like `schema-conformance`), while `refusal-envelope-conformance` grades a kit-local reference projector (the obligation is an implementation behaviour, like `resolution-conformance`). Two of that ruling's six registry checks read repo source — the no-auto-retry docstring rule and the grep for code literals minted outside the registry file — and are therefore NOT in the kit: it publishes only `dist`, so a source walk could never run for an adopter. They live in `@ggui-ai/protocol`'s own suite. That split is declared, not hidden.

## Resource-read conformance — the MCP binding

A read of a render locator (`ui://ggui/render/{sessionId}` or `ui://ggui/render/{sessionId}/{blueprintKey}`) has exactly **two exits**: a result whose contents declare a delivery channel — a live mount — or one typed JSON-RPC error. There is no third outcome, and in particular no successful result carrying a shell that can never paint anything.

That is what makes the read host-checkable. A host that gets `contents` back can mount them without inspecting anything; a host that gets an error routes on `error.data.code` — "come back never" versus "come back with a fresh render" — without parsing prose.

```ts
import { runResourceReadConformance } from "@ggui-ai/protocol-conformance/resource-read-conformance";

const result = await runResourceReadConformance(async (scenario) => {
  // Bring YOUR server up in `scenario.server`'s shape, as
  // `scenario.caller`, with `scenario.seeds` applied.
  const server = await bootMyServer(scenario);
  return {
    // Keys your registry assigned to `registered-blueprint` seeds.
    registeredKeys: server.registeredKeys,
    // MUST resolve. A protocol failure is `{kind: 'error'}` carrying
    // the RAW frame — an MCP client's reconstructed error rewrites
    // `message`, and the disclosure obligation is graded on bytes.
    read: (uri) => server.readResource(uri),
    dispose: () => server.close(),
  };
});

if (result.failed.length > 0 || result.passed.length === 0) process.exit(1);
```

Throwing from the driver means "I cannot express this scenario" and the case **skips** with that reason — never passes. Throwing from `read` is a **fail**, because the read is the thing under test.

The catalog grades all four failure classes (`NOT_FOUND` on `-32002`; `BLUEPRINT_UNRESOLVABLE` / `NOT_SUPPORTED` / `NOT_MOUNTABLE` on `-32006`), the mount half on both a live row and a re-minted one, and the disclosure obligation: a read refused for lack of entitlement and a read of a locator that never existed must be **byte-identical**, on a server that keeps durable records, on one that keeps none, on the two half-wired shapes in between, and on one whose blueprint registry matches the probed key.

It deliberately does **not** grade: the order in which a substrate-less server answers (`NOT_SUPPORTED` describes the deployment, so answering it immediately is correct); `detail` wording on any code; the `NOT_FOUND` message literal (its _constancy_ is what is normative); internal-error message text; the number a URI naming no locator receives (that belongs to the transport binding — only the negative is graded, that it must not be one of the four); and the shell's markup (success is graded on the projected render meta, never on DOM shape).

## Conformance status

What is actually graded against shipping code today, and what is still awaiting a driver. This is an inventory, not a roadmap — a mechanism is listed as proven only if a test in the repo drives it against the real implementation on every push.

Every test below is a plain `*.test.ts` inside a package's `src/`, so it runs in that package's ordinary vitest suite. The ggui repo's per-push CI runs `turbo run test` across all non-e2e packages, so **all twelve rows below are gated on every push** — the kit needs no dedicated workflow, and adopters wiring it into their own CI need nothing more than their existing unit-test task.

| Obligation                                                              | Graded against                                                                                                                                                                                                                                                                 | Driver                                                                                                                |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| Gadget wire schema (§7.7.2)                                             | the shipping `@ggui-ai/protocol` `clientCapabilitiesSpecSchema`                                                                                                                                                                                                                | this kit's own `src/schema-conformance/schema-conformance.test.ts`                                                    |
| Registration gate (§7.7.3, §7.9)                                        | the shipping gate trio in `@ggui-ai/mcp-server-handlers`                                                                                                                                                                                                                       | `mcp-server-handlers/src/renders/assert-gadgets.conformance.test.ts`                                                  |
| Bundle-URL resolution (§7.7.2)                                          | the shipping `resolveGadgetUrls` in `@ggui-ai/mcp-server-handlers`                                                                                                                                                                                                             | `mcp-server-handlers/src/renders/resolve-gadget-urls.conformance.test.ts`                                             |
| Path-A WS fixtures — first-party                                        | the real `@ggui-ai/mcp-server` GguiSession channel, booted in-process on an ephemeral port                                                                                                                                                                                     | `mcp-server/src/ggui-session-channel.conformance.test.ts` — **24 pass / 12 skip / 0 fail**                            |
| Path-A WS fixtures — vendor-neutral                                     | `@ggui-ai/protocol-reference-server`                                                                                                                                                                                                                                           | `protocol-reference-server/src/conformance.test.ts` — **13 pass / 11 skip / 0 fail**                                  |
| `resources/read` typed failures + mount invariant                       | the shipping `registerGguiRenderResourceTemplate` in `@ggui-ai/mcp-server`                                                                                                                                                                                                     | `mcp-server/src/mcp-apps-outbound.resource-read.conformance.test.ts` — **12 pass / 0 skip / 0 fail**                  |
| Tool-binding resolution — declared wins, contract derivation (§7.7.4.1) | the shipping `resolveMcpToolBindings` in `@ggui-ai/artifact-manifest`                                                                                                                                                                                                          | `artifact-manifest/src/mcp-tool-bindings.conformance.test.ts`                                                         |
| Tool-binding search filters — `tool=` / `server=` semantics (§7.7.4.1)  | the shipping `matchesMcpToolFilters` in `@ggui-ai/registry-core`                                                                                                                                                                                                               | `registry-core/src/mcp-tool-filters.conformance.test.ts`                                                              |
| Pre-generation refusal envelope (§7.1, refused arm)                     | the shipping `ggui_render` refusal projection in `@ggui-ai/mcp-server-handlers`                                                                                                                                                                                                | `mcp-server-handlers/src/renders/render-refusal-projection.conformance.test.ts`                                       |
| Refusal-registry completeness (ggui#786 ruling 5b)                      | the shipping `PRE_GENERATION_REFUSAL_CODES` in `@ggui-ai/protocol`                                                                                                                                                                                                             | this kit's own `src/registry-completeness/registry-completeness.test.ts`                                              |
| Endpoint-level refusal (§7.1, `mcp-endpoint` surface, ggui#825)         | the catalog's kit-local reference projector only — no shipping deployment projector is graded yet: the OSS route is generic (`errorMapper`), the first-party server and the reference server supply no projector (SKIPPED, named), and the pod's mapper lands after this slice | this kit's own `src/transport-refusal-conformance/transport-refusal-conformance.test.ts` (coherence + discrimination) |

Both WS drivers pin their pass set _and_ their skip set as exact sets, and the resource-read driver pins its skip set as exactly empty. A fixture silently degrading to a skip fails the build, and so does a skipped fixture that quietly starts passing — a skip set that can grow unnoticed is a false gate, and re-pinning it is meant to be a deliberate act.

**Awaiting a driver:**

- **Path-B browser-host fixtures** — `bootstrap-bundle-fetch-failed`, `bootstrap-meta-missing` (both need MCP-Apps-host fault injection) and `props-update-roundtrip` (assertion is on rendered DOM). No browser-host adapter ships with the kit, so these skip on every WS driver above. Honestly absent, not silently passing.
- **`version-mismatch` on the first-party server** — needs a `server-version-override` seam the channel deliberately does not expose; adding a production seam with no production caller purely to drive a fixture was rejected. It passes on the reference server, which has a per-render override.
- **The `ggui_consume` retrieval half of the action loop, and `stream-delivery-roundtrip`** — both are `tools/call` obligations (`ggui_consume`, `ggui_emit`). The resource-read driver binds `resources/read` only, so neither is closed by it; both await a tool-call driver.
- **`resources/read` on a second implementation** — the catalog is vendor-neutral by construction (the kit imports no server; the adopter supplies the driver), but it is graded against one implementation today. A second binding is what would ground the vendor-neutrality claim empirically, the way `protocol-reference-server` does for the WS catalog.

## Public API

```ts
import { runConformance } from "@ggui-ai/protocol-conformance";

const result = await runConformance({
  serverUrl: "ws://localhost:3000/ws",
  auth: { kind: "bearer", token: process.env.TOKEN! },
});

// A failed fixture is a red build — and so is a run that executed
// ZERO fixtures (all skips prove nothing).
if (result.failed.length > 0 || result.passed.length === 0) {
  process.exit(1);
}
```

`serverUrl` accepts either a bare origin (`http://localhost:3000` — the runner derives `ws://localhost:3000/ws`) or the full live-channel endpoint (`ws://localhost:3000/ws` — used exactly as given; the runner never appends to an explicit path).

CLI equivalent:

```
npx @ggui-ai/protocol-conformance --url ws://localhost:3000/ws --auth bearer:$TOKEN
```

The CLI exits `0` only when at least one fixture executed and none failed; `1` on any fixture failure; `2` on invocation errors **or** when every fixture skipped (a zero-executed run never reads as success in CI).

To grade setup-dependent fixtures (and any `session-state` fixture), pass a `host` implementing the `ConformanceHost` adapter — `dispatchSetup` / `dispatchTeardown` for the directive vocabulary, plus the optional `readSessionField(sessionId, field)` introspection seam. Fixtures whose requirements the host doesn't meet skip with a precise reason; they never silently pass.

## License

Apache 2.0 — see `../LICENSE`.
