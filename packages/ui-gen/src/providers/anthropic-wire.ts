/**
 * Shared parser for the Anthropic Messages success envelope.
 *
 * Two adapters consume the SAME wire shape: the direct-API adapter
 * (`./anthropic.ts`, `POST api.anthropic.com/v1/messages`) and the
 * Bedrock adapter (`./bedrock.ts` — Bedrock's Anthropic-flavored
 * endpoint returns the identical envelope). One parser, two callers;
 * the only per-adapter variance is the `provider` prefix on error
 * messages.
 *
 * Takes `unknown` (rather than any SDK `Message` type) so callers are
 * robust to SDK version drift across pnpm-hoisted copies.
 */
import type { LlmProvider } from '@ggui-ai/mcp-server-core';
import {
  makeProviderError,
  type ProviderError,
  type ProviderResponse,
} from '../provider-adapter.js';

/**
 * Parse an Anthropic Messages response body into the normalized
 * {@link ProviderResponse} shape.
 *
 * `stop_reason` → `finishReason` normalization:
 *
 *   - `end_turn` / `stop_sequence`  → `'stop'`
 *   - `max_tokens`                  → `'length'`
 *   - everything else               → `'other'` (`tool_use`,
 *     `pause_turn`, `refusal`, future stop reasons all bucket here —
 *     content-filter surfaces via 4xx errors on Anthropic, not
 *     `stop_reason`)
 */
export function parseAnthropicMessagesResponse(
  raw: unknown,
  provider: LlmProvider,
):
  | { ok: true; response: ProviderResponse }
  | { ok: false; error: ProviderError } {
  if (!raw || typeof raw !== 'object') {
    return {
      ok: false,
      error: makeProviderError({
        kind: 'invalid-response',
        provider,
        message: `${provider}: response body was not an object`,
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
        provider,
        message: `${provider}: response missing \`content\` array`,
      }),
    };
  }

  // Concatenate every text block. Anthropic sometimes splits a
  // response across multiple text blocks; tool_use / thinking blocks
  // (when present) are filtered out — the single-completion contract
  // here doesn't surface them.
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
