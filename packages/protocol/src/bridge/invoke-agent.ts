/**
 * Agent invocation helper for the bridge agent pattern.
 *
 * Cloud-provider agnostic — uses standard fetch API. Can be used by any
 * platform implementation (serverless function, self-hosted server, etc.) that needs
 * to forward messages to an agent's HTTP endpoint.
 *
 * Handles both JSON and SSE streaming responses using stream-parser.
 */
import type { InterfaceContext } from '../types/interface-context';
import type { ConversationTurn } from '../types/session';
import { z } from 'zod';
import { isStreamingContentType } from '../stream/stream-parser';

/** Schema for agent HTTP response data — validates untrusted external input. */
const agentResponseSchema = z.object({
  hostSessionId: z.string().optional(),
  text: z.string().optional(),
  events: z.array(z.object({
    type: z.string(),
    payload: z.unknown(),
  }).passthrough()).optional(),
}).passthrough();

// ── Types ──

export interface InvokeAgentOptions {
  /** The agent's HTTP endpoint URL */
  connectorEndpointUrl: string;
  /** Conversation envelope id (omit for 'start' flow — agent mints one) */
  hostSessionId?: string;
  /** Invocation type: 'start' begins a fresh conversation, 'message' continues one */
  type: 'start' | 'message';
  /** User message text */
  message?: string;
  /** App ID to include in the request */
  appId: string;
  /** Client interface context (device, viewport, shell type) */
  interfaceContext?: InterfaceContext;
  /** Conversation history for multi-turn context */
  conversationHistory?: ConversationTurn[];
  /** Callback to forward streaming text chunks to the user */
  onStreamChunk?: (text: string) => Promise<void>;
  /** Callback when the stream is done */
  onStreamDone?: () => Promise<void>;
  /** Callback when the agent returns a hostSessionId (start flow, SSE) */
  onHostSessionId?: (hostSessionId: string) => Promise<void>;
  /** Callback for structured agent events (stream, push, etc.) from the events array */
  onAgentEvent?: (event: { type: string; payload: unknown }) => Promise<void>;
  /** Request timeout in milliseconds (default: 90000) */
  timeoutMs?: number;
}

export interface InvokeAgentResult {
  /** Conversation envelope id returned by the agent (start flow) */
  hostSessionId?: string;
  /** Full text response (JSON responses only — streaming uses callbacks) */
  text?: string;
  /** Whether the response was streamed via SSE */
  streamed: boolean;
  /** Outcome status */
  status: 'ok' | 'error';
  /** Error message if status is 'error' */
  error?: string;
}

// ── Implementation ──

/**
 * Invoke an agent's HTTP endpoint and handle the response.
 *
 * Supports two response formats:
 *   1. JSON — returns the parsed body as InvokeAgentResult
 *   2. SSE stream — forwards chunks via callbacks, returns when stream ends
 *
 * The request body shape follows the ggui bridge protocol:
 *   - start:   { type: 'start', message, appId, interfaceContext }
 *   - message: { type: 'message', hostSessionId, appId, message, conversationHistory, interfaceContext }
 */
export async function invokeAgentEndpoint(
  options: InvokeAgentOptions,
): Promise<InvokeAgentResult> {
  const {
    connectorEndpointUrl,
    type,
    appId,
    hostSessionId,
    message,
    interfaceContext,
    conversationHistory,
    onStreamChunk,
    onStreamDone,
    onHostSessionId,
    timeoutMs = 90_000,
  } = options;

  // Build request body based on invocation type
  const body: Record<string, unknown> = { type, appId };

  if (type === 'start') {
    if (hostSessionId) body.hostSessionId = hostSessionId;
    body.message = message || 'Start a new session';
    if (interfaceContext) body.interfaceContext = interfaceContext;
  } else {
    body.hostSessionId = hostSessionId;
    body.message = message;
    if (interfaceContext) body.interfaceContext = interfaceContext;
    if (conversationHistory && conversationHistory.length > 0) {
      body.conversationHistory = conversationHistory;
    }
  }

  // Build headers
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Ggui-App-Id': appId,
  };
  if (hostSessionId) {
    headers['X-Ggui-Host-Session-Id'] = hostSessionId;
  }

  // POST to agent endpoint
  let response: Response;
  try {
    response = await fetch(connectorEndpointUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Agent invocation failed';
    return { status: 'error', error: errMsg, streamed: false };
  }

  if (!response.ok) {
    return {
      status: 'error',
      error: `Agent returned ${response.status}`,
      streamed: false,
    };
  }

  // Determine response format
  const contentType = response.headers.get('content-type') || '';
  const transferEncoding = response.headers.get('transfer-encoding') || '';

  // Read the full response body (SSE or JSON)
  const responseText = await response.text();

  // Parse the response — handle SSE format (strip `data: ` prefix)
  let agentData: z.infer<typeof agentResponseSchema>;
  try {
    // SSE responses have `data: {...}` lines
    const lines = responseText.split('\n').filter(l => l.startsWith('data: '));
    const raw = lines.length > 0
      ? JSON.parse(lines[lines.length - 1].slice(6).trim())
      : JSON.parse(responseText);
    agentData = agentResponseSchema.parse(raw);
  } catch {
    // Couldn't parse or validate — forward raw text
    await onStreamChunk?.(responseText);
    await onStreamDone?.();
    return { status: 'ok', streamed: true };
  }

  // Extract hostSessionId
  if (agentData.hostSessionId) {
    await onHostSessionId?.(agentData.hostSessionId);
  }

  // Forward structured agent events
  if (agentData.events && options.onAgentEvent) {
    for (const event of agentData.events) {
      await options.onAgentEvent(event as { type: string; payload: unknown });
    }
  }

  // Extract text for conversation history
  const resultText = agentData.text;

  await onStreamDone?.();

  return {
    hostSessionId: agentData.hostSessionId,
    text: resultText,
    status: 'ok',
    streamed: isStreamingContentType(contentType, transferEncoding),
  };
}
