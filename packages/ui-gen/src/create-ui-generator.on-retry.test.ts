import { describe, expect, it } from "vitest";
import { createAgent } from "./harness/llm-router.js";

// This is a narrow unit test of the wiring shape, not an end-to-end
// generation — `createUiGenerator()`'s generate() pulls in the full
// coding-agent harness, which is exercised by the harness's own
// integration tests. Here we confirm only that the exact mechanism
// Task 4 wires — createAgent({ ..., onRetry }) — accepts the config
// shape without throwing. It deliberately does NOT trigger a 429 or
// assert the observer fires: onRetry is a `protected readonly` field
// and apiCall() is `protected`, so an external caller has no seam to
// observe the retry loop itself — that is covered exhaustively by
// llm-router.retry-429.test.ts (constructing agents directly via
// `new TestAgent(routeOverride, onRetry)`), and the eval-leg wiring
// (a real drop this construction-only test could never have caught)
// by run-eval-round.test.ts's routeOverride + onRetry threading test.
describe("onRetry factory option — construction path (#489)", () => {
  it("createAgent(config) accepts onRetry on the construction path", () => {
    const agent = createAgent({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      onRetry: () => {},
    });
    expect(agent.provider).toBe("anthropic");
  });
});
