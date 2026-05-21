/**
 * Shared zod schemas for thread-handler request parsing.
 *
 * Each schema mirrors exactly one request shape from
 * `@ggui-ai/protocol/types/thread.ts` — kept in lockstep by tests, not
 * by shared code, because the protocol types are the source of truth.
 * A schema that drifts from the protocol shape is a bug in THIS file,
 * not a need for a new protocol type.
 *
 * Handlers import `parseWithSchema` to convert zod errors into
 * {@link InvalidThreadRequestError} uniformly, so transports see one
 * error class for every shape-level rejection.
 */
import { z, type ZodType } from 'zod';
import {
  isThreadStateAction,
  THREAD_STATE_ACTIONS,
} from '@ggui-ai/protocol';
import { InvalidThreadRequestError } from './errors.js';

const threadStatusSchema = z.enum(['active', 'archived', 'pending_delete']);

const authorRoleSchema = z.enum(['user', 'agent', 'system']);
const messageKindSchema = z.enum(['text', 'card', 'event']);

export const createThreadInputSchema = z
  .object({
    appId: z.string().min(1, 'appId is required'),
    firstMessageHint: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

export const appendThreadMessageInputSchema = z
  .object({
    threadId: z.string().min(1, 'threadId is required'),
    key: z.string().min(1, 'key is required'),
    authorRole: authorRoleSchema,
    kind: messageKindSchema,
    blocks: z.array(z.unknown()),
    cardSnapshot: z.unknown().optional(),
    textPreview: z.string(),
    aiContext: z.unknown().optional(),
  })
  .strict();

export const listMessagesOptionsSchema = z
  .object({
    fromSeq: z.number().int().positive().optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
  })
  .strict();

export const listThreadsFilterSchema = z
  .object({
    status: threadStatusSchema.optional(),
    appId: z.string().min(1).optional(),
    limit: z.number().int().positive().max(500).optional(),
    cursor: z.string().optional(),
  })
  .strict();

/**
 * A ThreadStateAction string. Derived from the canonical array on the
 * protocol so any future action addition surfaces here automatically —
 * no duplicate literal list.
 */
export const threadStateActionSchema = z.custom<
  (typeof THREAD_STATE_ACTIONS)[number]
>(
  (value) => isThreadStateAction(value),
  {
    message: `must be one of: ${THREAD_STATE_ACTIONS.join(', ')}`,
  },
);

export const applyThreadActionInputSchema = z
  .object({
    action: threadStateActionSchema,
  })
  .strict();

export const observeMessagesOptionsSchema = z
  .object({
    fromSeq: z.number().int().positive().optional(),
    tail: z.boolean().optional(),
  })
  .strict();

/**
 * Parse `input` against `schema`; throw {@link InvalidThreadRequestError}
 * on failure (carrying zod's `issues` verbatim for transports that want
 * to surface them). Success returns the parsed value with full type
 * inference — the caller doesn't need its own cast.
 */
export function parseWithSchema<T>(
  schema: ZodType<T>,
  input: unknown,
  contextLabel: string,
): T {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  throw new InvalidThreadRequestError(
    `Invalid ${contextLabel}: ${result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'} — ${i.message}`)
      .join('; ')}`,
    result.error.issues,
  );
}
