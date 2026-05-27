/**
 * `ggui_new_session` — mint or resolve a chat-scoped session handle.
 *
 * ## Why this tool exists
 *
 * Pre-CC, sessions were created implicitly on every `ggui_handshake`.
 * Stack-growth-per-chat was structurally impossible because the agent
 * never had a stable sessionId to thread across pushes — every chat
 * conversation collapsed to one stack item per session, with each push
 * minting a fresh session. The session lifecycle was coupled to the
 * push lifecycle.
 *
 * Post-CC, session lifecycle is decoupled. `ggui_new_session` is the
 * sole session-creation path. `ggui_handshake` REQUIRES a sessionId.
 * Stack-growth = the agent threads `sessionId` across multiple
 * handshake/push pairs in the same chat.
 *
 * ## SEP-2567 alignment (server mints, agent threads)
 *
 * The MCP spec direction (SEP-2567 "Sessionless MCP", Final 2026-03-11)
 * explicitly removes Mcp-Session-Id from the wire because hosts can't
 * agree on what a session means. Quote: "ChatGPT creates a fresh session
 * for every individual tool call, and Claude.ai did the same until
 * recently." The recommended pattern is exactly what this tool ships:
 * server returns explicit handles in tool results, model threads them
 * through subsequent calls.
 *
 * ## Deterministic-seed derivation
 *
 * Optional `seed` enables idempotent session resolution. Same seed →
 * same sessionId (within a single appId; tenant collision is impossible
 * by construction). Use case: agent context-window memory fails mid-
 * conversation; the agent re-derives sessionId from a stable seed
 * (chat topic, conversation start timestamp, user-scope) without
 * needing to remember a UUID.
 *
 * Derivation: `sessionId = "sess-" + sha256("v1:" + appId + ":" + seed).slice(0, 32)`.
 *
 * Cross-tenant collision is structurally impossible because appId is
 * baked into the hash input.
 *
 * ## existing flag (presence-as-signal)
 *
 * Output includes `existing?: true` ONLY when a `seed`-derived
 * sessionId resolved to an EXISTING session (idempotent reuse). Absent
 * in all other cases (no seed, fresh creation). Field's PRESENCE is the
 * signal; agents that see it should consider whether they meant to
 * resume vs. forgot the sessionId from a prior turn vs. seed
 * accidentally collided. Informational, not a flow fork.
 */
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { parseMcpAppAiGguiHostSessionMeta } from '@ggui-ai/protocol/integrations/mcp-apps';
import type {
  AppMetadataStore,
  SessionStore,
  TelemetrySink,
} from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';

const inputSchema = {
  themeId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Explicit theme preset id for this session. When omitted, the server falls back to the per-app default (App.defaultThemeId). Set this only when you've decided the visual style this chat should use (e.g. picked from a previous ggui_list_themes call).",
    ),
  requestThemeList: z
    .boolean()
    .optional()
    .describe(
      "Set true to receive `availableThemes` in the output — the per-app catalog of theme presets with descriptions you can pass to `themeId` here or on later `ggui_push` calls. Use this when the user's intent suggests a visual style (calming, urgent, brand-specific) and you want to choose from the registered presets. Omit when themes aren't relevant — the response stays small.",
    ),
  hostSession: z
    .object({
      hostName: z.string().min(1),
      hostSessionId: z.string().min(1),
    })
    .optional()
    .describe(
      'Host-supplied session-grouping slice. Spec-canonical path for hosts that can stamp `_meta["ai.ggui/host-session"]` on the inbound tools/call (claude.ai, ChatGPT, etc.) — pass it there and OMIT this input field. SDK-driven hosts whose MCP client cannot set request _meta (Claude Agent SDK, OpenAI Agents SDK) MAY pass the same shape here; the server reads from `_meta` first, falls back to this input. Captured ONCE at session creation, immutable thereafter. Omit on both paths to opt out of resume (session becomes one-shot).',
    ),
  // NOTE: previous `seed` option was retired because the LLM was passing
  // the same seed across user turns and getting back the same sessionId
  // — defeating "new" in the tool name and confusing the live-session
  // lifecycle. Stay minimal here; per-stack-item / per-push themes go
  // on `ggui_push`, not on `new_session`.
} as const;

const themeEntryWireSchema = z
  .object({
    id: z.string().min(1),
    name: z.string(),
    description: z.string(),
    modes: z.array(z.enum(['light', 'dark'])),
  })
  .passthrough();

const outputSchema = {
  sessionId: z.string(),
  /**
   * Theme preset id this session was minted with. Echoes input.themeId
   * (when present) or the per-app fallback (App.defaultThemeId);
   * undefined when no per-app default is configured and the agent
   * didn't pass one. Always returned so the agent knows the active
   * theme without a second call.
   */
  themeId: z.string().optional(),
  /**
   * Per-app theme catalog — present iff input.requestThemeList === true.
   * Each entry carries `{id, name, description, modes}`; pass an entry's
   * `id` to subsequent `ggui_push({themeId})` or future `ggui_update`
   * calls. Same shape as the standalone `ggui_list_themes` tool returns.
   */
  availableThemes: z.array(themeEntryWireSchema).optional(),
  /** Literal copy-paste example of the next call (`ggui_handshake`). */
  nextStep: z.object({
    tool: z.literal('ggui_handshake'),
    example: z.string(),
  }),
} as const;

interface ThemeEntryWire {
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly modes: readonly ('light' | 'dark')[];
}

interface NewSessionOutput {
  sessionId: string;
  themeId?: string;
  availableThemes?: readonly ThemeEntryWire[];
  nextStep: {
    readonly tool: 'ggui_handshake';
    readonly example: string;
  };
}

export interface GguiNewSessionHandlerDeps {
  readonly sessionStore: SessionStore;
  /**
   * UUID minter override for the no-seed path. Defaults to
   * `randomUUID()` from node:crypto.
   */
  readonly mintSessionId?: () => string;
  /**
   * Description override. Hosted deployments may want different prose;
   * OSS uses the locked CC default below.
   */
  readonly description?: string;
  /**
   * Per-app metadata source — read to apply `App.defaultThemeId` when
   * the agent didn't pass an explicit `themeId`, AND to scope the
   * theme catalog returned when `requestThemeList: true`. Absent dep ⇒
   * no per-app default; sessions mint with the agent-supplied themeId
   * or none, and the catalog (if requested) returns the full registry.
   */
  readonly appMetadataStore?: AppMetadataStore;
  /**
   * Theme catalog resolver. Returns every theme the runtime has
   * registered (caller projects this from `@ggui-ai/design`'s
   * `listThemes()` or whatever upstream produces). When wired AND the
   * agent passes `requestThemeList: true`, the handler filters by
   * `App.availableThemeIds` (when set) and surfaces the result on
   * `output.availableThemes`. Absent dep ⇒ `availableThemes` always
   * omitted, even when requested (handler stays well-typed; agent
   * gracefully degrades).
   */
  readonly themes?: () => readonly ThemeEntryWire[];
  /**
   * Operational-signal sink. The handler emits two events on every
   * call: `session.created` on success (carrying `seedSupplied`,
   * `existing`, `raceReread` flags so dashboards can plot fresh-vs-
   * idempotent vs. race-recovered creations), and `session.create_failed`
   * on hard error. Lossy + non-throwing per the {@link TelemetrySink}
   * contract; absent dep is a NoopTelemetrySink semantic equivalent.
   */
  readonly telemetrySink?: TelemetrySink;
}

/**
 * Build the `ggui_new_session` handler. Visibility `['model']` — agent-
 * only, never invoked by iframe-runtime. No `_meta.ui.*` because there
 * is no rendered UI behind this tool.
 */
export function createGguiNewSessionHandler(
  deps: GguiNewSessionHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, NewSessionOutput> {
  const mintSessionId = deps.mintSessionId ?? (() => randomUUID());

  return {
    name: 'ggui_new_session',
    title: 'New Session',
    audience: ['agent'],
    description:
      deps.description ??
      "Mint a fresh session for THIS chat conversation. Call ONCE per chat as the first ggui action; thread the returned `sessionId` through every subsequent ggui_handshake / ggui_update in the same chat. Each call ALWAYS mints a new random sessionId (no inputs, no idempotency — re-call only after the previous session has been intentionally retired). Output: `sessionId` (thread through subsequent calls), `nextStep` (literal example of the next call).",
    // Agent-only. No `_meta.ui.*` — there is no rendered UI behind this
    // tool. No `allowedFor` — universal across user-pod / app-pod /
    // OSS deployments.
    inputSchema,
    outputSchema,
    async handler(rawInput, ctx: HandlerContext): Promise<NewSessionOutput> {
      try {
        // Parse to surface the typed shape — inputSchema is a zod
        // ZodRawShape; parse normalises + narrows the unknown input.
        const parsed = z.object(inputSchema).parse(rawInput);
        const sessionId = mintSessionId();
        // Theme resolution at session-mint time:
        //   1. parsed.themeId     — agent-explicit choice
        //   2. App.defaultThemeId — per-app default (manifest-driven on OSS)
        //   3. undefined          — chain falls through to server fallback
        //                          at bootstrap-projection time
        // Lookups beyond layer 2 happen later when the push handler
        // composes `_meta.ggui.bootstrap`. Storing only the resolved
        // value on the session keeps subsequent pushes O(1) (no
        // re-lookup of App on every push) AND captures the actual
        // active theme so the agent can echo it back in output.
        let resolvedThemeId: string | undefined = parsed.themeId;
        if (deps.appMetadataStore) {
          const app = await deps.appMetadataStore.get(ctx.appId);
          if (resolvedThemeId === undefined && app?.defaultThemeId !== undefined) {
            resolvedThemeId = app.defaultThemeId;
          }
        }
        // Host-session capture — TWO paths, `_meta` wins:
        //
        //   1. `_meta["ai.ggui/host-session"]` on the inbound `tools/call`
        //      — the spec-canonical path. Hosts whose MCP client supports
        //      request `_meta` (claude.ai, ChatGPT, any first-party
        //      wrapper) use this. Invisible to the LLM.
        //   2. `input.hostSession` — fallback for SDK-driven hosts
        //      (Claude Agent SDK, OpenAI Agents SDK) whose MCP client
        //      cannot set request `_meta`. The sample-agent passes the
        //      chatSessionId via system-prompt directive so the LLM
        //      includes this field on every `ggui_new_session` call.
        //
        // Either path persists the slice on the session row so the
        // end-user resume flow can find it later via
        // `ggui_list_sessions(hostName, hostSessionId)`. Absent on
        // BOTH ⇒ one-shot session (non-rehydratable, by design).
        // Malformed `_meta` ⇒ silently degrades to checking input;
        // malformed input is rejected by the zod schema above.
        const hostSessionFromMeta = parseMcpAppAiGguiHostSessionMeta(
          ctx.requestMeta,
        );
        const hostSession = hostSessionFromMeta.ok
          ? (hostSessionFromMeta.hostSession ?? parsed.hostSession)
          : parsed.hostSession;
        const created = await deps.sessionStore.create({
          id: sessionId,
          appId: ctx.appId,
          ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
          ...(hostSession !== undefined ? { hostSession } : {}),
        });
        // Opt-in catalog projection. Only fires when the agent asked
        // (requestThemeList: true) AND a `themes` resolver is wired —
        // both required so the common-case new_session call stays tiny.
        // `app` may already have been read above for defaultThemeId; we
        // re-read here for clarity (cheap in-memory lookup) — most apps
        // don't request the list, so the extra get() is rare.
        let availableThemes: readonly ThemeEntryWire[] | undefined;
        if (parsed.requestThemeList === true && deps.themes) {
          const catalog = deps.themes();
          let filtered = catalog;
          if (deps.appMetadataStore) {
            const app = await deps.appMetadataStore.get(ctx.appId);
            if (app?.availableThemeIds && app.availableThemeIds.length > 0) {
              const allowed = new Set(app.availableThemeIds);
              filtered = catalog.filter((t) => allowed.has(t.id));
            }
          }
          availableThemes = filtered;
        }
        emitCreated(deps.telemetrySink, ctx.appId);
        return {
          sessionId: created.id,
          ...(resolvedThemeId !== undefined ? { themeId: resolvedThemeId } : {}),
          ...(availableThemes !== undefined ? { availableThemes } : {}),
          nextStep: buildNextStep(created.id),
        };
      } catch (err) {
        const errorClass =
          err instanceof Error
            ? err.constructor.name || 'Error'
            : 'UnknownError';
        deps.telemetrySink?.emit({
          name: 'session.create_failed',
          at: Date.now(),
          attributes: {
            appId: ctx.appId,
            errorClass,
          },
        });
        throw err;
      }
    },
  };
}

function emitCreated(
  sink: TelemetrySink | undefined,
  appId: string,
): void {
  if (!sink) return;
  sink.emit({
    name: 'session.created',
    at: Date.now(),
    attributes: { appId },
  });
}

function buildNextStep(sessionId: string): NewSessionOutput['nextStep'] {
  return {
    tool: 'ggui_handshake',
    example: `ggui_handshake({"sessionId":"${sessionId}","intent":"<describe the UI you want>"})`,
  };
}
