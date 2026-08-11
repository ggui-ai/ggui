# @ggui-ai/e2e-wire-scenarios

Canonical end-to-end scenario suite for the ggui protocol. Vitest-driven full-stack journeys against the OSS samples — pins the wire's behavioral contract so a regression in any layer (protocol, handlers, iframe-runtime, MCP server, samples) trips the suite.

> **Rename note (2026-05-24):** this dir was `oss/e2e/scenarios/` until
> the Phase 2 disambiguation. Renamed to `wire-scenarios/` so a reader
> can tell the difference between this (OSS, wire-contract focus) and
> `cloud/e2e/scenarios/` (cloud, persona-organized) at a glance. Package
> name moved in lockstep: `@ggui-ai/e2e-scenarios` → `@ggui-ai/e2e-wire-scenarios`.

## Axis — numeric ordinal + descriptive slug

Every spec is named `<NN>-<slug>.spec.ts` where `NN` is a stable
two-digit ordinal (01-26 today; 13/23/24 retired). New scenarios append
to the next free ordinal. The ordinal is the load-bearing identifier —
referenced from PR descriptions, CI logs, and the
[provider matrix](#provider-matrix) below. Per
[Test Placement](../../../docs/principles/test-placement.md), this is a
single stable axis; no per-feature subdirs.

**Where does a new test go?** Append the next free ordinal:
`tests/27-<slug>.spec.ts`. Add a row to the flagship table below AND
the [CI Tier Classification](#ci-tier-classification-478) table — if
the test needs an LLM, audit whether it should join the provider
matrix; if not, it belongs in the keyless sweep
(`.github/workflows/oss-e2e-matrix.yml`'s `wire-scenarios-keyless-sweep`
job) unless it's excluded for a documented reason.

## Why vitest + playwright-core (not @playwright/test)

The workspace runs with `node-linker=hoisted` in `.npmrc` (required for AWS Amplify Hosting monorepo SSR builds). That breaks `@playwright/test`'s singleton-module invariant — the runner and the test files end up importing different physical copies of `@playwright/test`, even at the same version, and you get `Playwright Test did not expect test() to be called here` errors.

Vitest doesn't have this problem (it doesn't rely on singleton module identity), and `playwright-core` (the gadget) drives Chromium directly. Same coverage, runs cleanly under our hoist config. Matches `@ggui-ai/ui-visual-tester`'s existing pattern.

## What it tests

The suite has 25+ scenarios pinning the wire's behavioral contract. The flagship integration tests are listed below; the rest follow the same shape (Vitest `describe` + Playwright-core browser) and live under `tests/`.

| #   | Scenario                                     | Needs LLM | Notes                                                                                                              |
| --- | -------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------ |
| 1   | submit_action happy path                     | ✅        | render contract with actionSpec → click → consume drains event                                                     |
| 2   | PIPE_NOT_FOUND is terminal                   | ❌        | dispatch to a never-minted sessionId → asserts `{ok:false, code:PIPE_NOT_FOUND}` (no doorbell, no inline fallback) |
| 3   | contextSnapshot bundle                       | ✅        | render w/contextSpec → sync_context → click → consume returns the snapshot                                         |
| 4   | CONTEXT_TOO_LARGE rejection                  | ❌        | sync_context with oversize snapshot → asserts CONTEXT_TOO_LARGE                                                    |
| 5   | pure-display render (no actionSpec)          | ✅        | render w/o actionSpec → asserts no nextStep                                                                        |
| 6   | sample-agent + todo MCP real-data round trip | ✅        | full-stack: prompt → todo_add → state mutates → re-render                                                          |

### Provider matrix

LLM scenarios fan out across two **orthogonal** axes:

- **Agent-framework axis** (scenario 6 only) — one row per reference sample agent: `claude-agent-sdk` (Anthropic), `openai-agents-sdk` (OpenAI), `google-adk` (Gemini). Each row spawns its own sample on its own port (6790 / 6791 / 6792) and natural-pairs with the matching ggui-default instance below.
- **Model-provider axis** (scenarios 03 / 09 / 11 / 12 / 15) — one row per ggui-default instance (`anthropic` / `openai` / `google`). No agent in the loop; the test drives `render-contract` directly against the matching MCP endpoint.

Each row uses `describe.skipIf(...)` to drop out cleanly when its API key is missing. Set `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` to flip skip → hard-fail (the label-gated CI path).

### Env vars

| Var                                 | Required | Effect                                                                                                 |
| ----------------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `ANTHROPIC_API_KEY`                 | per-row  | Unlocks anthropic rows + the existing `:6781` ggui-default cold-gen path.                              |
| `OPENAI_API_KEY`                    | per-row  | Unlocks openai rows + boots `:6787` ggui-default-openai.                                               |
| `GEMINI_API_KEY` / `GOOGLE_API_KEY` | per-row  | Unlocks google rows + boots `:6788` ggui-default-google.                                               |
| `GGUI_E2E_REQUIRE_ALL_PROVIDERS`    | optional | When `=1`, missing keys hard-fail their row instead of skipping. Used by label-gated / nightly CI.     |
| `GGUI_PORT`                         | optional | Override the anthropic ggui port (default `6781`).                                                     |
| `GGUI_OPENAI_PORT`                  | optional | Override the openai ggui port (default `6787`).                                                        |
| `GGUI_GOOGLE_PORT`                  | optional | Override the google ggui port (default `6788`).                                                        |
| `SAMPLE_PORT_CLAUDE/OPENAI/GOOGLE`  | optional | Per-SDK chat-UI ports for scenario 6 (defaults `6790/6791/6792`; legacy `SAMPLE_PORT` aliases CLAUDE). |

## CI Tier Classification (#478)

Every spec file in `tests/`, classified. Per
[No Silent Block](../../../docs/principles/no-silent-block.md), a test
not exercised by any CI tier is a silent gate — this table is the
durable record of which tier (if any) each file lands in, so the next
new spec has an obvious place to go and the next reviewer can see at a
glance whether a file's absence from CI is deliberate or a gap.

| #   | Scenario                             | CI tier                                  | Why                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --- | ------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 01  | submit_action happy path             | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)` — real cold-gen render. Skips cleanly without a key, but no job invokes this file today.                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| 02  | PIPE_NOT_FOUND is terminal           | **keyless sweep**                        | No LLM, no browser — pure MCP dispatch-to-unknown-session assertion.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 03  | contextSnapshot bundle               | provider matrix (`matrix` job)           | `providerSkip()` — model-provider axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 04  | CONTEXT_TOO_LARGE rejection          | **keyless sweep**                        | No LLM — a context-size gate assertion against the running MCP server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 05  | pure-display render (no actionSpec)  | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)` — real render. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 06  | sample-agent + todo real-data        | provider matrix (`matrix` job)           | `providerSkip()` — agent-framework axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 07  | full round-trip todo toggle          | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)`. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 08  | cached render (warm path)            | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)` — priming render needs a real cold-gen. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 09  | A2UI streaming                       | provider matrix (`matrix` job)           | `providerSkip()` — model-provider axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 10  | no-consumer nudge                    | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)`. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 11  | handshake negotiator plumbing        | provider matrix (`matrix` job)           | `providerSkip()` — model-provider axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 12  | ggui_update props                    | provider matrix (`matrix` job)           | `providerSkip()` — model-provider axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 14  | `ggui_emit` toast                    | **excluded — needs a code fix**          | Drives a REAL sample agent (`spawnSampleAgent`/`startChat`, `fixtures/agent-driver.ts`) — genuinely needs `ANTHROPIC_API_KEY` — but carries **no** `describe.skipIf` guard at all. Running it keyless would hard-fail, not skip. Needs a `HAS_KEY`/`skipIf` guard (or a `providerSkip()` row) added before it can join any tier — a spec code change, out of this sweep's touch scope (workflow YAML + docs/config only). Flagged, not fixed here.                                                                                                                                                           |
| 15  | ggui_update replace/merge            | provider matrix (`matrix` job)           | `providerSkip()` — model-provider axis row.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 16  | cache admin invalidate               | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)`. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 17  | cold path then cache                 | key-gated, not wired                     | `describe.skipIf(!ANTHROPIC_API_KEY)`. Same gap as 01.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 18  | warm path via `/control` register    | **keyless sweep**                        | Docstring: "zero-LLM priming" — pre-built bytes via `ggui_ops_register_blueprint`, no generation call.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 19  | gadget registry-membership gate      | **keyless sweep**                        | No LLM — `ggui_list_gadgets` + a `ggui_render` membership-gate assertion against the running MCP server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 20  | public env channel gate              | **excluded — pre-existing failing test** | 3 of 4 tests pass keylessly; `render with satisfied requires succeeds + bootstrap carries projected publicEnv` fails with `expected undefined to be defined` on `bootstrap?.publicEnv` — reproduced identically WITH and WITHOUT provider keys present, so it is unrelated to key-gating. Likely drift in the `_meta["ai.ggui/render"]`/bootstrap projection path (`oss/packages/mcp-server-handlers/src/renders/`) since this test last passed. Needs investigation by whoever owns that path before this file can join an always-green tier — flagged, not fixed here (out of touch scope for this sweep). |
| 21  | marketplace gadget lifecycle         | **keyless sweep**                        | `bootRegistryServer()` in-process, sigstore-mock public lane. The direct precedent for 22/25/26.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 22  | marketplace blueprint lifecycle      | **keyless sweep**                        | Same as 21, blueprint lane.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 25  | component-gadget registry round-trip | **keyless sweep**                        | No LLM — component-gadget wire path against the running `ggui-leaflet-demo` MCP server.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 26  | by-tool discovery journey (#477)     | **keyless sweep**                        | `bootRegistryServer()` in-process, sigstore-mock public lane — the template this sweep job followed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

**Bold = wired into a CI tier as of #478.** `key-gated, not wired` files
(01/05/07/08/10/16/17) already carry correct in-file skip gating with a
documented reason at each gate (`describe.skipIf(!HAS_KEY)`, docstring
explains why) — they are not silently gated in the "no reason given"
sense, but no job invokes them, so they're never actually exercised
even when a key IS present. Folding them into the `matrix` job would
need each file ported from its bespoke `HAS_KEY` check to the
REQUIRE_ALL-aware `providerSkip()` helper for consistency with that
job's nightly hard-fail semantics — a spec code change, and a real
LLM-cost increase to the nightly run — deliberately left as a separate
follow-up rather than folded into this sweep.

## Run

```bash
# All scenarios — rows whose API key isn't set skip cleanly.
pnpm --filter @ggui-ai/e2e-wire-scenarios test

# Anthropic rows only (matches the pre-matrix behavior).
ANTHROPIC_API_KEY=sk-... pnpm --filter @ggui-ai/e2e-wire-scenarios test

# Full matrix — every row runs against its provider's ggui instance + sample agent.
ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
  pnpm --filter @ggui-ai/e2e-wire-scenarios test

# Full matrix + hard-fail on missing keys (the label-gated / nightly CI mode).
GGUI_E2E_REQUIRE_ALL_PROVIDERS=1 ANTHROPIC_API_KEY=... OPENAI_API_KEY=... GEMINI_API_KEY=... \
  pnpm --filter @ggui-ai/e2e-wire-scenarios test

# Single scenario
pnpm --filter @ggui-ai/e2e-wire-scenarios exec vitest run tests/04-context-too-large.spec.ts
```

## Services

`fixtures/global-setup.ts` boots the long-lived services before the suite and tears them down at the end:

- `@ggui-samples/ggui-default` on `:6781` — anthropic-keyed ggui MCP + renderer (always booted)
- `@ggui-samples/ggui-default` on `:6787` — openai-keyed ggui (booted only when `OPENAI_API_KEY` is set; `providerOnlyEnv()` clears other provider keys so the CLI's boot scan locks to openai)
- `@ggui-samples/ggui-default` on `:6788` — google-keyed ggui (booted only when `GEMINI_API_KEY` is set)
- `@ggui-samples/mcp-todo` on `:6782` — todo CRUD MCP for real-data assertions
- Plus the gadget-demo gguis (`mapbox-demo`, `leaflet-demo`, `canvas-demo`, …) for the gadget-axis scenarios.

If a port is already in use (developer running `pnpm dev` in another terminal), the fixture REUSES it. `CI=1` forces a clean boot.

Sample agents (`@ggui-samples/agent-claude-sdk` / `agent-openai-sdk` / `agent-google-adk`) are NOT booted at the suite level — scenario 6 spawns each on demand inside its matrix row so the rest of the suite isn't blocked by missing per-SDK keys.

## Fixtures

- `fixtures/mcp-client.ts` — JSON-RPC tools/call helper with SSE/JSON normalization
- `fixtures/render-contract.ts` — drives the handshake → render chain with a verbatim contract
- `fixtures/browser.ts` — tiny wrapper over `playwright-core` chromium
- `fixtures/global-setup.ts` — service boot + teardown
