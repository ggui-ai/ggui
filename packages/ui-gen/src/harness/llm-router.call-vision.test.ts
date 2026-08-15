/**
 * #504 — the visual evaluator's multimodal calls previously
 * constructed provider SDK clients inline, outside `apiCall()`: 429s
 * got no retry, `onRetry` never fired, and `routeOverride` never
 * reached the call. `callVision` closes all three at the router. These
 * tests pin the closure the same way the #489 suite does — by driving
 * the real agents against a client whose `create` call is forced to
 * fail, asserting on retry counts, observer emissions, and model
 * resolution rather than on mocked response internals.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import {
  AnthropicAgent,
  GoogleAgent,
  createVisionAgent,
  type AgentConfig,
  type ProviderRetryInfo,
  type VisionImageInput,
} from './llm-router.js';

const IMAGE: VisionImageInput = { mediaType: 'image/png', base64: 'aWNvbg==' };

/** Shapes a fake SDK error exactly like `@anthropic-ai/sdk`'s APIError:
 *  `.status` + a `Headers`-like `.headers` with `.get()`. */
function makeSdkError(
  status: number,
  retryAfterHeader?: string,
): Error & { status: number; headers: { get(name: string): string | null } } {
  const err = new Error(
    `${status} {"type":"error","error":{"type":"rate_limit_error"}}`,
  ) as Error & {
    status: number;
    headers: { get(name: string): string | null };
  };
  err.status = status;
  err.headers = {
    get: (name: string) =>
      name.toLowerCase() === 'retry-after' ? (retryAfterHeader ?? null) : null,
  };
  return err;
}

/** Google's `ApiError` shape — `.status` present, `.headers` absent. */
function makeSdkErrorNoHeaders(status: number): Error & { status: number } {
  const err = new Error(`${status} rate limited`) as Error & { status: number };
  err.status = status;
  return err;
}

/** AnthropicAgent whose client is a real SDK instance with `messages.create` forced to reject. */
class RateLimitedAnthropicAgent extends AnthropicAgent {
  readonly createSpy: ReturnType<typeof vi.fn>;
  private readonly sdkClient: Anthropic;

  constructor(error: Error, onRetry?: AgentConfig['onRetry']) {
    super(undefined, onRetry);
    this.sdkClient = new Anthropic({ apiKey: 'test-key' });
    this.createSpy = vi.fn().mockRejectedValue(error);
    vi.spyOn(this.sdkClient.messages, 'create').mockImplementation(this.createSpy);
  }

  protected async createClient(): Promise<Anthropic> {
    return this.sdkClient;
  }
}

/** GoogleAgent whose client is a real SDK instance with `models.generateContent` forced to reject. */
class RateLimitedGoogleAgent extends GoogleAgent {
  readonly createSpy: ReturnType<typeof vi.fn>;
  private readonly sdkClient: GoogleGenAI;

  constructor(error: Error, onRetry?: AgentConfig['onRetry']) {
    super(undefined, onRetry);
    this.sdkClient = new GoogleGenAI({ apiKey: 'test-key' });
    this.createSpy = vi.fn().mockRejectedValue(error);
    vi.spyOn(this.sdkClient.models, 'generateContent').mockImplementation(this.createSpy);
  }

  protected async createClient(): Promise<GoogleGenAI> {
    return this.sdkClient;
  }
}

describe('callVision — provider-429 retry + onRetry (#504 closes the #489 gap)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Anthropic: a rate-limited vision call retries inside apiCall() and emits onRetry per attempt', async () => {
    const retries: ProviderRetryInfo[] = [];
    const err = makeSdkError(429, '1');
    const agent = new RateLimitedAnthropicAgent(err, (info) => retries.push(info));

    const promise = agent.callVision('claude-haiku-4-5', 'sys', 'user', IMAGE);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(promise).rejects.toBe(err);

    // 1 initial + 2 retries — the #489 budget, previously unreachable
    // from the visual evaluator's inline-client call.
    expect(agent.createSpy).toHaveBeenCalledTimes(3);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({
      provider: 'anthropic',
      attempt: 1,
      status: 429,
      retryAfterSec: 1,
    });
  });

  it('Google: a rate-limited vision call (headerless error shape) retries and emits onRetry', async () => {
    const retries: ProviderRetryInfo[] = [];
    const err = makeSdkErrorNoHeaders(429);
    const agent = new RateLimitedGoogleAgent(err, (info) => retries.push(info));

    const promise = agent.callVision('gemini-3-flash-preview', 'sys', 'user', IMAGE);
    promise.catch(() => {});
    await vi.advanceTimersByTimeAsync(30_000);
    await expect(promise).rejects.toBe(err);

    expect(agent.createSpy).toHaveBeenCalledTimes(3);
    expect(retries).toHaveLength(2);
    expect(retries[0]).toMatchObject({ provider: 'google', attempt: 1, status: 429 });
  });

  it('a non-429 vision error throws immediately — no retry, no onRetry', async () => {
    const retries: ProviderRetryInfo[] = [];
    const err = makeSdkError(401);
    const agent = new RateLimitedAnthropicAgent(err, (info) => retries.push(info));

    await expect(agent.callVision('claude-haiku-4-5', 'sys', 'user', IMAGE)).rejects.toBe(err);
    expect(agent.createSpy).toHaveBeenCalledTimes(1);
    expect(retries).toHaveLength(0);
  });
});

describe('callVision — model resolution goes through resolveModel()', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('Anthropic strips the `anthropic/` transport prefix', async () => {
    const agent = new RateLimitedAnthropicAgent(makeSdkError(401));
    await agent.callVision('anthropic/claude-haiku-4-5', 'sys', 'user', IMAGE).catch(() => {});
    expect(agent.createSpy).toHaveBeenCalledTimes(1);
    expect(agent.createSpy.mock.calls[0][0]).toMatchObject({ model: 'claude-haiku-4-5' });
  });

  it('Google strips the `gemini/` transport prefix (the slice-#43 convention — the inline call stripped `google/` instead)', async () => {
    const agent = new RateLimitedGoogleAgent(makeSdkErrorNoHeaders(400));
    await agent.callVision('gemini/gemini-3-flash-preview', 'sys', 'user', IMAGE).catch(() => {});
    expect(agent.createSpy).toHaveBeenCalledTimes(1);
    expect(agent.createSpy.mock.calls[0][0]).toMatchObject({ model: 'gemini-3-flash-preview' });
  });
});

describe('createVisionAgent — routeOverride threading (#484 contract)', () => {
  const savedEnv = { ...process.env };
  beforeEach(() => {
    process.env.ANTHROPIC_API_KEY = 'env-key-should-not-be-used';
  });
  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('threads routeOverride.apiKey to the real Anthropic client factory, not process.env', async () => {
    const spy = vi.spyOn(
      await import('../adapters/claude/client.js'),
      'createAnthropicClient',
    );
    const agent = createVisionAgent({
      provider: 'anthropic',
      model: 'claude-haiku-4-5',
      routeOverride: { apiKey: 'override-key-vision' },
    });
    await agent.callVision('claude-haiku-4-5', 'sys', 'user', IMAGE).catch(() => {
      // Expected — no real network access in this test; the assertion
      // is on how the client was CONSTRUCTED, not on a successful call.
    });
    expect(spy).toHaveBeenCalledWith('override-key-vision');
  });
});
