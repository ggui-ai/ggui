# @ggui-ai/e2e-wire-scenarios

Canonical end-to-end scenario suite for the ggui protocol. Vitest-driven full-stack journeys against the OSS samples — pins the wire's behavioral contract so a regression in any layer (protocol, handlers, iframe-runtime, MCP server, samples) trips the suite.

## Why vitest + playwright-core (not @playwright/test)

The workspace runs with `node-linker=hoisted` in `.npmrc` (required for AWS Amplify Hosting monorepo SSR builds). That breaks `@playwright/test`'s singleton-module invariant — the runner and the test files end up importing different physical copies of `@playwright/test`, even at the same version, and you get `Playwright Test did not expect test() to be called here` errors.

Vitest doesn't have this problem (it doesn't rely on singleton module identity), and `playwright-core` (the gadget) drives Chromium directly. Same coverage, runs cleanly under our hoist config. Matches `@ggui-ai/ui-visual-tester`'s existing pattern.

## What it tests

The suite has 25+ scenarios pinning the wire's behavioral contract. The flagship integration tests are listed below; the rest follow the same shape (Vitest `describe` + Playwright-core browser) and live under `tests/`.

| #   | Scenario                                     | Needs LLM | Notes                                                                    |
| --- | -------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| 1   | submit_action happy path                     | ✅        | push contract with actionSpec → click → consume drains event             |
| 2   | PIPE_NOT_FOUND fallback                      | ✅        | push → pop → click → asserts ui/message postMessage fires                |
| 3   | contextSnapshot bundle                       | ✅        | push w/contextSpec → sync_context → click → consume returns the snapshot |
| 4   | CONTEXT_TOO_LARGE rejection                  | ❌        | sync_context with oversize snapshot → asserts CONTEXT_TOO_LARGE          |
| 5   | pure-display push (no actionSpec)            | ✅        | push w/o actionSpec → asserts no nextStep                                |
| 6   | sample-agent + todo MCP real-data round trip | ✅        | full-stack: prompt → todo_add → state mutates → re-push                  |

### Provider matrix

LLM scenarios fan out across two **orthogonal** axes:

- **Agent-framework axis** (scenario 6 only) — one row per reference sample agent: `claude-agent-sdk` (Anthropic), `openai-agents-sdk` (OpenAI), `google-adk` (Gemini). Each row spawns its own sample on its own port (6790 / 6791 / 6792) and natural-pairs with the matching ggui-default instance below.
- **Model-provider axis** (scenarios 03 / 09 / 11 / 12 / 15) — one row per ggui-default instance (`anthropic` / `openai` / `google`). No agent in the loop; the test drives `push-contract` directly against the matching MCP endpoint.

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
- `fixtures/push-contract.ts` — drives the new_session → handshake → push chain with a verbatim contract
- `fixtures/browser.ts` — tiny wrapper over `playwright-core` chromium
- `fixtures/global-setup.ts` — service boot + teardown
