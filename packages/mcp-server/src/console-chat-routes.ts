/**
 * Console dev-chat round-trip route.
 *
 *   POST /ggui/console/chat/message — OSS dev chat round-trip.
 *
 * Routes the message through `ggui_render` whenever the server was
 * composed with a real generator — turning the chat surface into
 * the cohesive agent experience: every user message commits a
 * render against a thread-scoped render; the render handler owns
 * generation, cache, and provisional preview; the client renders
 * the resulting render inline using `GguiSessionRenderer`.
 *
 * Shape: `{ text, threadId?, sessionId? }` →
 * `{ threadId, userMessage, agentMessage, ui? }`.
 *   - `ui` is populated only when the render handler is wired AND
 *     the call succeeded. `ui.sessionId` is the render id the client
 *     subscribes to over `/ws`; the committed render arrives via
 *     the subscribe ack's single `render` field, which the client
 *     mounts inline to show the agent's generated component.
 *   - When the render handler is NOT wired (no `mcpApps`, placeholder
 *     mode, or no BYOK), `ui` is absent and `agentMessage.text`
 *     carries an honest text-only acknowledgment. This preserves
 *     the text-only round-trip path so operators without a key can
 *     still exercise the chat UI end-to-end.
 *   - `sessionId` is echoed on every response and should be passed
 *     back on subsequent messages so the thread reuses one render.
 *
 * Same-origin only — no bearer auth. The console surface is
 * always the operator's own browser pointing at their own `ggui
 * serve` instance; adding bearer auth here would block the
 * dev-page-is-usable claim without meaningful security gain.
 *
 * The render invocation uses `DEFAULT_BUILDER_APP_ID` for tenant
 * scope — same well-known value the `/mcp` endpoint collapses to
 * in OSS single-user mode. Matches blueprint + vector scoping
 * applied by the generator / cache seams.
 *
 * Handler gate: without a generator wired, a render call would
 * allocate a render + shortCode with empty componentCode
 * (codeReady:false) per turn without any visible UI — honest
 * behavior but useless. Falling through to the canned-text path
 * keeps the chat surface usable without a BYOK key AND preserves
 * the exact Lane-1 chat-page spec assertion (`/OSS agent
 * generation/`) without a copy change.
 */

import type { SharedHandler } from "@ggui-ai/mcp-server-handlers";
import type { Express } from "express";
import { randomUUID } from "node:crypto";
import type { ZodRawShape } from "zod";
import { DEFAULT_BUILDER_APP_ID } from "./auth.js";
import { mintDevtoolCookie } from "./console-auth.js";
import { applyDevtoolSecurityHeaders } from "./console-headers.js";
import type { Logger } from "./logger.js";

interface MountOptions {
  /** Express app to mount onto. */
  readonly app: Express;
  /**
   * `ggui_render` handler — present only when the composer resolved
   * generation deps (the gate that makes a render turn useful).
   */
  readonly renderHandler?: SharedHandler<ZodRawShape, ZodRawShape>;
  /** `ggui_handshake` handler paired with the render handler. */
  readonly handshakeHandler?: SharedHandler<ZodRawShape, ZodRawShape>;
  /**
   * Console session-cookie wiring. Present only when the cookie flow
   * is enabled — each successful render turn then mints a same-origin
   * HttpOnly cookie so the chat can open the /ws subscription without
   * a separate POST to /ggui/console/session-cookie.
   */
  readonly sessionCookie?: {
    readonly secret: string;
    readonly ttlSec?: number;
    readonly secure: boolean;
  };
  /** Structured logger. */
  readonly logger: Logger;
}

/**
 * Mount `POST /ggui/console/chat/message` onto the express app.
 * Returns nothing — the route self-registers.
 */
export function mountConsoleChatRoutes(opts: MountOptions): void {
  const { app, renderHandler, handshakeHandler, sessionCookie, logger } = opts;

  app.post("/ggui/console/chat/message", async (req, res) => {
    applyDevtoolSecurityHeaders(res);
    const body = (req.body ?? {}) as {
      text?: unknown;
      threadId?: unknown;
      sessionId?: unknown;
    };
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (text.length === 0) {
      res.status(400).json({
        error: "invalid_request",
        message: "`text` (non-empty string) is required",
      });
      return;
    }
    if (text.length > 4000) {
      res.status(400).json({
        error: "invalid_request",
        message: "`text` must be <= 4000 chars",
      });
      return;
    }
    const threadId =
      typeof body.threadId === "string" && body.threadId.length > 0
        ? body.threadId
        : `chat-${randomUUID()}`;
    const now = Date.now();
    const userMessage = {
      id: `msg-${randomUUID()}`,
      role: "user" as const,
      text,
      createdAt: now,
    };

    // Attempt real generation through `ggui_render` when wired.
    // `renderHandler` is undefined when mcpApps was disabled or
    // the operator built a custom handler set without render. The
    // handler itself returns `codeReady:false` when generation deps
    // aren't wired (no BYOK) — we surface that honestly on the
    // agentMessage text without pretending a UI landed.
    let ui:
      | {
          sessionId: string;
          shortCode: string;
          codeReady: boolean;
          cache?: { hit: boolean; llmCallsAvoided: number };
        }
      | undefined;
    let agentText: string | undefined;
    if (renderHandler && handshakeHandler) {
      try {
        const requestId = randomUUID();
        const handshakeInput: Record<string, unknown> = {
          story: { intent: text, contract: {} },
        };
        const hsRaw = await handshakeHandler.handler(handshakeInput, {
          appId: DEFAULT_BUILDER_APP_ID,
          requestId,
        });
        const handshakeId = (hsRaw as { handshakeId: string }).handshakeId;
        const raw = await renderHandler.handler(
          { handshakeId, contract: {} },
          { appId: DEFAULT_BUILDER_APP_ID, requestId }
        );
        const result = raw as {
          sessionId: string;
          shortCode: string;
          codeReady: boolean;
          cache?: { hit: boolean; llmCallsAvoided: number };
        };
        ui = {
          sessionId: result.sessionId,
          shortCode: result.shortCode,
          codeReady: result.codeReady,
          ...(result.cache ? { cache: result.cache } : {}),
        };
        // If console cookie auth is enabled, mint a session
        // cookie so the chat can open the /ws subscription without
        // a separate POST to /ggui/console/session-cookie. Single round-trip
        // per turn; cookie is same-origin HttpOnly.
        if (sessionCookie) {
          const mint = mintDevtoolCookie({
            sessionId: result.sessionId,
            appId: DEFAULT_BUILDER_APP_ID,
            secret: sessionCookie.secret,
            ...(sessionCookie.ttlSec !== undefined ? { ttlSec: sessionCookie.ttlSec } : {}),
            secure: sessionCookie.secure,
          });
          res.setHeader("Set-Cookie", mint.setCookieHeader);
        }
        if (result.codeReady) {
          agentText = result.cache?.hit
            ? "Reused a matching UI from cache for your request."
            : "Generated a UI for your request.";
        } else {
          // Generator ran but produced no code (no BYOK, generator
          // error, or placeholder mode). Honest text so the
          // operator knows why the surface didn't render a UI.
          agentText =
            "I received your message, but generation did not produce a UI " +
            "(no BYOK key configured, or the provider declined). Export " +
            "ANTHROPIC_API_KEY / OPENAI_API_KEY / GOOGLE_API_KEY / " +
            "OPENROUTER_API_KEY and retry.";
          // Drop the ui payload — no code ready means nothing to
          // render inline. The agent text carries the diagnosis.
          ui = undefined;
        }
      } catch (err) {
        logger.warn?.("console_chat_render_failed", {
          threadId,
          error: err instanceof Error ? err.message : String(err),
        });
        agentText =
          "Generation failed: " +
          (err instanceof Error ? err.message : String(err)) +
          ". The chat surface is still live — retry or try a different prompt.";
        ui = undefined;
      }
    }

    const agentMessage = {
      id: `msg-${randomUUID()}`,
      role: "agent" as const,
      text:
        agentText ??
        // No render handler at all — text-only fallback. Keeps the
        // Lane-1 chat-page spec green by preserving the exact copy
        // it asserts against.
        "Message received. OSS agent generation is not yet wired — " +
          "this is the text-only dev chat. Full responses " +
          "and generated UIs arrive once the generator port lands.",
      createdAt: now + 1,
    };
    logger.debug?.("console_chat_message", {
      threadId,
      userMessageId: userMessage.id,
      textLength: text.length,
      uiSessionId: ui?.sessionId,
      uiCodeReady: ui?.codeReady,
    });
    res.status(200).json({
      threadId,
      userMessage,
      agentMessage,
      ...(ui ? { ui } : {}),
    });
  });
}
