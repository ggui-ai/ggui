# `@ggui-ai/e2e-mcp-host-simulator`

Headless MCP Apps host simulator (OSS-local path) — Tier 2 of the testing pyramid (see `docs/testing.md`).

## What this is

A reusable test fixture that mimics what an MCP-Apps-aware host (claude.ai, Claude Desktop, Goose) actually does over the wire, driven against an **in-process** OSS `createGguiServer` factory:

1. **Initialize** the MCP session via Streamable HTTP
2. **`tools/list`** with `_meta.ui.resourceUri` pre-fetch (the host fetches each declared bundle URL on tools/list, NOT lazily on first tool-call — the spec says hosts SHOULD pre-fetch)
3. **`tools/call`** with bootstrap-token extraction from `resultMeta._meta["ai.ggui/render"]`
4. **WebSocket subscribe** with the bootstrap token, validates the ack
5. **Submit-action bridge** — when the iframe sends `ui/message`, the host responds with the documented 3-message bridge (`ggui_runtime_submit_action` + `ui/update-model-context` + `ui/message`), per `docs/development/mcp-apps-submit-action-bridge.md`
6. **OAuth flow** — RFC 9728 + 8414 + 7591 + 7636 + 6749 + 8707 discovery + DCR + PKCE code-grant

Everything runs in vitest with no browser, no jsdom, no Playwright.

This package **owns the `HostSimulator` core** + the `bootOssServer` fixture. The core is deliberately transport-generic: point `HostSimulator` at any deployed ggui server's URL to drive the same lifecycle against a remote endpoint instead of the local fixture.

## What this is NOT

- **Not a hosted-deployment monitor** — this package tests the server you boot locally; probing a live remote deployment is a different job with different auth and uptime concerns, out of scope here.
- **Not a faithful claude.ai recreation** — claude.ai has CSP rules, message validators, anti-bot signals, OAuth UI. The simulator covers the wire shape, not the chrome.
- **Not a substitute for the protocol probe card** — `packages/iframe-runtime/src/system-cards/ProtocolProbeCard.tsx` is the regression fixture for real-host quirks. Run it manually pre-launch + on host-shape changes.
- **Not a mock LLM** — the simulator drives the wire, not the model. The OSS dev path uses the real ui-generator.

## Tier mapping

| Tier  | What runs                     | Where it runs   | When                            |
| ----- | ----------------------------- | --------------- | ------------------------------- |
| 1     | unit + integration vitest     | per-package     | every commit                    |
| **2** | **oss-mcp-host-simulator**    | this package    | every commit                    |
| 3     | real claude.ai via probe card | manual operator | pre-launch + host-version flips |

**Tier-3 invocation quirk** (caught by the ritual itself, 2026-08-24, 5/5
pass): a bare `[ggui:probe] …` chat message gets **paraphrased** by the
host model — you get a "READY" chat reply instead of tool pass-through,
and the probe never fires. Force verbatim pass-through in the invocation:

> Use the ggui render tool now with the intent set to exactly this
> string, unchanged: "[ggui:probe] …" — do not rephrase.

The model-paraphrase hole is exactly the real-host quirk class Tier 3
exists to catch; treat any new "probe never fired" symptom as this first.

## Usage

```ts
import { describe, expect, it } from "vitest";
import { HostSimulator, bootOssServer } from "@ggui-ai/e2e-mcp-host-simulator";

it("happy path: tools/list → handshake → render → bootstrap → ws ack", async () => {
  const fixture = await bootOssServer();
  const host = new HostSimulator({ url: fixture.url });
  await host.connect();

  const tools = await host.listTools();
  expect(tools.find((t) => t.name === "ggui_render")).toBeDefined();

  const flow = await host.openRender({ intent: "render a hello world card" });
  expect(flow.render.meta).toBeDefined();

  const { ack } = await host.subscribeWith(flow.render.meta!);
  expect(ack.kind).toBe("ack");

  await host.close();
  await fixture.close();
});
```

### Submit-action usage

```ts
import { HostSimulator, bootOssServer } from "@ggui-ai/e2e-mcp-host-simulator";

const fixture = await bootOssServer();
const host = new HostSimulator({ url: fixture.url, bearer: "host-simulator-test" });
await host.connect();

// 1. Mint a bootstrap from ggui_render.
const flow = await host.openRender({ intent: "render a counter" });

// 2. Simulate a submit-action click. Drives:
//    - tools/call ggui_runtime_submit_action over MCP transport (real round-trip)
//    - ui/update-model-context (captured into host.getModelContext())
//    - ui/message (appended to host.getConsentLog())
const result = await host.simulateSubmitAction({
  intent: "submit",
  data: { name: "Wanseob" },
  meta: flow.render.meta!,
});

console.log(result.actionId); // 8-hex FNV-1a id
console.log(result.gatewayResult); // server-side echo
console.log(result.pendingActionText); // [ggui:pending-action] {...}
console.log(result.consentText); // Please proceed with **submit** (name: Wanseob). [id: `…`]
```

The 3 envelopes are byte-identical to what `packages/iframe-runtime/src/runtime.ts::dispatchSubmitAction` posts in production. Per `docs/development/mcp-apps-submit-action-bridge.md`, the `tools/call` is the only one that crosses the wire — the other two are host-internal (LLM context + chat input). The simulator captures both for assertion.

### OAuth flow usage

```ts
import { OAuthFlowSimulator, bootOssServer } from "@ggui-ai/e2e-mcp-host-simulator";

const fixture = await bootOssServer({ oauth: {} });
const flow = new OAuthFlowSimulator({ url: fixture.url });

// One-call composer — discovery → DCR → /authorize → /token.
const result = await flow.runFullFlow({
  apiKey: "ggui_user_xxx", // or 'devAllowAllKey' on devAllowAll adapter
  resource: "https://mcp.example.test/mcp", // RFC 8707 — optional
  state: "opaque-csrf-token",
});
console.log(result.accessToken); // Bearer token usable on /mcp
console.log(result.clientId); // mcp_client_<base64url>
console.log(result.prDoc); // RFC 9728 metadata
console.log(result.asMeta); // RFC 8414 metadata
```

The simulator collapses the user-consent step (real claude.ai opens a browser) by POSTing the form directly with `api_key=<bearer>`. Tests asserting RFC 8707 mismatch, PKCE drift, or `invalid_grant` shapes drive `submitAuthorize` + `exchangeToken` independently to vary one side without the other.

## Tests

| File                                   | Covers                                                                                                                                                                              |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `happy-path.test.ts`                   | initialize → tools/list pre-fetch → tools/call → ws ack                                                                                                                             |
| `host-shapes.test.ts`                  | `claude-ai` / `claude-desktop` / `goose` preset parity                                                                                                                              |
| `oauth-flow.test.ts`                   | full RFC discovery + DCR + PKCE code-grant chain                                                                                                                                    |
| `submit-action.test.ts`                | the 3-message submit-action bridge end-to-end                                                                                                                                       |
| `slice-5-installed-blueprints.test.ts` | installed-blueprint → handshake `origin: 'cache'` proof                                                                                                                             |
| `slice-16e-blueprint-registry.test.ts` | blueprint-first registry over the wire (LIVE on the current three-step handshake; one inner `it.skip` — a pre-D10 contract-less case whose coverage moved to `@ggui-ai/negotiator`) |
