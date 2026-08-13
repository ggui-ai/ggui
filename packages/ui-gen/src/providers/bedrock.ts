/**
 * Concrete AWS Bedrock `ProviderAdapter` — invokes Anthropic Claude
 * models on Bedrock via the official `@anthropic-ai/bedrock-sdk`
 * package. IAM-based auth (no API key in flight); the AWS credential
 * chain (IRSA pod token / `~/.aws/credentials` / env vars) supplies
 * SigV4 signatures automatically.
 *
 * ## Why this adapter exists
 *
 * Anyone running the generator on an AWS-credentialed host (EC2, ECS,
 * Lambda, EKS) can target Bedrock without managing API keys: IAM is
 * the auth boundary, AWS rotates host credentials automatically, and
 * a misconfigured IAM role surfaces as a clear `AccessDeniedException`
 * the SDK funnels through `mapError`. The alternative — parking a
 * provider API key in a secrets store and lazily fetching it on first
 * render — works but adds operational surface (a seed ceremony,
 * key-rotation discipline, a misconfig mode where the secret is
 * empty); Bedrock removes all of it.
 *
 * ## Wire shape
 *
 * The Bedrock SDK's `client.messages.create(...)` mirrors the direct
 * Anthropic API surface 1:1 — same request body fields (`model`,
 * `max_tokens`, `system`, `messages`), same response shape (`content[]`
 * with `{type:'text', text}` blocks, `stop_reason`, `usage`). Both
 * adapters therefore share ONE success-envelope parser —
 * {@link parseAnthropicMessagesResponse} in `./anthropic-wire.ts`.
 * Streaming is supported by the SDK
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
 * Callers pass a sentinel (e.g. `'bedrock-iam'`) so the model-id
 * check still gates on a non-empty value. Future work could add the
 * discriminator if a third auth mode (e.g. cross-account assume-role)
 * lands.
 *
 * ## Model IDs — pass-through, endpoint chosen by ID shape
 *
 * Bedrock serves Anthropic models through TWO endpoints with DISJOINT
 * model-id namespaces (live-probed against us-east-1, 2026-08-13):
 *
 *   - **bedrock-runtime** (`AnthropicBedrock`): serves ONLY
 *     cross-region inference-profile ids —
 *     `us.anthropic.claude-haiku-4-5-20251001-v1:0` etc. Bare
 *     `anthropic.*` foundation ids are rejected with 400
 *     "on-demand throughput isn't supported".
 *   - **Messages-API endpoint / Mantle** (`AnthropicBedrockMantle`):
 *     serves ONLY region-less `anthropic.*` ids —
 *     `anthropic.claude-opus-5`, `anthropic.claude-haiku-4-5`. The
 *     Claude 5 family and Opus 4.8 exist ONLY here. Profile ids are
 *     rejected with 404. Requires the account to have enabled Claude
 *     in Amazon Bedrock (otherwise every id 403s "not available for
 *     this account").
 *
 * Because the namespaces never overlap, the adapter routes each
 * request by shape: ids starting `anthropic.` go to Mantle, region-
 * prefixed ids (`us.` / `eu.` / `apac.` / `global.`) go to
 * bedrock-runtime. The id itself passes through untranslated —
 * supply a Bedrock id, not a direct-API model name.
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
import { AnthropicBedrock, AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  makeProviderError,
  statusToErrorKind,
  type ProviderAdapter,
  type ProviderError,
  type ProviderRequest,
  type ProviderResult,
  type ProviderValidation,
} from '../provider-adapter.js';
import { parseAnthropicMessagesResponse } from './anthropic-wire.js';
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
 * Which Bedrock endpoint a model id resolves to. The namespaces are
 * disjoint (see the docstring above), so the shape of the id fully
 * determines the endpoint — no configuration knob needed.
 */
export type BedrockEndpoint = 'runtime' | 'mantle';

/**
 * Structural slice of the two SDK clients the adapter actually drives —
 * the seam that lets tests inject a stub without standing up a real
 * AWS client. Both `AnthropicBedrock` and `AnthropicBedrockMantle`
 * satisfy it (the adapter's single-completion contract only ever calls
 * non-streaming `messages.create`; the response is parsed from
 * `unknown` by `parseAnthropicMessagesResponse`, so the SDK's
 * version-volatile `Message` type is deliberately not part of the
 * seam).
 */
export interface BedrockMessagesClient {
  readonly messages: {
    create(
      body: {
        model: string;
        max_tokens: number;
        system?: string;
        messages: Array<{ role: 'user'; content: string }>;
      },
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
  };
}

/**
 * Route a Bedrock model id to its serving endpoint. Region-less
 * `anthropic.*` ids exist only on the Messages-API (Mantle) endpoint;
 * everything else (region-prefixed inference profiles, ARNs) belongs
 * to bedrock-runtime.
 */
export function bedrockEndpointFor(model: string): BedrockEndpoint {
  return model.startsWith('anthropic.') ? 'mantle' : 'runtime';
}

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
   * mock or stub client without actually hitting AWS. Called with the
   * endpoint the request's model id routed to (`'runtime'` →
   * `AnthropicBedrock`, `'mantle'` → `AnthropicBedrockMantle`).
   * Production callers leave this unset; the adapter constructs the
   * real client lazily on first `complete(...)` call per endpoint.
   */
  readonly clientFactory?: (
    region: string,
    endpoint: BedrockEndpoint,
  ) => BedrockMessagesClient;
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
    options.clientFactory ??
    ((r: string, endpoint: BedrockEndpoint): BedrockMessagesClient =>
      endpoint === 'mantle'
        ? new AnthropicBedrockMantle({ awsRegion: r })
        : new AnthropicBedrock({ awsRegion: r }));

  const cachedClients: Partial<Record<BedrockEndpoint, BedrockMessagesClient>> = {};
  function getClient(endpoint: BedrockEndpoint): BedrockMessagesClient {
    const cached = cachedClients[endpoint];
    if (cached) return cached;
    const created = clientFactory(region, endpoint);
    cachedClients[endpoint] = created;
    return created;
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
     * API key — `request.apiKey` is ignored (callers pass a sentinel
     * like `'bedrock-iam'` so the type contract holds).
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

      const client = getClient(bedrockEndpointFor(request.route.model));
      // The SDK's `Message` return type drifts between
      // `@anthropic-ai/sdk` versions (pnpm hoists multiple copies in
      // this workspace today). We type the captured value as
      // `unknown` here and let `parseAnthropicMessagesResponse`
      // validate the narrow shape we actually consume — fields beyond
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

      // Success-envelope parsing is shared with the direct-API
      // adapter — Bedrock's Anthropic-flavored endpoint returns the
      // identical envelope as `api.anthropic.com/v1/messages`. See
      // `./anthropic-wire.ts`. (Takes `unknown` rather than the SDK's
      // `Message` type so the adapter is robust to SDK version drift
      // across pnpm-hoisted copies — see the failure-mapping
      // docstring above for context.)
      const parsed = parseAnthropicMessagesResponse(raw, PROVIDER);
      if (!parsed.ok) return { ok: false, error: parsed.error };
      return { ok: true, response: parsed.response };
    },
  };
}
