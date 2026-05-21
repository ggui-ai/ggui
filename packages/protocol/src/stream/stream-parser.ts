/**
 * Universal stream parser for agent responses.
 *
 * Extracts text from any LLM provider's streaming format (Anthropic, OpenAI,
 * Gemini, Cohere, Mistral, etc.) without hardcoding provider schemas.
 * Uses depth-first search on well-known field names and container structures.
 *
 * Decoupled from any transport (WebSocket, HTTP, etc.) — callers provide
 * callbacks for chunk delivery.
 */

// ── Detection ──

/**
 * Detect whether a response should be treated as a stream based on headers.
 * Accepts raw header strings so callers aren't coupled to the fetch API.
 */
export function isStreamingContentType(
  contentType: string,
  transferEncoding?: string,
): boolean {
  if (contentType.includes('text/event-stream')) return true;
  if (contentType.includes('application/x-ndjson')) return true;
  if (contentType.includes('text/plain') && transferEncoding?.includes('chunked')) return true;
  return false;
}

// ── Text extraction ──

/** Well-known field names that carry streaming text across LLM providers. */
const TEXT_FIELDS = ['text', 'content', 'chunk', 'message', 'output', 'response'];

/** Well-known container fields that wrap text in nested structures. */
const CONTAINER_FIELDS = ['delta', 'choices', 'candidates', 'parts', 'content_block', 'data', 'body'];

/**
 * Depth-first search for a text string in a JSON structure.
 *
 * Search strategy:
 *   1. Check TEXT_FIELDS at current level (string values only)
 *   2. Recurse into CONTAINER_FIELDS
 *
 * Works with any provider because it searches by field-name patterns,
 * not by provider-specific schemas.
 */
export function deepFindText(obj: unknown, depth = 0): string {
  if (depth > 6) return '';
  if (!obj || typeof obj !== 'object') return '';

  const record = obj as Record<string, unknown>;

  for (const key of TEXT_FIELDS) {
    const val = record[key];
    if (typeof val === 'string' && val.length > 0) return val;
  }

  for (const key of CONTAINER_FIELDS) {
    if (!(key in record)) continue;
    const val = record[key];
    if (Array.isArray(val)) {
      for (const item of val) {
        const found = deepFindText(item, depth + 1);
        if (found) return found;
      }
    } else {
      const found = deepFindText(val, depth + 1);
      if (found) return found;
    }
  }

  return '';
}

// ── Done detection ──

/**
 * Detect if a streaming JSON event signals end-of-stream.
 *
 * Recognized signals:
 *   - type: "done" / "message_stop"
 *   - choices[0].finish_reason !== null
 *   - (HTTP stream close is handled by the reader, not here)
 */
export function isStreamDone(data: Record<string, unknown>): boolean {
  const t = data.type;
  if (t === 'done' || t === 'message_stop') return true;

  if (Array.isArray(data.choices)) {
    const first = (data.choices as Record<string, unknown>[])[0];
    if (first?.finish_reason != null) return true;
  }

  return false;
}

// ── SessionId extraction ──

/**
 * Extract sessionId from a streaming event.
 * Checks for a top-level `sessionId` string — no envelope format required.
 */
export function extractSessionId(data: Record<string, unknown>): string | undefined {
  if (typeof data.sessionId === 'string' && data.sessionId) {
    return data.sessionId;
  }
  return undefined;
}

// ── Stream reader ──

/**
 * Callbacks for stream consumers. Transport-agnostic — works with WebSocket,
 * HTTP response streaming, file output, or anything else.
 */
export interface StreamCallbacks {
  onChunk: (text: string) => Promise<void>;
  onDone: () => Promise<void>;
  onSessionId?: (sessionId: string) => Promise<void>;
}

/**
 * Read a streaming HTTP response and invoke callbacks for each text chunk.
 *
 * Supports three wire formats:
 *   1. text/event-stream (SSE) — parses `data:` lines
 *   2. application/x-ndjson — one JSON object per line
 *   3. Any other — forwards raw text chunks
 *
 * JSON events (SSE and NDJSON) are parsed with deepFindText for universal
 * text extraction. Non-JSON content is forwarded as raw text.
 */
export async function readStream(
  body: ReadableStream<Uint8Array>,
  contentType: string,
  callbacks: StreamCallbacks,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const isSSE = contentType.includes('text/event-stream');
  const isNDJSON = contentType.includes('application/x-ndjson');
  let buffer = '';
  let doneSent = false;

  const emitDone = async () => {
    if (doneSent) return;
    doneSent = true;
    await callbacks.onDone();
  };

  const processJsonEvent = async (data: Record<string, unknown>) => {
    const sid = extractSessionId(data);
    if (sid) await callbacks.onSessionId?.(sid);

    if (isStreamDone(data)) {
      await emitDone();
      return;
    }

    const text = deepFindText(data);
    if (text) await callbacks.onChunk(text);
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      if (isSSE) {
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line || line.startsWith(':')) continue;
          if (!line.startsWith('data: ')) continue;

          const payload = line.slice(6).trim();
          if (!payload) continue;
          if (payload === '[DONE]') { await emitDone(); continue; }

          try {
            await processJsonEvent(JSON.parse(payload) as Record<string, unknown>);
          } catch {
            // Not valid JSON — forward as raw text chunk
            await callbacks.onChunk(payload);
          }
        }
      } else if (isNDJSON) {
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          try {
            await processJsonEvent(JSON.parse(trimmed) as Record<string, unknown>);
          } catch {
            // Not valid JSON — forward as raw text chunk
            await callbacks.onChunk(trimmed);
          }
        }
      } else {
        const chunk = buffer;
        buffer = '';
        if (chunk) await callbacks.onChunk(chunk);
      }
    }

    await emitDone();
  } catch (err) {
    console.error('Stream reading error:', err);
    await emitDone().catch(() => { /* Best-effort done signal on error path */ });
  } finally {
    reader.releaseLock();
  }
}
