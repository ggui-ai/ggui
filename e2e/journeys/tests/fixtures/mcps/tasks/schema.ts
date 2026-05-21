/**
 * Tasks MCP — strict zod schemas for tools + entity.
 *
 * Every field here is load-bearing in contract tests: we test that
 * invalid input is rejected (strictObject → unknown fields throw) and
 * that output matches the declared shape. Schemas are the "strict"
 * half of the "Strict schemas" bar locked in the stateful-MCP
 * strategy (§7).
 *
 * Exports are split into two shapes per tool:
 *
 *   - `Xxx…Input` / `Xxx…Output` — `z.strictObject()` instances used
 *     by `store.ts` and test assertions for parse/validate.
 *   - `xxxToolInputShape` / `xxxToolOutputShape` — raw shape literals
 *     (`ZodRawShape`) used by `server.ts` to feed the MCP SDK's
 *     `registerTool`. The SDK wraps them into its own object internally.
 *
 * The duplication is deliberate — the SDK wants raw shapes, and raw
 * shapes don't carry the `.strict()` marker at the object level. The
 * `*.Input` strict-object aliases let the store validate the exact
 * shape the MCP tool advertised.
 *
 * Entity shape follows stateful-MCP strategy §8.1:
 *   `Task = { id, title, status, priority, assigneeId?, dueDate?,
 *             linkedNoteId?, createdAt, updatedAt }`.
 *
 * `createdAt` / `updatedAt` are epoch-ms integers. `dueDate` is an
 * ISO date (`YYYY-MM-DD`) — NOT a full timestamp — to keep the
 * blueprint-negotiator's surface deterministic (calendar-style date
 * edge cases are deferred to the future `calendar` fixture per §9.1).
 */
import { z } from 'zod';

// ──────────────────────────────────────────────────────────────────
// Enumerations
// ──────────────────────────────────────────────────────────────────

export const TaskStatusEnum = z.enum(['todo', 'doing', 'done', 'blocked']);
export type TaskStatus = z.infer<typeof TaskStatusEnum>;

export const TaskPriorityEnum = z.enum(['low', 'medium', 'high']);
export type TaskPriority = z.infer<typeof TaskPriorityEnum>;

export const TaskSortFieldEnum = z.enum([
  'createdAt',
  'updatedAt',
  'dueDate',
  'priority',
]);
export type TaskSortField = z.infer<typeof TaskSortFieldEnum>;

export const TaskSortDirectionEnum = z.enum(['asc', 'desc']);
export type TaskSortDirection = z.infer<typeof TaskSortDirectionEnum>;

// ──────────────────────────────────────────────────────────────────
// ISO date — `YYYY-MM-DD` only, no time component.
// ──────────────────────────────────────────────────────────────────

const IsoDateRegex = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
export const IsoDate = z
  .string()
  .regex(IsoDateRegex, 'Expected ISO date of form YYYY-MM-DD');

// ──────────────────────────────────────────────────────────────────
// Entity + create / update shapes
// ──────────────────────────────────────────────────────────────────

/**
 * The full canonical Task entity returned by every tool that emits a
 * task. `id`, `createdAt`, `updatedAt` are server-owned (populated by
 * the store on create).
 */
export const TaskEntity = z
  .object({
    id: z.string().min(1),
    title: z.string().min(1).max(500),
    status: TaskStatusEnum,
    priority: TaskPriorityEnum,
    assigneeId: z.string().min(1).nullable(),
    dueDate: IsoDate.nullable(),
    linkedNoteId: z.string().min(1).nullable(),
    createdAt: z.number().int().nonnegative(),
    updatedAt: z.number().int().nonnegative(),
  })
  .strict();
export type TaskEntity = z.infer<typeof TaskEntity>;

/**
 * Input shape for `tasks_create`. Narrow, mutable-by-client subset of
 * {@link TaskEntity} — server fields are excluded. `status` +
 * `priority` default at the zod level so clients can omit them.
 *
 * Note: `assigneeId` / `dueDate` / `linkedNoteId` are accepted as
 * either present-string or absent (not `null`) on CREATE — a null here
 * would be misleading ("I want no assignee"). UPDATE is the path that
 * accepts `null` to mean "clear this field".
 */
export const TaskCreateInput = z
  .object({
    title: z.string().min(1).max(500),
    status: TaskStatusEnum.default('todo'),
    priority: TaskPriorityEnum.default('medium'),
    assigneeId: z.string().min(1).optional(),
    dueDate: IsoDate.optional(),
    linkedNoteId: z.string().min(1).optional(),
  })
  .strict();
export type TaskCreateInput = z.infer<typeof TaskCreateInput>;

/**
 * Patch shape for `tasks_update`. Every field is optional; `null` is
 * accepted on the three nullable fields as "clear this field". Status
 * changes go through this path OR through `tasks_complete` (the
 * dedicated transition tool).
 */
export const TaskUpdatePatch = z
  .object({
    title: z.string().min(1).max(500).optional(),
    status: TaskStatusEnum.optional(),
    priority: TaskPriorityEnum.optional(),
    assigneeId: z.string().min(1).nullable().optional(),
    dueDate: IsoDate.nullable().optional(),
    linkedNoteId: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine(
    (v) => Object.keys(v).length > 0,
    'Patch must include at least one field',
  );
export type TaskUpdatePatch = z.infer<typeof TaskUpdatePatch>;

// ──────────────────────────────────────────────────────────────────
// Filter + sort + pagination
// ──────────────────────────────────────────────────────────────────

export const TaskFilter = z
  .object({
    status: z.array(TaskStatusEnum).min(1).optional(),
    assigneeId: z.string().min(1).optional(),
    priority: z.array(TaskPriorityEnum).min(1).optional(),
    dueBefore: IsoDate.optional(),
    dueOnOrAfter: IsoDate.optional(),
  })
  .strict();
export type TaskFilter = z.infer<typeof TaskFilter>;

export const TaskSort = z
  .object({
    field: TaskSortFieldEnum,
    direction: TaskSortDirectionEnum.default('asc'),
  })
  .strict();
export type TaskSort = z.infer<typeof TaskSort>;

// ──────────────────────────────────────────────────────────────────
// Per-tool input + output raw-shape literals.
//
// These are ZodRawShape (plain records, no `.strict()` at the outer
// object level) because that's what `McpServer.registerTool` expects.
// The tool handler re-parses the raw input through a `z.strictObject`
// derived from the same shape so unknown fields are rejected — the
// SDK's own zod wrap is permissive by default.
// ──────────────────────────────────────────────────────────────────

export const tasksListInputShape = {
  filter: TaskFilter.optional(),
  sort: TaskSort.optional(),
  cursor: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const tasksListOutputShape = {
  items: z.array(TaskEntity),
  nextCursor: z.string().optional(),
};

export const tasksGetInputShape = {
  id: z.string().min(1),
};

export const tasksGetOutputShape = {
  /** `null` when no task with this id exists. Clean not-found signal. */
  item: TaskEntity.nullable(),
};

export const tasksCreateInputShape = {
  input: TaskCreateInput,
};

export const tasksCreateOutputShape = {
  item: TaskEntity,
};

export const tasksUpdateInputShape = {
  id: z.string().min(1),
  patch: TaskUpdatePatch,
};

export const tasksUpdateOutputShape = {
  /** `null` when no task with this id exists. */
  item: TaskEntity.nullable(),
};

export const tasksDeleteInputShape = {
  id: z.string().min(1),
};

export const tasksDeleteOutputShape = {
  /** `false` when no task existed — idempotent. */
  deleted: z.boolean(),
};

export const tasksSearchInputShape = {
  query: z.string().min(1).max(500),
  filter: TaskFilter.optional(),
  limit: z.number().int().positive().max(200).optional(),
};

export const tasksSearchOutputShape = {
  items: z.array(TaskEntity),
  totalMatches: z.number().int().nonnegative(),
};

export const tasksCompleteInputShape = {
  id: z.string().min(1),
};

export const tasksCompleteOutputShape = {
  /** `null` when no task with this id exists. */
  item: TaskEntity.nullable(),
};

// ──────────────────────────────────────────────────────────────────
// Strict-object aliases — used by the store to validate inputs after
// the MCP SDK parses through the permissive raw-shape wrap.
// ──────────────────────────────────────────────────────────────────

export const TasksListInput = z.strictObject(tasksListInputShape);
export const TasksGetInput = z.strictObject(tasksGetInputShape);
export const TasksCreateInput = z.strictObject(tasksCreateInputShape);
export const TasksUpdateInput = z.strictObject(tasksUpdateInputShape);
export const TasksDeleteInput = z.strictObject(tasksDeleteInputShape);
export const TasksSearchInput = z.strictObject(tasksSearchInputShape);
export const TasksCompleteInput = z.strictObject(tasksCompleteInputShape);

export type TasksListInputT = z.infer<typeof TasksListInput>;
export type TasksListOutputT = {
  items: TaskEntity[];
  nextCursor?: string;
};
export type TasksGetOutputT = { item: TaskEntity | null };
export type TasksCreateOutputT = { item: TaskEntity };
export type TasksUpdateOutputT = { item: TaskEntity | null };
export type TasksDeleteOutputT = { deleted: boolean };
export type TasksSearchOutputT = {
  items: TaskEntity[];
  totalMatches: number;
};
export type TasksCompleteOutputT = { item: TaskEntity | null };
