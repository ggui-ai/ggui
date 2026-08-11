/**
 * Shared 3-tier `CallToolResult` payload unwrap.
 *
 * MCP hosts relay `tools/call` results to the iframe in three observed
 * envelope shapes. The tiers, in the order probed:
 *
 *   1. `structuredContent` — spec-canonical hosts.
 *   2. `content[0].text` parsed as JSON — relay hosts that NORMALIZE
 *      the CallToolResult down to its text block (claude.ai's live
 *      behavior on the #471 retest: the enqueue succeeded server-side,
 *      but the response arrived text-only and classified as a failure,
 *      so no doorbell rang).
 *   3. Fields directly on the bare result — looser hosts.
 *
 * Shared by the submit-action response classifier (`runtime.ts`'s
 * `submitActionPayload`) and the bridge-pull rung's `fetchBody`
 * carrier (`events-polling.ts`'s `buildBridgePolling`), so both reads
 * agree on which envelope tier carries the payload for a given host
 * shape.
 */

/**
 * Unwrap the payload record of a relayed `tools/call` result. `result`
 * is the CallToolResult-level value (i.e. the JSON-RPC envelope's
 * `result` field, already extracted by the caller).
 *
 * Returns `null` when no tier yields an object — the caller treats
 * that as fallback/unknown.
 */
export function unwrapCallToolResult(
  result: unknown,
): Record<string, unknown> | null {
  if (result === null || typeof result !== 'object') return null;
  const r = result as Record<string, unknown>;
  if (r.structuredContent && typeof r.structuredContent === 'object') {
    return r.structuredContent as Record<string, unknown>;
  }
  // Text-block tier BEFORE the bare-result tier when content exists:
  // a normalized result's own top level carries only `content`, so
  // probing it for payload fields would always miss anyway — but a
  // parseable text block is decisive evidence of the real payload.
  const content = r.content;
  if (Array.isArray(content) && content.length > 0) {
    const first = content[0] as Record<string, unknown> | undefined;
    if (first && first.type === 'text' && typeof first.text === 'string') {
      try {
        const parsed: unknown = JSON.parse(first.text);
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return parsed as Record<string, unknown>;
        }
      } catch {
        // Not JSON — fall through to the bare-result tier.
      }
    }
  }
  return r;
}
