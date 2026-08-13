/**
 * SSE frame parser for the streamable invoke protocol.
 *
 * Reads a `Response.body` chunk by chunk, yields parsed + validated
 * `InvokeEvent`s as they arrive. Buffers partial frames across chunk
 * boundaries — chunks from `fetch` do NOT align with `\n\n` separators.
 */
import { invokeEventSchema, type InvokeEvent } from '@ggui-ai/protocol';

const DECODER = new TextDecoder();
const FRAME_SEP = '\n\n';

/**
 * Async generator yielding one `InvokeEvent` per SSE frame in the stream.
 *
 * Malformed frames (non-JSON data, schema validation failure) are dropped
 * silently — agents emit a wide variety of frames and a single bad one
 * shouldn't kill the whole turn. Caller handles `event: error` for explicit
 * upstream failures.
 */
export async function* parseSseStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<InvokeEvent> {
  const reader = body.getReader();
  let buffer = '';

  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;

      buffer += DECODER.decode(value, { stream: true });

      let sepIdx: number;
      while ((sepIdx = buffer.indexOf(FRAME_SEP)) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + FRAME_SEP.length);
        const event = parseFrame(frame);
        if (event) yield event;
      }
    }

    // Flush trailing frame (no terminator) — agent that closed cleanly will
    // have sent message_stop with the separator, but be lenient.
    if (buffer.length > 0) {
      const event = parseFrame(buffer);
      if (event) yield event;
    }
  } finally {
    reader.releaseLock();
  }
}

function parseFrame(frame: string): InvokeEvent | null {
  // Frames are `event: NAME\ndata: JSON` (newlines are spec-strict but
  // forgiving here). We only need the data line.
  const dataIdx = frame.indexOf('data: ');
  if (dataIdx === -1) return null;
  const json = frame.slice(dataIdx + 'data: '.length).trim();
  if (!json) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  const result = invokeEventSchema.safeParse(parsed);
  return result.success ? result.data : null;
}
