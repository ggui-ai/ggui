/**
 * `ggui_list_sessions` — host-scoped session enumeration for resume.
 *
 * Called by an MCP host (sample-agent backend, claude.ai-style host)
 * when its end-user lands on a previously-visited chat conversation
 * and needs to know which ggui sessions belong to "this chat". The
 * host passes its `hostName` + `hostSessionId` (matching what it set
 * on `_meta["ai.ggui/host-session"]` at session creation) and receives
 * the list of matching ggui session ids it can rehydrate via
 * `/api/sessions/:id/state`.
 *
 * Scoping:
 *   - ALWAYS scoped to `ctx.appId` — tenancy boundary; cross-tenant
 *     existence MUST NOT leak.
 *   - WHEN `ctx.userId` is set, also scoped to that user — prevents
 *     one signed-in user from listing another user's sessions even
 *     within the same app.
 *
 * Opt-out: sessions created without an `ai.ggui/host-session` slice
 * have `host_session_id = NULL` and so never match a host-scoped
 * query. That's the documented behavior — opt-out hosts get one-shot
 * sessions by design.
 */

import { z } from 'zod';
import type { Session } from '@ggui-ai/protocol';
import type { SessionSummaryWire } from '@ggui-ai/protocol/integrations/mcp-apps';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';

const inputSchema = {
  hostName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filter by host identifier — `sample`, `claude.ai`, `chatgpt`, etc. When paired with `hostSessionId`, returns the sessions for one specific host-conversation. When passed alone, returns every session this host has ever opened for the current user / app.',
    ),
  hostSessionId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Filter by the host's opaque grouping key — e.g. claude.ai thread id, sample-agent chatSessionId. Typically paired with `hostName` so the same id across two different hosts cannot alias.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(200)
    .optional()
    .describe(
      'Maximum number of session summaries to return. Defaults to 50; capped at 200. Newest-last ordering matches the natural conversation timeline.',
    ),
} as const;

const sessionSummaryWireSchema = z
  .object({
    sessionId: z.string(),
    hostName: z.string().optional(),
    hostSessionId: z.string().optional(),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    status: z.string(),
    stackItemCount: z.number().int().nonnegative(),
    // wsToken + expiresAt are populated iff the deployment wired a
    // `mintWsToken` seam. Hosts that just want to enumerate sessions
    // (without immediately rehydrating) wire no seam and get the lean
    // summary; hosts driving a resume flow wire the seam and get a
    // fresh credential per session so the frontend can immediately
    // call `/api/sessions/:id/state?wsToken=<>` to mount each iframe.
    wsToken: z.string().optional(),
    wsTokenExpiresAt: z.string().optional(),
  })
  .passthrough();

const outputSchema = {
  sessions: z.array(sessionSummaryWireSchema),
} as const;

// `SessionSummaryWire` is re-exported below from
// `@ggui-ai/protocol/integrations/mcp-apps` — single typed source of
// truth, kept on the protocol so non-handler consumers (sample-agent's
// `/chat/restore` route, future host SDK helpers) import the same
// shape rather than redeclaring it.
export type { SessionSummaryWire };

interface ListSessionsOutput {
  readonly sessions: readonly SessionSummaryWire[];
}

/**
 * Seam for the freshly-minted ws-token attached to each listed
 * session. Implementations sign with the same shared secret the rest
 * of the live-channel auth path uses (OSS: `MCP_BOOTSTRAP_SECRET`;
 * cloud pod: the per-pod KMS-backed equivalent). Returning a token
 * that wouldn't pass the WS upgrade is a deployment bug, not a wire-
 * contract failure — this seam is trusted.
 */
export interface ListSessionsMintSeam {
  mint(input: {
    readonly sessionId: string;
    readonly appId: string;
  }): { token: string; expiresAt: string };
}

export interface GguiListSessionsHandlerDeps {
  readonly sessionStore: SessionStore;
  /**
   * Optional ws-token minter. When wired, each listed session
   * summary carries a fresh `wsToken` + `wsTokenExpiresAt` the
   * frontend can pass straight to `/api/sessions/:id/state`. When
   * absent, summaries omit those fields and the caller is
   * responsible for minting via another seam.
   */
  readonly mintWsToken?: ListSessionsMintSeam;
}

const DEFAULT_LIMIT = 50;

export function createGguiListSessionsHandler(
  deps: GguiListSessionsHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, ListSessionsOutput> {
  return {
    name: 'ggui_list_sessions',
    title: 'List sessions',
    audience: ['agent'],
    description:
      'List ggui sessions scoped to the caller, optionally narrowed to a host conversation. Pass `hostName` + `hostSessionId` (the same pair the host set on `_meta["ai.ggui/host-session"]` at session creation) to find the sessions belonging to one chat conversation. Pass `hostName` alone to list every session opened by that host for this caller. Pass nothing for every session this caller owns. Sessions without a host slice (opt-out hosts) never appear in host-scoped queries.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListSessionsOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const sessions = await deps.sessionStore.list({
        appId: ctx.appId,
        ...(ctx.userId !== undefined ? { userId: ctx.userId } : {}),
        ...(parsed.hostName !== undefined
          ? { hostName: parsed.hostName }
          : {}),
        ...(parsed.hostSessionId !== undefined
          ? { hostSessionId: parsed.hostSessionId }
          : {}),
        limit: parsed.limit ?? DEFAULT_LIMIT,
      });
      return {
        sessions: sessions.map((session) =>
          projectSummary(session, deps.mintWsToken),
        ),
      };
    },
  };
}

function projectSummary(
  session: Session,
  mintWsToken: ListSessionsMintSeam | undefined,
): SessionSummaryWire {
  const minted = mintWsToken?.mint({
    sessionId: session.id,
    appId: session.appId,
  });
  return {
    sessionId: session.id,
    ...(session.hostSession?.hostName !== undefined
      ? { hostName: session.hostSession.hostName }
      : {}),
    ...(session.hostSession?.hostSessionId !== undefined
      ? { hostSessionId: session.hostSession.hostSessionId }
      : {}),
    createdAt: toIso(session.createdAt),
    lastActivityAt: toIso(session.lastActivityAt),
    status: session.status ?? 'active',
    stackItemCount: session.stack.length,
    ...(minted
      ? { wsToken: minted.token, wsTokenExpiresAt: minted.expiresAt }
      : {}),
  };
}

const MAX_DATE_MS = 8_640_000_000_000_000;

function toIso(epochMs: number | undefined): string {
  if (typeof epochMs !== 'number' || !Number.isFinite(epochMs)) {
    return new Date().toISOString();
  }
  return new Date(Math.min(epochMs, MAX_DATE_MS)).toISOString();
}
