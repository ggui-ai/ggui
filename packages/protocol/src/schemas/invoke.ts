/**
 * Streamable Invoke Protocol v1 — Zod schemas.
 *
 * Single source of truth for the client→agent invoke turn. Mirrors Anthropic's
 * Messages streaming format exactly (message_start / content_block_{start,delta,stop}
 * / message_delta / message_stop / ping / error). UI rendering is expressed as
 * plain `tool_use` blocks calling the `ggui_render` / `ggui_render_blueprint`
 * client tools — no ggui-specific block type.
 *
 * TS types in types/invoke.ts are derived from these via z.infer. Consumers
 * (@ggui-ai/server, @ggui-ai/react) import schemas for runtime validation
 * and types for authoring.
 */

import { z } from 'zod';
import { interfaceContextSchema } from './mcp';

// ── Content blocks ────────────────────────────────────────────────────

/** Plain text content — streamed via `text_delta` events. */
export const textBlockSchema = z.object({
  type: z.literal('text'),
  text: z.string(),
});

/** Tool call initiated by the agent. Input may arrive via `input_json_delta`. */
export const toolUseBlockSchema = z.object({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.record(z.string(), z.unknown()),
});

/**
 * Tool execution result (Protocol v1.1).
 *
 * Emitted inline on the assistant turn when the server executed a tool on
 * the agent's behalf (e.g. `ggui_render`, `ggui_handshake`). Clients pair this
 * with the matching `tool_use` by `tool_use_id` and render — no second
 * round-trip through a `ggui_render` client tool is needed.
 *
 * This extends Anthropic's shape: Anthropic puts `tool_result` in the next
 * user message, we also allow it on the assistant turn because the server
 * already has the result. The `content` shape depends on the tool.
 */
export const toolResultBlockSchema = z.object({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown(),
  is_error: z.boolean().optional(),
});

/** Discriminated union of every legal content block type. */
export const contentBlockSchema = z.discriminatedUnion('type', [
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

// ── Deltas ────────────────────────────────────────────────────────────

export const textDeltaSchema = z.object({
  type: z.literal('text_delta'),
  text: z.string(),
});

export const inputJsonDeltaSchema = z.object({
  type: z.literal('input_json_delta'),
  partial_json: z.string(),
});

export const contentBlockDeltaPayloadSchema = z.discriminatedUnion('type', [
  textDeltaSchema,
  inputJsonDeltaSchema,
]);

// ── Events ────────────────────────────────────────────────────────────

/** First event of a turn. */
export const messageStartEventSchema = z.object({
  type: z.literal('message_start'),
  message: z.object({
    id: z.string(),
    role: z.literal('assistant'),
    model: z.string().optional(),
  }),
});

/** A new content block begins. */
export const contentBlockStartEventSchema = z.object({
  type: z.literal('content_block_start'),
  index: z.number().int().nonnegative(),
  content_block: contentBlockSchema,
});

/** Incremental update to the block at `index`. */
export const contentBlockDeltaEventSchema = z.object({
  type: z.literal('content_block_delta'),
  index: z.number().int().nonnegative(),
  delta: contentBlockDeltaPayloadSchema,
});

/** The block at `index` is complete. */
export const contentBlockStopEventSchema = z.object({
  type: z.literal('content_block_stop'),
  index: z.number().int().nonnegative(),
});

/** Final metadata just before the turn ends. */
export const messageDeltaEventSchema = z.object({
  type: z.literal('message_delta'),
  delta: z.object({
    stop_reason: z.enum(['end_turn', 'max_tokens', 'tool_use', 'error']),
    stop_sequence: z.string().nullable().optional(),
  }),
  usage: z.object({
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
  }),
});

/** Turn is done. No events may follow. */
export const messageStopEventSchema = z.object({
  type: z.literal('message_stop'),
});

/** Keep-alive frame. */
export const pingEventSchema = z.object({
  type: z.literal('ping'),
});

/** Terminal error. No `message_stop` follows. */
export const invokeErrorCodeSchema = z.enum([
  'invalid_request',
  'unauthorized',
  'rate_limited',
  'invoke_in_progress',
  'upstream_error',
  'tool_error',
  'internal',
]);

export const errorEventSchema = z.object({
  type: z.literal('error'),
  error: z.object({
    code: invokeErrorCodeSchema,
    message: z.string(),
    retryAfterMs: z.number().int().nonnegative().optional(),
  }),
});

/**
 * Discriminated union over every event the agent may emit.
 *
 * Parsing an incoming SSE frame:
 *   const event = invokeEventSchema.parse(JSON.parse(frame.data));
 *   switch (event.type) { ... }
 */
export const invokeEventSchema = z.discriminatedUnion('type', [
  messageStartEventSchema,
  contentBlockStartEventSchema,
  contentBlockDeltaEventSchema,
  contentBlockStopEventSchema,
  messageDeltaEventSchema,
  messageStopEventSchema,
  pingEventSchema,
  errorEventSchema,
]);

// ── Request ───────────────────────────────────────────────────────────

/**
 * A prior conversation turn. Content is either a plain text shortcut or a
 * structured content block sequence (mirrors Anthropic's `messages[].content`).
 */
export const invokeTurnSchema = z.object({
  role: z.enum(['user', 'assistant']),
  content: z.union([z.string(), z.array(contentBlockSchema)]),
});

/**
 * POST body shape for `{endpointUrl}/invoke`.
 *
 * Stateless by default — client holds history, sends full `history[]` every
 * turn. Agents that need server-side memory layer their own keyed on
 * `X-Ggui-Host-Session-Id`.
 */
export const invokeRequestSchema = z.object({
  message: z.string(),
  history: z.array(invokeTurnSchema).optional(),
  interfaceContext: interfaceContextSchema.optional(),
  requestId: z.string().optional(),
});
