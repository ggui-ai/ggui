/**
 * User-action bridge — synthesizes a structured prompt that delivers
 * the iframe's spec-canonical `_meta["ai.ggui/userAction"]` slice to
 * the agent loop as machine-extractable data instead of LLM-parsed
 * prose.
 *
 * Why this exists: when a click in a rehydrated iframe lands without
 * an active `ggui_consume` long-poll, iframe-runtime falls back to
 * `app.sendMessage` (per the dispatch-routing Pattern β rules). The
 * gesture reaches the host as a `ui/message` envelope carrying the
 * `ai.ggui/userAction` slice on `content[0]._meta`. Before this
 * bridge, the frontend stripped `_meta` and the agent saw only prose
 * like `"User fired 'X' on render <renderId>. Call ggui_consume..."`
 * — the LLM had to natural-language-parse the renderId and DECIDE to
 * skip `ggui_handshake`. Observed failure: ~50% of the time Claude
 * would re-handshake anyway, mint a fresh renderId, and orphan the
 * live iframe (the user clicks again and nothing happens).
 *
 * Structural fix: thread the slice end-to-end as typed data, then
 * present it to the LLM as a synthetic `ggui_consume` return inside
 * the user prompt. The LLM's normal `consume → domain-tool →
 * ggui_update` loop takes over — no new instructions needed, no
 * "do NOT handshake" prose, no judgment surface.
 *
 * Two sub-shapes per the protocol type `GguiUserActionMeta`:
 *
 *   - `kind: 'queued'` — pipe HAS the event; we drain it here via a
 *     direct MCP `tools/call ggui_consume({renderId})` (same JSON-RPC
 *     fetch the `FullResultMcpServerStreamableHttp` subclass uses).
 *     The drained event payload then feeds the synthetic prompt as if
 *     the LLM had called consume itself.
 *
 *   - `kind: 'inline'` — pipe is gone (PIPE_NOT_FOUND or transport
 *     error); the event payload IS the slice. We use it directly,
 *     skipping any consume call.
 */
import type {
  GguiUserActionMeta,
  InlineUserActionMeta,
} from '@ggui-ai/protocol/integrations/mcp-apps';

/**
 * Drained `ggui_consume` result envelope — what the MCP server
 * returns on a real `tools/call ggui_consume({renderId})`. Matches
 * the handler's outputSchema (`{events, status, renderId}`).
 */
interface ConsumeResultPayload {
  readonly events: ReadonlyArray<unknown>;
  readonly status: string;
  readonly renderId: string;
}

/**
 * Build the synthetic-consume-style prompt for the LLM. Includes a
 * `[GGUI_USER_ACTION]` directive block carrying the structured fields
 * verbatim — the LLM cross-references `renderId` against its
 * conversation history (where prior `ggui_render` tool outputs are
 * already recorded as JSON content text) and naturally calls the
 * domain tool + `ggui_update` on the SAME render.
 *
 * Includes the original chat prose at the end so logs / chat panels
 * still show what the user actually saw.
 */
export async function synthesizeUserActionPrompt(args: {
  readonly originalPrompt: string;
  readonly userAction: GguiUserActionMeta;
  readonly gguiMcpUrl: string;
  readonly bearer: string;
}): Promise<string> {
  const { originalPrompt, userAction, gguiMcpUrl, bearer } = args;
  const inline =
    userAction.kind === 'inline'
      ? userAction
      : await drainQueuedToInline({
          userAction,
          gguiMcpUrl,
          bearer,
        });

  // The shape mirrors what `ggui_consume`'s real return looks like
  // when the agent calls it directly. Presenting the action this way
  // lets the LLM's existing `consume → domain-tool → ggui_update`
  // loop take over without needing to be told "the render is alive".
  const consumeEnvelope = {
    renderId: inline.renderId,
    status: 'active',
    events: [
      {
        intent: inline.intent,
        actionData: inline.payload.actionData,
        uiContext: inline.payload.uiContext,
        actionId: inline.actionId,
        firedAt: inline.submittedAt,
      },
    ],
  };

  return [
    '[GGUI_USER_ACTION] The host system drained a user gesture on your behalf because no `ggui_consume` long-poll was active when the click happened. The render is alive and the structured event is below — react with the appropriate domain tool, then call `ggui_update({renderId})` on the SAME renderId to reflect the new state.',
    '',
    `ggui_consume returned: ${JSON.stringify(consumeEnvelope)}`,
    '',
    `Original user message (for context): ${originalPrompt}`,
  ].join('\n');
}

/**
 * Drain a `kind: 'queued'` userAction by issuing the prepared
 * `ggui_consume({renderId})` call directly. Returns an inline-shaped
 * payload built from the drained event so the prompt synthesizer has
 * one branch only. Throws on transport / JSON-RPC error so the chat
 * handler surfaces the failure (vs silently degrading to prose).
 */
async function drainQueuedToInline(args: {
  readonly userAction: Extract<GguiUserActionMeta, { kind: 'queued' }>;
  readonly gguiMcpUrl: string;
  readonly bearer: string;
}): Promise<InlineUserActionMeta> {
  const { userAction, gguiMcpUrl, bearer } = args;
  const rpcId = Math.floor(Math.random() * 1e9);
  const response = await fetch(gguiMcpUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      Authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: rpcId,
      method: 'tools/call',
      params: {
        name: userAction.nextStep.tool,
        arguments: userAction.nextStep.args,
      },
    }),
  });
  const text = await response.text();
  const rpc = parseMcpResponse(text);
  const err = (rpc as { error?: { message?: string } }).error;
  if (err) {
    throw new Error(
      `user-action-bridge: ggui_consume drain failed for render ` +
        `${userAction.renderId}: ${err.message ?? 'unknown error'}`,
    );
  }
  const result = (rpc as { result?: { structuredContent?: ConsumeResultPayload } })
    .result;
  const payload = result?.structuredContent;
  if (
    !payload ||
    typeof payload !== 'object' ||
    !Array.isArray(payload.events) ||
    payload.events.length === 0
  ) {
    throw new Error(
      `user-action-bridge: ggui_consume returned empty events for render ` +
        `${userAction.renderId} — pipe may have been concurrently drained.`,
    );
  }
  const event = payload.events[0] as {
    readonly intent?: string;
    readonly actionData?: unknown;
    readonly uiContext?: unknown;
    readonly actionId?: string;
    readonly firedAt?: string;
  };
  return {
    kind: 'inline',
    description: userAction.description,
    renderId: userAction.renderId,
    actionId: userAction.actionId,
    submittedAt: userAction.submittedAt,
    intent: typeof event.intent === 'string' ? event.intent : userAction.intent,
    payload: {
      actionData:
        event.actionData !== undefined
          ? (event.actionData as InlineUserActionMeta['payload']['actionData'])
          : null,
      uiContext:
        event.uiContext !== null &&
        typeof event.uiContext === 'object' &&
        !Array.isArray(event.uiContext)
          ? (event.uiContext as InlineUserActionMeta['payload']['uiContext'])
          : {},
    },
  };
}

/**
 * Parse a streamable-HTTP MCP response — either `application/json`
 * unary or `text/event-stream`. Mirrors the relay helper in
 * `server.ts` + `mcp-server-with-full-result.ts`; lifted here so the
 * bridge is self-contained.
 */
function parseMcpResponse(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return { jsonrpc: '2.0', error: { message: 'empty MCP response' } };
  }
  if (trimmed.startsWith('event:') || trimmed.startsWith('data:')) {
    const dataLine = trimmed
      .split('\n')
      .find((line) => line.startsWith('data:'));
    if (dataLine === undefined) {
      return { jsonrpc: '2.0', error: { message: 'SSE without data frame' } };
    }
    try {
      return JSON.parse(dataLine.slice('data:'.length).trim());
    } catch (err) {
      return {
        jsonrpc: '2.0',
        error: { message: `SSE JSON parse failed: ${(err as Error).message}` },
      };
    }
  }
  try {
    return JSON.parse(trimmed);
  } catch (err) {
    return {
      jsonrpc: '2.0',
      error: { message: `JSON parse failed: ${(err as Error).message}` },
    };
  }
}
