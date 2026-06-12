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
  // events
  invokeEventSchema,
  invokeErrorCodeSchema,
  // request
  invokeTurnSchema,
} from '../schemas/invoke';

// Content blocks
export type TextBlock = z.infer<typeof textBlockSchema>;
export type ToolUseBlock = z.infer<typeof toolUseBlockSchema>;
export type ToolResultBlock = z.infer<typeof toolResultBlockSchema>;
export type ContentBlock = z.infer<typeof contentBlockSchema>;

// Events. The per-event narrowing aliases (`MessageStartEvent`,
// `ContentBlockDeltaEvent`, `TextDelta`, …) were deleted in
// draft-2026-06-12 — no consumer ever narrowed with them (the SDKs
// narrow `InvokeEvent` inline via its discriminants). The underlying
// zod schemas in `schemas/invoke.ts` remain the composition source.
export type InvokeEvent = z.infer<typeof invokeEventSchema>;
export type InvokeErrorCode = z.infer<typeof invokeErrorCodeSchema>;

// Request
export type InvokeTurn = z.infer<typeof invokeTurnSchema>;
