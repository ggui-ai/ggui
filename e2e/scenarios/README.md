# @ggui-private/e2e-scenarios

Canonical end-to-end scenario suite for the ggui protocol. Vitest-driven full-stack journeys against the OSS samples — pins the wire's behavioral contract so a regression in any layer (protocol, handlers, iframe-runtime, MCP server, samples) trips the suite.

## Why vitest + playwright-core (not @playwright/test)

The workspace runs with `node-linker=hoisted` in `.npmrc` (required for AWS Amplify Hosting monorepo SSR builds). That breaks `@playwright/test`'s singleton-module invariant — the runner and the test files end up importing different physical copies of `@playwright/test`, even at the same version, and you get `Playwright Test did not expect test() to be called here` errors.

Vitest doesn't have this problem (it doesn't rely on singleton module identity), and `playwright-core` (the gadget) drives Chromium directly. Same coverage, runs cleanly under our hoist config. Matches `@ggui-ai/ui-visual-tester`'s existing pattern.

## What it tests

| #   | Scenario                                     | Needs LLM | Notes                                                                    |
| --- | -------------------------------------------- | --------- | ------------------------------------------------------------------------ |
| 1   | submit_action happy path                     | ✅        | push contract with actionSpec → click → consume drains event             |
| 2   | PIPE_NOT_FOUND fallback                      | ✅        | push → pop → click → asserts ui/message postMessage fires                |
| 3   | contextSnapshot bundle                       | ✅        | push w/contextSpec → sync_context → click → consume returns the snapshot |
| 4   | CONTEXT_TOO_LARGE rejection                  | ❌        | sync_context with oversize snapshot → asserts CONTEXT_TOO_LARGE          |
| 5   | pure-display push (no actionSpec)            | ✅        | push w/o actionSpec → asserts no nextStep                                |
| 6   | sample-agent + todo MCP real-data round trip | ✅        | full-stack: prompt → todo_add → state mutates → re-push                  |

LLM-required scenarios gate on `ANTHROPIC_API_KEY` via `describe.skipIf(!HAS_KEY)`. CI sets the key; local dev can run scenario 4 offline.

## Run

```bash
# All scenarios (scenario 4 runs, others skip without key)
pnpm --filter @ggui-private/e2e-scenarios test

# With LLM
ANTHROPIC_API_KEY=sk-... pnpm --filter @ggui-private/e2e-scenarios test

# Single scenario
pnpm --filter @ggui-private/e2e-scenarios exec vitest run tests/04-context-too-large.spec.ts
```

## Services

`fixtures/global-setup.ts` boots two long-lived services before the suite and tears them down at the end:

- `@ggui-samples/ggui-default` on `:6781` — ggui MCP server + renderer
- `@ggui-samples/mcp-todo` on `:6782` — todo CRUD MCP for real-data assertions

If either port is already in use (developer running `pnpm dev` in another terminal), the fixture REUSES it. CI=1 forces a clean boot.

The sample agent (`@ggui-samples/agent-claude-sdk` on `:6790`) is NOT booted at the suite level — scenario 6 starts it on demand so the rest of the suite isn't blocked when API key is missing.

## Fixtures

- `fixtures/mcp-client.ts` — JSON-RPC tools/call helper with SSE/JSON normalization
- `fixtures/push-contract.ts` — drives the new_session → handshake → push chain with a verbatim contract
- `fixtures/browser.ts` — tiny wrapper over `playwright-core` chromium
- `fixtures/global-setup.ts` — service boot + teardown
