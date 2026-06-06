/**
 * `ggui_list_sessions` — host-scoped render enumeration for resume.
 *
 * Called by an MCP host (sample-agent backend, claude.ai-style host)
 * when its end-user lands on a previously-visited chat conversation
 * and needs to know which ggui renders belong to "this chat". The
 * host passes its `hostName` + `hostSessionId` (matching what it set
 * on `_meta["ai.ggui/host-session"]` at render creation) and receives
 * the list of matching render ids it can rehydrate via
 * `/api/sessions/:id/state`.
 *
 * Scoping:
 *   - ALWAYS scoped to `ctx.appId` — tenancy boundary; cross-tenant
 *     existence MUST NOT leak.
 *   - WHEN `ctx.userId` is set, also scoped to that user — prevents
 *     one signed-in user from listing another user's renders even
 *     within the same app.
 *
 * Opt-out: renders created without an `ai.ggui/host-session` slice
 * have `host_session_id = NULL` and so never match a host-scoped
 * query. That's the documented behavior — opt-out hosts get one-shot
 * renders by design.
 *
 * Post-Phase-B (flatten-render-identity): renamed from
 * `ggui_list_sessions`. The summary shape now uses `sessionId` and
 * drops the per-summary stack count (every render IS one item).
 */

import { z } from 'zod';
import type { GguiSessionSummaryWire } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  GguiSessionStore,
  StoredGguiSession,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';

const inputSchema = {
  hostName: z
    .string()
    .min(1)
    .optional()
    .describe(
      'Filter by host identifier — `sample`, `claude.ai`, `chatgpt`, etc. When paired with `hostSessionId`, returns the renders for one specific host-conversation. When passed alone, returns every render this host has ever opened for the current user / app.',
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
      'Maximum number of render summaries to return. Defaults to 50; capped at 200. Newest-last ordering matches the natural conversation timeline.',
    ),
} as const;

const renderSummaryWireSchema = z
  .object({
    sessionId: z.string(),
    hostName: z.string().optional(),
    hostSessionId: z.string().optional(),
    createdAt: z.string(),
    lastActivityAt: z.string(),
    status: z.string(),
    // wsToken + expiresAt are populated iff the deployment wired a
    // `mintWsToken` seam. Hosts that just want to enumerate renders
    // (without immediately rehydrating) wire no seam and get the lean
    // summary; hosts driving a resume flow wire the seam and get a
    // fresh credential per render so the frontend can immediately
    // call `/api/sessions/:id/state?wsToken=<>` to mount each iframe.
    wsToken: z.string().optional(),
    wsTokenExpiresAt: z.string().optional(),
  })
  .passthrough();

const outputSchema = {
  sessions: z.array(renderSummaryWireSchema),
} as const;

// `GguiSessionSummaryWire` is re-exported below from
// `@ggui-ai/protocol/integrations/mcp-apps` — single typed source of
// truth, kept on the protocol so non-handler consumers (sample-agent's
// `/chat/restore` route, future host SDK helpers) import the same
// shape rather than redeclaring it.
export type { GguiSessionSummaryWire };

interface ListSessionsOutput {
  readonly sessions: readonly GguiSessionSummaryWire[];
}

/**
 * Seam for the freshly-minted ws-token attached to each listed
 * render. Implementations sign with the same shared secret the rest
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
  readonly renderStore: GguiSessionStore;
  /**
   * Optional ws-token minter. When wired, each listed render
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
    title: 'List renders',
    audience: ['agent'],
    description:
      'List ggui renders scoped to the caller, optionally narrowed to a host conversation. Pass `hostName` + `hostSessionId` (the same pair the host set on `_meta["ai.ggui/host-session"]` at render creation) to find the renders belonging to one chat conversation. Pass `hostName` alone to list every render opened by that host for this caller. Pass nothing for every render this caller owns. Renders without a host slice (opt-out hosts) never appear in host-scoped queries.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<ListSessionsOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const renders = await deps.renderStore.list({
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
        sessions: renders.map((stored) =>
          projectSummary(stored, deps.mintWsToken),
        ),
      };
    },
  };
}

function projectSummary(
  stored: StoredGguiSession,
  mintWsToken: ListSessionsMintSeam | undefined,
): GguiSessionSummaryWire {
  const minted = mintWsToken?.mint({
    sessionId: stored.id,
    appId: stored.appId,
  });
  return {
    sessionId: stored.id,
    ...(stored.hostSession?.hostName !== undefined
      ? { hostName: stored.hostSession.hostName }
      : {}),
    ...(stored.hostSession?.hostSessionId !== undefined
      ? { hostSessionId: stored.hostSession.hostSessionId }
      : {}),
    createdAt: toIso(stored.createdAt),
    lastActivityAt: toIso(stored.lastActivityAt),
    status: stored.status ?? 'active',
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
