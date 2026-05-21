/**
 * Streamable Invoke Protocol v1 — TypeScript types.
 *
 * Derived from Zod schemas in schemas/invoke.ts via z.infer — single source
 * of truth. Do not hand-author parallel types here.
 */

import type { z } from 'zod';
import type {
  // blocks
  textBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
  contentBlockSchema,
  // deltas
  textDeltaSchema,
  inputJsonDeltaSchema,
  contentBlockDeltaPayloadSchema,
  // events
  messageStartEventSchema,
  contentBlockStartEventSchema,
  contentBlockDeltaEventSchema,
  contentBlockStopEventSchema,
  messageDeltaEventSchema,
  messageStopEventSchema,
  pingEventSchema,
  errorEventSchema,
  invokeEventSchema,
  invokeErrorCodeSchema,
  // request
  invokeTurnSchema,
  invokeRequestSchema,
} from '../schemas/invoke';

// Content blocks
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

// Deltas
export type TextDelta = z.infer<typeof textDeltaSchema>;
export type InputJsonDelta = z.infer<typeof inputJsonDeltaSchema>;
export type ContentBlockDeltaPayload = z.infer<typeof contentBlockDeltaPayloadSchema>;

// Events
export type MessageStartEvent = z.infer<typeof messageStartEventSchema>;
export type ContentBlockStartEvent = z.infer<typeof contentBlockStartEventSchema>;
export type ContentBlockDeltaEvent = z.infer<typeof contentBlockDeltaEventSchema>;
export type ContentBlockStopEvent = z.infer<typeof contentBlockStopEventSchema>;
export type MessageDeltaEvent = z.infer<typeof messageDeltaEventSchema>;
export type MessageStopEvent = z.infer<typeof messageStopEventSchema>;
export type PingEvent = z.infer<typeof pingEventSchema>;
export type ErrorEvent = z.infer<typeof errorEventSchema>;
export type InvokeEvent = z.infer<typeof invokeEventSchema>;
export type InvokeErrorCode = z.infer<typeof invokeErrorCodeSchema>;

// Request
export type InvokeTurn = z.infer<typeof invokeTurnSchema>;
export type InvokeRequest = z.infer<typeof invokeRequestSchema>;
