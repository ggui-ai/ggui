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
 * ggui#1483 — the one line a refused cross-SUBJECT call leaves: a caller
 * holding an end-user identity named a session of its own app bound to a
 * different end-user. The tool, the session and the app — never either
 * user's id, which the line has no need to carry, and never the payload.
 * The caller's answer is the tool's ordinary not-found.
 */
export function logCrossSubjectRefused(tool: string, sessionId: string, appId: string): void {
  // eslint-disable-next-line no-console -- operator-visible structured refusal line; handlers carry no logger
  console.warn(`[ggui] runtime_cross_subject_refused ${JSON.stringify({ tool, sessionId, appId })}`);
}

/**
 * ggui#1479 — the line a refusal leaves when a session's ownership could not
 * be read at all (the store threw): the tool, the session, the caller's app
 * and why. The call fails closed; this line is how an outage reads apart
 * from a probe. A caller with no logger of its own passes the store's error
 * text, so the cause rides the same line (ggui#1514).
 */
export function logOwnershipUnverified(
  tool: string,
  sessionId: string,
  callerAppId: string,
  reason: 'read-failed',
  error?: string,
): void {
  const fields = error === undefined ? { tool, sessionId, callerAppId, reason } : { tool, sessionId, callerAppId, reason, error };
  // eslint-disable-next-line no-console -- operator-visible structured refusal line; handlers carry no logger
  console.warn(`[ggui] runtime_ownership_unverified ${JSON.stringify(fields)}`);
}
