/**
 * HTTP → AuthAdapter bridge.
 *
 * Parses `Authorization: Bearer <token>` off the incoming request and
 * delegates identity resolution to the supplied {@link AuthAdapter}.
 * Unauthenticated requests are rejected with 401 before the MCP SDK
 * ever sees the request body.
 */

import type { Request } from 'express';
import type { IncomingHttpHeaders } from 'node:http';
import type { AuthAdapter, AuthResult } from '@ggui-ai/mcp-server-core';

export class UnauthenticatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnauthenticatedError';
  }
}

/**
 * Resolve an identity from a normalized `(headers, remoteAddress)` pair.
 * Both the Express `/mcp` path and the WebSocket live-channel `/ws`
 * upgrade path funnel through this — so a single bearer-parsing +
 * adapter-call codepath covers every OSS ingress point.
 */
export async function resolveIdentityFromHeaders(
  adapter: AuthAdapter,
  headers: IncomingHttpHeaders,
  remoteAddress?: string,
): Promise<AuthResult> {
  const flat: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string') flat[k] = v;
    else if (Array.isArray(v)) flat[k] = v[0];
  }
  const result = await adapter.getIdentity({
    headers: flat,
    remoteAddress,
  });
  if (!result) {
    throw new UnauthenticatedError('No valid credentials');
  }
  return result;
}

/**
 * Resolve the caller's identity from the incoming Express request.
 * Throws {@link UnauthenticatedError} when the adapter returns null
 * so the HTTP layer can map to a single 401 response shape.
 */
export async function resolveIdentity(
  adapter: AuthAdapter,
  req: Request,
): Promise<AuthResult> {
  return resolveIdentityFromHeaders(
    adapter,
    req.headers,
    req.socket?.remoteAddress ?? req.ip ?? undefined,
  );
}

/**
 * Derive a stable `appId` from an auth result.
 *
 * In OSS single-user mode every identity collapses to `{kind:'builder'}`
 * which doesn't carry a tenant id. We fold these into a single
 * well-known value (`DEFAULT_BUILDER_APP_ID`) so blueprint / vector
 * scoping still works. Multi-tenant bindings (a hosted closed runtime)
 * override this by passing `appIdFromIdentity` on `createGguiServer`.
 */
export const DEFAULT_BUILDER_APP_ID = 'builder';

export function defaultAppIdFromIdentity(result: AuthResult): string {
  if (result.identity.kind === 'user') {
    // Cloud auth adapters populate `appId` when known — per-app-scoped
    // bearer key, URL-path-derived, or User.defaultAppId lookup. Read
    // it with priority so handlers scope to the correct GguiApp.appId.
    // OSS deployments leave the field undefined and fall through to the
    // `workspaceId`/`userId` chain.
    return (
      result.identity.appId ??
      result.identity.workspaceId ??
      result.identity.userId
    );
  }
  // `kind: 'app'` carries the appId directly — surfaced by API-key /
  // OAuth-bearer adapters (e.g. an ApiKeyAuthAdapter on a hosted
  // multi-tenant deployment). Falling through to DEFAULT_BUILDER_APP_ID
  // here would discard the very tenant id the adapter just proved.
  if (result.identity.kind === 'app') {
    return result.identity.appId;
  }
  return DEFAULT_BUILDER_APP_ID;
}
