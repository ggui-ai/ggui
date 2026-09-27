/**
 * ggui#1479 — the one line a refused cross-app call leaves: the tool, the
 * session, the caller's app and the session's owning app. Ids only, never
 * the payload. Operator-side: the caller's answer never names the owner.
 * One physical line — a fixed prefix then a JSON body — so a log query
 * matches the event on the prefix and reads its fields from the JSON.
 */
export function logCrossAppRefused(tool: string, sessionId: string, callerAppId: string, ownerAppId: string): void {
  // eslint-disable-next-line no-console -- operator-visible structured refusal line; handlers carry no logger
  console.warn(`[ggui] runtime_cross_app_refused ${JSON.stringify({ tool, sessionId, callerAppId, ownerAppId })}`);
}

/**
 * ggui#1479 — the line a refusal leaves when a session's ownership could not
 * be read at all (the store threw): the tool, the session, the caller's app
 * and why. The call fails closed; this line is how an outage reads apart
 * from a probe.
 */
export function logOwnershipUnverified(tool: string, sessionId: string, callerAppId: string, reason: 'read-failed'): void {
  // eslint-disable-next-line no-console -- operator-visible structured refusal line; handlers carry no logger
  console.warn(`[ggui] runtime_ownership_unverified ${JSON.stringify({ tool, sessionId, callerAppId, reason })}`);
}
