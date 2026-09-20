import type { AdapterResult } from '../types';

/**
 * Split an OpenAI usage report into the shared cross-adapter token
 * convention (ggui#1186).
 *
 * OpenAI reports the cached prompt tokens as a SUBSET already counted
 * inside its input token total (`usage.input_tokens` on the Responses
 * API, `usage.inputTokens` on the Agents SDK, both INCLUDING cached
 * tokens). Anthropic (and OpenRouter's Anthropic passthrough) instead
 * report `input_tokens` EXCLUDING cache reads, with cache reads as a
 * separate field.
 *
 * The whole fleet reads one convention: **`tokens.input` is the
 * NON-cached input; `cacheReadTokens` is the cache-hit subset.** Cost
 * and observability consumers price/aggregate `input` at the full input
 * rate and `cacheReadTokens` at the cache-read rate, so the cached
 * portion must appear in exactly one of the two — never both. Reporting
 * OpenAI's cache-inclusive `input_tokens` as `tokens.input` while also
 * populating `cacheReadTokens` would double-count the cached tokens (it
 * inflates `$/gen` and breaks `render_cache_metric`'s `cacheReadPct`
 * denominator). So the OpenAI adapters subtract the cached subset here.
 *
 * `total` is the full processed footprint (non-cached input + cache
 * reads + output = `inputTokensInclCached + outputTokens`), matching the
 * Claude adapter's `total` (input + cacheCreation + cacheRead + output);
 * OpenAI has no explicit cache-creation step, so there is no
 * `cacheCreationTokens` term.
 */
export function splitOpenAiUsage(
  inputTokensInclCached: number,
  outputTokens: number,
  cachedTokens: number,
): { tokens: AdapterResult['tokens']; cacheReadTokens: number } {
  return splitCacheInclusiveUsage(inputTokensInclCached, outputTokens, cachedTokens);
}

/**
 * The provider-neutral form of the split above (ggui#1186, third site): any
 * provider whose reported input token count INCLUDES the cached part of the
 * prompt — OpenAI's `input_tokens` + `input_tokens_details.cached_tokens`,
 * Gemini's `total_input_tokens` + `total_cached_tokens` and
 * `promptTokenCount` + `cachedContentTokenCount` ("the cached part of the
 * prompt", per the SDK) — is split the same way into the non-cached input and
 * the cached subset, so `input` is never double-counted and `total` stays the
 * full footprint.
 */
export function splitCacheInclusiveUsage(
  inputTokensInclCached: number,
  outputTokens: number,
  cachedTokens: number,
): { tokens: AdapterResult['tokens']; cacheReadTokens: number } {
  // Never let a malformed usage report drive input negative.
  const cacheRead = Math.min(
    Math.max(cachedTokens, 0),
    Math.max(inputTokensInclCached, 0),
  );
  const nonCachedInput = Math.max(inputTokensInclCached, 0) - cacheRead;
  return {
    tokens: {
      input: nonCachedInput,
      output: outputTokens,
      total: nonCachedInput + cacheRead + outputTokens,
    },
    cacheReadTokens: cacheRead,
  };
}
