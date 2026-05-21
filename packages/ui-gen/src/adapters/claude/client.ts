// packages/ui-gen/src/adapters/claude/client.ts
//
// SINGLE SOURCE OF TRUTH for Anthropic SDK construction.
//
// The BYOK resolver writes the raw credential string into
// `process.env.ANTHROPIC_API_KEY`, which the Anthropic SDK auto-reads as
// `x-api-key`. Adapters MUST go through `createAnthropicClient` (no
// inline `new Anthropic(...)`) so future header / baseURL tweaks land
// in one place.

import Anthropic from '@anthropic-ai/sdk';

/**
 * Construct an Anthropic SDK client from a raw API key string.
 *
 *   - `string` → standard `apiKey` path (sends `x-api-key`).
 *   - `undefined` → still construct a client; SDK auto-reads
 *     `process.env.ANTHROPIC_API_KEY` or throws on first call.
 *
 * **SINGLE SOURCE OF TRUTH for Anthropic client construction.** Every
 * adapter that constructs an Anthropic client MUST go through this
 * helper — no inline `new Anthropic(...)` allowed in adapter code.
 */
export function createAnthropicClient(
  rawKey: string | undefined,
): Anthropic {
  if (rawKey === undefined) {
    return new Anthropic({
      baseURL: 'https://api.anthropic.com',
    });
  }
  return new Anthropic({
    apiKey: rawKey,
    baseURL: 'https://api.anthropic.com',
  });
}
