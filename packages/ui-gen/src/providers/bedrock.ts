/**
 * Concrete AWS Bedrock `ProviderAdapter` — invokes Anthropic Claude
 * models on Bedrock via the official `@anthropic-ai/bedrock-sdk`
 * package. IAM-based auth (no API key in flight); the AWS credential
 * chain (IRSA pod token / `~/.aws/credentials` / env vars) supplies
 * SigV4 signatures automatically.
 *
 * ## Why this adapter exists
 *
 * The hosted ggui pod (`mcp.ggui.ai`) needs a free-credit "pool" path
 * for end-users who haven't supplied a BYOK key. The earlier design
 * landed an Anthropic API key in AWS Secrets Manager + a lazy fetch on
 * first pool render; that worked but added operational surface
 * (operator-seed ceremony, key-rotation discipline, a misconfig mode
 * where the secret was empty). Bedrock removes all of it: IAM is the
 * auth boundary, AWS rotates IRSA credentials automatically, and a
 * misconfigured IAM role surfaces as a clear `AccessDeniedException`
 * the SDK funnels through `mapError`.
 *
 * OSS users get the same adapter — anyone running the generator on an
 * AWS-credentialed host (EC2, ECS, Lambda, EKS) can target Bedrock
 * without managing API keys.
 *
 * ## Wire shape
 *
 * The Bedrock SDK's `client.messages.create(...)` mirrors the direct
 * Anthropic API surface 1:1 — same request body fields (`model`,
 * `max_tokens`, `system`, `messages`), same response shape (`content[]`
 * with `{type:'text', text}` blocks, `stop_reason`, `usage`). That
 * means the response-parsing logic mirrors {@link parseAnthropicResponse}
 * in `./anthropic.ts` exactly. Streaming is supported by the SDK
 * (`client.messages.stream(...)` returns an async iterable) but this
 * adapter uses the non-streaming `create(...)` call to match the
 * single-completion {@link ProviderAdapter} contract; higher layers
 * (`UiGenerator`) compose multi-turn loops above the seam.
 *
 * ## Auth — no API key in `ProviderRequest`
 *
 * The {@link ProviderAdapter} contract types `ProviderRequest.apiKey`
 * as a required string because direct API providers need it on the
 * wire. Bedrock doesn't — the SDK signs requests with AWS credentials
 * resolved at process boot. Two compatible options were considered:
 *
 *   1. Add an `auth: 'apiKey' | 'iam'` discriminator to
 *      `ProviderAdapter` + thread it through every adapter.
 *   2. Override `validateConfig` so this adapter accepts (and ignores)
 *      whatever the caller puts in `apiKey` — `'iam'` / sentinel /
 *      empty string all pass.
 *
 * Option 2 wins on cost: ZERO callers, contract, or tests change.
 * The pod-generator passes a sentinel (`'bedrock-iam'`) so the model-
 * id check still gates on a non-empty value. Future work could add
 * the discriminator if a third auth mode (e.g. cross-account assume-
 * role for enterprise BYOK) lands.
 *
 * ## Model IDs — pass-through
 *
 * Bedrock and the direct Anthropic API use OVERLAPPING but DISTINCT
 * model id namespaces:
 *
 *   - Direct API: `claude-haiku-4-5`, `claude-opus-4-7`, etc.
 *   - Bedrock foundation models: `anthropic.claude-3-5-sonnet-20241022-v2:0`
 *   - Bedrock cross-region inference profiles: `us.anthropic.claude-3-5-sonnet-20241022-v2:0`
 *
 * The adapter passes whatever `request.model` contains straight to
 * Bedrock — translation lives in the caller (model picker, pool-default
 * config, BYOK key router). The pod-generator's `DEFAULT_POOL_MODEL`
 * already uses the Bedrock-compatible `anthropic.claude-haiku-4-5`
 * shape; OSS users supply their preferred profile id.
 *
 * ## Failure mapping
 *
 * The bedrock-sdk throws `APIError` subclasses (`AuthenticationError`,
 * `PermissionDeniedError`, `RateLimitError`, `InternalServerError`,
 * etc.) that all carry a numeric `.status` property. We classify them
 * by structural duck-typing (`typeof err.status === 'number'`) rather
 * than `instanceof Anthropic.APIError` because pnpm hoisting often
 * resolves multiple `@anthropic-ai/sdk` versions across the workspace
 * — the bedrock-sdk's nested SDK and ui-gen's direct SDK can diverge,
 * and `instanceof` then silently returns false for valid errors.
 * Duck-typing on `.status` is robust to that drift and matches the
 * SDK's documented API contract (every subclass exposes `.status`).
 *
 * Transport-shaped errors (`APIConnectionError`, `APIUserAbortError`)
 * carry NO status — they fall through to {@link classifyFetchError}
 * for the standard `network` / `aborted` mapping.
 *
 * AWS-specific failure modes (`AccessDeniedException` — wrong IAM
 * grants; `ThrottlingException` — Bedrock rate limit;
 * `ValidationException` — bad model id) all surface as `APIError`
 * subclasses in the SDK, distinguished by `.status` (403 / 429 / 400
 * respectively).
 */
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  makeProviderError,
  statusToErrorKind,
  type ProviderAdapter,
  type ProviderError,
  type ProviderRequest,
  type ProviderResponse,
  type ProviderResult,
  type ProviderValidation,
} from '../provider-adapter.js';
import { classifyFetchError } from './http.js';

/**
 * `LlmProvider` slot this adapter targets. Bedrock has its own slot
 * in the `LlmProvider` union (alongside `'anthropic'` direct API) so
 * downstream code can branch on adapter choice — pricing tables,
 * model-id namespaces, and credential-source logging all differ.
 */
const PROVIDER: LlmProvider = 'bedrock';
const DEFAULT_MAX_TOKENS = 4096;

/**
 * Constructor options for the Bedrock adapter.
 *
 * `region` is the only required option in the common case — IAM
 * credentials come from the standard AWS chain (IRSA pod token in
 * EKS, instance role on EC2, env vars or shared credentials file
 * locally). Tests pass `clientFactory` to inject a mock SDK client.
 */
export interface BedrockAdapterOptions {
  /**
   * AWS region for Bedrock invocations. Required for IAM-scoped
   * resource ARNs to resolve (model ARNs include the region;
   * cross-region inference profiles do their own internal failover
   * but the request still has to land in ONE region). Common values:
   * `'us-east-1'`, `'us-west-2'`. Reads from `process.env.AWS_REGION`
   * by default to match the rest of the AWS SDK chain.
   */
  readonly region?: string;
  /**
   * Optional client factory override — used by tests to inject a
   * mock or stub `AnthropicBedrock` client without actually hitting
   * AWS. Production callers leave this unset; the adapter constructs
   * the real client lazily on first `complete(...)` call.
   */
  readonly clientFactory?: (region: string) => AnthropicBedrock;
}

/**
 * Construct an AWS Bedrock provider adapter.
 *
 * No API key — IAM is the auth boundary. The returned `ProviderAdapter`
 * satisfies the same contract as `createAnthropicAdapter`, so it
 * slots into `createUiGenerator({ adapter })` interchangeably (modulo
 * the per-provider model-id namespace differences).
 */
export function createBedrockAdapter(
  options: BedrockAdapterOptions = {},
): ProviderAdapter {
  const region = options.region ?? process.env['AWS_REGION'] ?? 'us-east-1';
  const clientFactory =
    options.clientFactory ?? ((r: string) => new AnthropicBedrock({ awsRegion: r }));

  let cachedClient: AnthropicBedrock | null = null;
  function getClient(): AnthropicBedrock {
    if (cachedClient) return cachedClient;
    cachedClient = clientFactory(region);
    return cachedClient;
  }

  function mapError(raw: unknown): ProviderError {
    // Structural duck-typing: every SDK `APIError` subclass with a
    // server response carries a numeric `.status` property. We check
    // for that field (rather than `instanceof Anthropic.APIError`) to
    // dodge the pnpm-hoist version-drift footgun documented at the
    // top of this file. Aborted / transport errors lack `.status` and
    // fall through to `classifyFetchError`.
    if (raw && typeof raw === 'object' && 'status' in raw) {
      const status = (raw as { status: unknown }).status;
      if (typeof status === 'number' && status > 0) {
        const name = raw instanceof Error ? raw.name : 'APIError';
        const message = raw instanceof Error ? raw.message : String(raw);
        return makeProviderError({
          kind: statusToErrorKind(status),
          provider: PROVIDER,
          message: `bedrock: ${status} ${name} — ${message}`,
          status,
        });
      }
    }
    return classifyFetchError(raw, PROVIDER);
  }

  return {
    provider: PROVIDER,
    /**
     * Validate Bedrock-specific config. Differs from
     * `defaultValidateConfig` because Bedrock has NO request-level
     * API key — `request.apiKey` is ignored (the pod-generator passes
     * a sentinel like `'bedrock-iam'` so the type contract holds).
     * Only the model id is required to be non-empty; auth issues
     * surface from the SDK as `AccessDeniedException` at call time.
     */
    validateConfig(
      request: Pick<ProviderRequest, 'apiKey' | 'route'>,
    ): ProviderValidation {
      if (!request.route?.model || request.route.model.length === 0) {
        return {
          ok: false,
          error: makeProviderError({
            kind: 'client-error',
            provider: PROVIDER,
            message: 'bedrock: model id is required',
          }),
        };
      }
      return { ok: true };
    },
    mapError,
    async complete(request: ProviderRequest): Promise<ProviderResult> {
      const pre = this.validateConfig(request);
      if (!pre.ok) return { ok: false, error: pre.error };
      if (request.signal?.aborted) {
        return {
          ok: false,
          error: classifyFetchError(null, PROVIDER, request.signal),
        };
      }

      const client = getClient();
      // The SDK's `Message` return type drifts between
      // `@anthropic-ai/sdk` versions (pnpm hoists multiple copies in
      // this workspace today). We type the captured value as
      // `unknown` here and let `parseBedrockResponse` validate the
      // narrow shape we actually consume — fields beyond
      // `content` / `stop_reason` / `usage` are version-volatile
      // (thinking blocks, tool-use blocks, beta-feature additions)
      // and not load-bearing for the harness's single-completion
      // contract.
      let raw: unknown;
      try {
        raw = await client.messages.create(
          {
            model: request.route.model,
            max_tokens: request.maxTokens ?? DEFAULT_MAX_TOKENS,
            system: request.systemPrompt,
            messages: [{ role: 'user', content: request.userPrompt }],
          },
          {
            // SDK forwards `signal` into the underlying fetch — same
            // abort semantics as the direct-API adapter.
            ...(request.signal ? { signal: request.signal } : {}),
          },
        );
      } catch (err) {
        // Re-check signal first — aborted-during-await loses the abort
        // signal in the SDK's error wrapping on some runtimes.
        if (request.signal?.aborted) {
          return {
            ok: false,
            error: classifyFetchError(err, PROVIDER, request.signal),
          };
        }
        return { ok: false, error: mapError(err) };
      }

      const parsed = parseBedrockResponse(raw);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}

/**
 * Parse a Bedrock SDK response into the normalized
 * {@link ProviderResponse} shape. Mirrors `parseAnthropicResponse` in
 * `./anthropic.ts` — same wire shape on the success path because
 * Bedrock's Anthropic-flavored endpoint returns the identical
 * envelope as `api.anthropic.com/v1/messages`.
 *
 * Takes `unknown` (rather than the SDK's `Message` type) so the
 * adapter is robust to SDK version drift across pnpm-hoisted copies
 * — see the constructor docstring for context.
 */
function parseBedrockResponse(
  raw: unknown,
):
  | { ok: true; response: ProviderResponse }
  | { ok: false; error: ProviderError } {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'bedrock: response body was not an object',
      }),
    };
  }
  const obj = raw as Record<string, unknown>;
  const content = obj['content'];
  if (!Array.isArray(content)) {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider: PROVIDER,
        message: 'bedrock: response missing `content` array',
      }),
    };
  }

  // Concatenate every text block. Bedrock-via-Anthropic-SDK splits
  // text the same way the direct API does; tool_use / thinking
  // blocks (when present) are filtered out — the single-completion
  // contract here doesn't surface them.
  const text = content
    .map((block) => {
      if (!block || typeof block !== 'object') return '';
      const b = block as Record<string, unknown>;
      if (b['type'] === 'text' && typeof b['text'] === 'string') {
        return b['text'] as string;
      }
      return '';
    })
    .join('');

  const usage = obj['usage'] as Record<string, unknown> | undefined;
  const inputTokens =
    usage && typeof usage['input_tokens'] === 'number'
      ? (usage['input_tokens'] as number)
      : 0;
  const outputTokens =
    usage && typeof usage['output_tokens'] === 'number'
      ? (usage['output_tokens'] as number)
      : 0;

  const stopReason = obj['stop_reason'];
  let finishReason: ProviderResponse['finishReason'];
  if (stopReason === 'end_turn' || stopReason === 'stop_sequence') {
    finishReason = 'stop';
  } else if (stopReason === 'max_tokens') {
    finishReason = 'length';
  } else {
    // `tool_use`, `pause_turn`, `refusal`, future stop reasons all
    // bucket here. Direct-API adapter does the same — content-filter
    // is surfaced via 4xx errors on Anthropic, not stop_reason.
    finishReason = 'other';
  }

  return {
    ok: true,
    response: {
      text,
      usage: { inputTokens, outputTokens },
      finishReason,
    },
  };
}
