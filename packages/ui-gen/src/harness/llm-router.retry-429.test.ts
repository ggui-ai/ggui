import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  LLMAgent,
  type AgentConfig,
  type LLMResponse,
  type LLMToolCallResponse,
  type LLMWithToolsResponse,
  type ProviderRetryInfo,
} from "./llm-router.js";

/**
 * Minimal concrete LLMAgent — apiCall() is `protected`, so tests reach
 * it via `run()`, a public passthrough. The abstract methods are never
 * exercised here; they exist only to satisfy the base class.
 */
class TestAgent extends LLMAgent {
  readonly provider = "anthropic" as const;
  protected resolveModel(model: string): string {
    return model;
  }
  protected async createClient(): Promise<unknown> {
    return {};
  }
  async callText(): Promise<LLMResponse> {
    throw new Error("unused in this test");
  }
  async callTools(): Promise<LLMToolCallResponse> {
    throw new Error("unused in this test");
  }
  async callWithTools(): Promise<LLMWithToolsResponse> {
    throw new Error("unused in this test");
  }
  run<T>(fn: () => Promise<T>): Promise<T> {
    return this.apiCall(fn);
  }
}

/** Shapes a fake SDK error exactly like `@anthropic-ai/sdk`'s APIError:
 *  `.status` + a `Headers`-like `.headers` with `.get()`. */
function makeSdkError(
  status: number,
  retryAfterHeader?: string
): Error & { status: number; headers: { get(name: string): string | null } } {
  const err = new Error(
    `${status} {"type":"error","error":{"type":"rate_limit_error"}}`
  ) as Error & {
    status: number;
    headers: { get(name: string): string | null };
  };
  err.status = status;
  err.headers = {
    get: (name: string) =>
      name.toLowerCase() === "retry-after" ? (retryAfterHeader ?? null) : null,
  };
  return err;
}

/**
 * Shapes a fake SDK error like Google's `@google/genai` `ApiError`:
 * `.status` present, `.headers` ABSENT entirely (confirmed by reading
 * the SDK's error class — Google's `ApiError` has no `.headers`
 * property at all, unlike Anthropic's/OpenAI's `APIError`). Exercises
 * `extractRetryAfterSec`'s `!('headers' in e)` guard directly.
 */
function makeSdkErrorNoHeaders(status: number): Error & { status: number } {
  const err = new Error(`${status} rate limited`) as Error & { status: number };
  err.status = status;
  return err;
}

describe("LLMAgent.apiCall() — provider-429 retry (#489)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("does not retry a non-429 error — throws immediately", async () => {
    const agent = new TestAgent();
    const fn = vi.fn().mockRejectedValue(new Error("boom"));
    await expect(agent.run(fn)).rejects.toThrow("boom");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries a 429 with no retry-after header using exponential backoff, then succeeds", async () => {
    const agent = new TestAgent();
    const fn = vi.fn().mockRejectedValueOnce(makeSdkError(429)).mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries a 429 whose error has no .headers property at all (the Google shape) using exponential backoff — never crashes", async () => {
    const agent = new TestAgent();
    const fn = vi
      .fn()
      .mockRejectedValueOnce(makeSdkErrorNoHeaders(429))
      .mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("retries using the exact retry-after value when present and within the cap", async () => {
    const agent = new TestAgent();
    const fn = vi.fn().mockRejectedValueOnce(makeSdkError(429, "5")).mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(4999);
    expect(fn).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry when retry-after exceeds the 15s cap — throws immediately", async () => {
    const agent = new TestAgent();
    const err = makeSdkError(429, "30");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(agent.run(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up after MAX_RETRY_ATTEMPTS (2) — throws the final error", async () => {
    const agent = new TestAgent();
    const err = makeSdkError(429);
    const fn = vi.fn().mockRejectedValue(err);
    const promise = agent.run(fn);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(30000);
    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(3); // 1 initial + 2 retries
  });

  it("invokes onRetry with provider/attempt/status/retryAfterSec/delayMs on each retried attempt", async () => {
    const calls: ProviderRetryInfo[] = [];
    const config: AgentConfig = {
      provider: "anthropic",
      model: "claude-sonnet-4-6",
      onRetry: (info) => calls.push(info),
    };
    const agent = new TestAgent(config.routeOverride, config.onRetry);
    const fn = vi.fn().mockRejectedValueOnce(makeSdkError(429, "3")).mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(3000);
    await expect(promise).resolves.toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      provider: "anthropic",
      attempt: 1,
      maxAttempts: 2,
      status: 429,
      retryAfterSec: 3,
      delayMs: 3000,
    });
    expect(calls[0]?.message).toContain("429");
  });

  it("does not invoke onRetry when retry is skipped (cap exceeded)", async () => {
    const calls: ProviderRetryInfo[] = [];
    const agent = new TestAgent(undefined, (info) => calls.push(info));
    const err = makeSdkError(429, "30");
    await expect(agent.run(() => Promise.reject(err))).rejects.toBe(err);
    expect(calls).toHaveLength(0);
  });

  it("a throwing onRetry observer does not abort the retry — it is caught, logged, and the retry still completes", async () => {
    const agent = new TestAgent(undefined, () => {
      throw new Error("observer boom");
    });
    const fn = vi.fn().mockRejectedValueOnce(makeSdkError(429)).mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(2000);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("accepts a retry-after exactly at the 15s cap", async () => {
    const agent = new TestAgent();
    const fn = vi.fn().mockRejectedValueOnce(makeSdkError(429, "15")).mockResolvedValueOnce("ok");
    const promise = agent.run(fn);
    await vi.advanceTimersByTimeAsync(15000);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("rejects a retry-after one second past the 15s cap — throws immediately", async () => {
    const agent = new TestAgent();
    const err = makeSdkError(429, "16");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(agent.run(fn)).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("gives up when the 20s total retry budget would be exceeded — throws after 2 calls (not 3), onRetry invoked exactly once", async () => {
    const calls: ProviderRetryInfo[] = [];
    const err = makeSdkError(429, "12");
    const agent = new TestAgent(undefined, (info) => calls.push(info));
    const fn = vi.fn().mockRejectedValue(err);
    const promise = agent.run(fn);
    promise.catch(() => {});
    // Attempt 1 fails: totalDelayMs 0 + 12000 <= 20000 (MAX_TOTAL_RETRY_DELAY_MS)
    // → allowed, onRetry fires once, sleeps 12s. Attempt 2 fails again:
    // totalDelayMs 12000 + 12000 = 24000 > 20000 → budget exhausted, throws
    // the original error immediately — no second onRetry call, no 3rd fn() call.
    await vi.advanceTimersByTimeAsync(13000);
    await expect(promise).rejects.toBe(err);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(1);
  });
});
