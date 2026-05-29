/**
 * Coverage for {@link useMcpAppsChat}'s `handleAppMessage` — the drop-in
 * `<AppRenderer onMessage>` handler for guest `ui/message` notifications.
 *
 * The contract under test (post-#290):
 *   - The hook is ggui-protocol-AGNOSTIC. `handleAppMessage` joins the
 *     content blocks' text into the prompt and forwards the content
 *     block's `_meta` record OPAQUELY as `data.meta` in the POST body.
 *     It never imports `@ggui-ai/protocol`, never names any `ai.ggui/*`
 *     key, never validates the slice — the agent-server backend is the
 *     sole trust boundary.
 *   - A message with no text returns `{ isError: true }` and does NOT
 *     POST (matching the host's `McpUiMessageResult` contract).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMcpAppsChat } from '../useMcpAppsChat';

/** Build a Response whose body is an empty SSE stream (so `send` resolves). */
function emptySseResponse(): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

describe('useMcpAppsChat handleAppMessage', () => {
  let fetchMock: ReturnType<typeof vi.fn<[input: string, init?: RequestInit], Promise<Response>>>;

  beforeEach(() => {
    fetchMock = vi.fn<[input: string, init?: RequestInit], Promise<Response>>(async () => emptySseResponse());
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function lastPostBody(): {
    prompt?: string;
    data?: { meta?: Record<string, unknown> };
  } {
    const call = fetchMock.mock.calls.at(-1);
    const init = call?.[1];
    const rawBody = init?.body;
    return JSON.parse(typeof rawBody === 'string' ? rawBody : '{}');
  }

  it('joins text + forwards the content block _meta OPAQUELY as data.meta', async () => {
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://x/agent' }),
    );

    // A doorbell-shaped slice — but the hook treats `_meta` as an opaque
    // blob; it must forward it verbatim without inspecting any key.
    const doorbell = {
      kind: 'user-action',
      description: 'User interacted with render r_1; call ggui_consume…',
      renderId: 'r_1',
      actionId: 'deadbeef',
      submittedAt: '2026-05-29T10:00:00Z',
      intent: 'toggle',
      nextStep: { tool: 'ggui_consume', args: { renderId: 'r_1' } },
    };

    await act(async () => {
      await result.current.handleAppMessage({
        role: 'user',
        content: [
          {
            type: 'text',
            text: 'forward me',
            _meta: { 'ai.ggui/userAction': doorbell },
          },
        ],
      });
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = lastPostBody();
    expect(body.prompt).toBe('forward me');
    // Forwarded verbatim — same object shape, key intact.
    expect(body.data?.meta).toEqual({ 'ai.ggui/userAction': doorbell });
  });

  it('forwards a foreign _meta key just as opaquely (no key allow-list)', async () => {
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://x/agent' }),
    );

    await act(async () => {
      await result.current.handleAppMessage({
        role: 'user',
        content: [
          { type: 'text', text: 'hi', _meta: { 'vendor/whatever': { a: 1 } } },
        ],
      });
    });

    const body = lastPostBody();
    expect(body.data?.meta).toEqual({ 'vendor/whatever': { a: 1 } });
  });

  it('omits data.meta when no content block carries _meta', async () => {
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://x/agent' }),
    );

    await act(async () => {
      await result.current.handleAppMessage({
        role: 'user',
        content: [{ type: 'text', text: 'plain' }],
      });
    });

    const body = lastPostBody();
    expect(body.prompt).toBe('plain');
    expect(body.data).toBeUndefined();
  });

  it('returns { isError: true } and does NOT POST when there is no text', async () => {
    const { result } = renderHook(() =>
      useMcpAppsChat({ chatEndpoint: 'http://x/agent' }),
    );

    let res: Record<string, unknown> = {};
    await act(async () => {
      res = await result.current.handleAppMessage({
        role: 'user',
        content: [{ type: 'image' }],
      });
    });

    expect(res).toEqual({ isError: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
