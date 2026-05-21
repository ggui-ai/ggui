/**
 * `createGguiGetStackHandler` — lightweight stack metadata read.
 *
 * Shared by every deployment — both the cloud server and the
 * standalone `@ggui-ai/mcp-server` compose this one factory.
 *
 * Returns navigation summaries (id, prompt, hasError, createdAt,
 * description, streamSpec, actions) WITHOUT component code — used
 * when the caller only needs structure. Cheaper than ggui_get_session.
 */

import { z } from 'zod';
import type {
  GguiGetStackOutput,
  SessionStackEntry,
  SessionStatus,
  StackItemSummary,
} from '@ggui-ai/protocol';
import type { SessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { SessionNotFoundError } from './errors.js';

const inputSchema = {
  sessionId: z
    .string()
    .min(1)
    .describe('The session id to retrieve stack metadata for'),
} as const;

const outputSchema = {
  sessionId: z.string(),
  stackSize: z.number().int().nonnegative(),
  currentIndex: z.number().int().nonnegative(),
  items: z.array(z.record(z.string(), z.unknown())),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  status: z.string(),
} as const;

export interface GguiGetStackHandlerDeps {
  readonly sessionStore: SessionStore;
}

export function createGguiGetStackHandler(
  deps: GguiGetStackHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiGetStackOutput> {
  return {
    name: 'ggui_get_stack',
    title: 'Get stack',
    audience: ['agent'],
    description:
      'Lightweight stack navigation metadata for a session — prompts, ids, timestamps, and nav flags WITHOUT component code. Use this instead of ggui_get_session when you only need structure.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiGetStackOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const session = await deps.sessionStore.get(sessionId);
      if (!session || session.appId !== ctx.appId) {
        throw new SessionNotFoundError(
          `ggui_get_stack: session "${sessionId}" not found, expired, or owned by a different appId.`,
        );
      }

      const stack = session.stack as SessionStackEntry[];
      const stackSize = stack.length;
      const currentIndex = session.currentStackIndex;
      const items: StackItemSummary[] = stack.map((entry) =>
        toStackItemSummary(entry),
      );
      // Status comes from the SessionStore when populated; legacy
      // stores without lifecycle tracking fall back to 'active'.
      const status: SessionStatus = session.status ?? 'active';
      return {
        sessionId: session.id,
        stackSize,
        currentIndex,
        items,
        canGoBack: currentIndex > 0,
        canGoForward: currentIndex < stackSize - 1,
        status,
      };
    },
  };
}

function toStackItemSummary(entry: SessionStackEntry): StackItemSummary {
  // SessionStackEntry is a discriminated union ('component' / 'mcpApps' /
  // 'system'), but cloud-side raw DDB rows historically don't carry an
  // explicit `type` discriminator (pre-Phase-D rows are bare component
  // shapes). Project optional fields defensively so both typed and
  // legacy-untyped entries surface their prompt/description/error/
  // streamSpec/actions.
  const e = entry as SessionStackEntry & {
    prompt?: string;
    description?: string;
    error?: unknown;
    streamSpec?: unknown;
    actions?: unknown;
  };
  const summary: StackItemSummary = {
    id: entry.id,
    hasError: Boolean(e.error),
    createdAt: entry.createdAt,
  };
  if (e.prompt) summary.prompt = e.prompt;
  if (e.description) summary.description = e.description;
  if (e.streamSpec) {
    summary.streamSpec = e.streamSpec as StackItemSummary['streamSpec'];
  }
  if (e.actions) {
    summary.actions = e.actions as StackItemSummary['actions'];
  }
  return summary;
}
