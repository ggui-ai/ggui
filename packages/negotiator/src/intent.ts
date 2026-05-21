import { createHash } from 'node:crypto';

/**
 * Deterministic identifier for a negotiation intent.
 *
 * Used by the suggestion engine to deduplicate auto-suggested UIs
 * within a session — two prompts that would produce the same intent
 * collapse to a single suggestion. SHA-256 truncated to 16 hex chars
 * (64 bits) gives collision-resistant ids without being wastefully
 * large in logs.
 *
 * @param sessionId  Scope. Intent ids are session-local.
 * @param data       Data shape (keys only — values ignored). Undefined → 'no-data'.
 * @param action     Optional action verb. Defaults to 'create'.
 */
export function computeIntentId(
  sessionId: string,
  data: Record<string, unknown> | undefined,
  action?: string,
): string {
  const dataShape = data ? Object.keys(data).sort().join(',') : 'no-data';
  const raw = `${sessionId}:${dataShape}:${action ?? 'create'}`;
  return createHash('sha256').update(raw).digest('hex').slice(0, 16);
}

/**
 * True if the given intent id is already being handled in this session.
 *
 * The suggestion engine uses this to avoid re-suggesting the same UI
 * while the agent is already preparing one.
 */
export function shouldSuppressSuggestion(
  intentId: string,
  activeIntentIds: Set<string>,
): boolean {
  return activeIntentIds.has(intentId);
}
