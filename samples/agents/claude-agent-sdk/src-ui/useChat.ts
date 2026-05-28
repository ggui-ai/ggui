import { useCallback, useMemo } from 'react';
import {
  useMcpAppsChat,
  type ChatEntry,
  type HostDisplayMode,
  type RenderRef,
} from '@ggui-ai/react/chat-helpers';

/**
 * Sample-side wrapper around the canonical
 * {@link useMcpAppsChat} hook in `@ggui-ai/react/chat-helpers`.
 *
 * **Why a wrapper.** All MCP-Apps-spec stream handling, `_meta`
 * parsing, host-display-mode pickup, render-id dedup, and wsToken-gated
 * `/state` polling live in the library. The wrapper exists only for
 * sample-specific URL concerns:
 *
 *   - Mints / resolves a per-tab `chatId` against the page URL
 *     (`?chat=<id>`), so opening the same URL in any tab restores the
 *     same conversation (the same pattern claude.ai's `/c/<id>` uses).
 *   - Exposes a `newSession()` action that navigates to a fresh chatId
 *     URL — a hard-reload reset that drops every iframe + chat entry
 *     in one step.
 *
 * Sample server stays brand-agnostic too — it only stores
 * `SDKMessage[]` per chatId. Any other MCP-Apps-spec UI could drive
 * this exact wire (`POST /chat`, `GET /chat?chatId=…`,
 * `GET /api/renders/:id/state`).
 */

interface UseChatResult {
  readonly entries: ReadonlyArray<ChatEntry>;
  readonly renders: ReadonlyArray<RenderRef>;
  readonly hostDisplayMode: HostDisplayMode | undefined;
  readonly sending: boolean;
  readonly send: (prompt: string) => Promise<void>;
  readonly abort: () => void;
  /**
   * Mint a fresh chatId and navigate the page to it — drives the
   * "+ New" button in the header. Discards the current chat view; the
   * server-side snapshot for the old id remains reachable by URL.
   */
  readonly newSession: () => void;
}

export function useChat(): UseChatResult {
  const chatId = useMemo(() => getOrCreateChatId(), []);

  const {
    entries,
    renders,
    hostDisplayMode,
    sending,
    send,
    abort,
  } = useMcpAppsChat({
    chatEndpoint: '/chat',
    chatId,
  });

  // Start a fresh conversation: mint a new chatId, stamp it into the
  // URL, then hard-reload so the React tree and every iframe boot fresh
  // from scratch. Doing this in-place via setState would leak stale
  // render iframes + the restored chat history; a navigation is the
  // cleanest reset. URL is authoritative — no localStorage write
  // needed.
  const newSession = useCallback(() => {
    const fresh = crypto.randomUUID();
    window.location.href = `/?${URL_CHAT_PARAM}=${encodeURIComponent(fresh)}`;
  }, []);

  return { entries, renders, hostDisplayMode, sending, send, abort, newSession };
}

/**
 * Stable per-conversation chat id. Resolution:
 *
 *   1. URL `?chat=<id>` query param — authoritative. Every link to
 *      "this conversation" carries the id, so opening the URL in any
 *      tab/window restores that specific conversation, the same way
 *      claude.ai's `/c/<id>` URLs work.
 *   2. Mint fresh UUID and stamp it into the URL.
 *
 * Visiting `/` (no query param) ALWAYS starts a fresh conversation —
 * no localStorage-based "resume last chat" fallback. That fallback
 * surprised debugging (every visit auto-loaded the last conversation,
 * hiding fresh-start bugs); the explicit "+ New" button replaces the
 * affordance more visibly, and copy/pasted URLs give intentional
 * resume.
 *
 * SSR-safe: returns a throwaway id when neither URL API nor crypto
 * is available; the resulting chat is single-turn isolated.
 */
const URL_CHAT_PARAM = 'chat';

function getOrCreateChatId(): string {
  try {
    const url = new URL(window.location.href);
    const fromUrl = url.searchParams.get(URL_CHAT_PARAM);
    if (fromUrl && fromUrl.length > 0) return fromUrl;
    const resolved = crypto.randomUUID();
    url.searchParams.set(URL_CHAT_PARAM, resolved);
    window.history.replaceState({}, '', url.toString());
    return resolved;
  } catch {
    return crypto.randomUUID();
  }
}
