/**
 * A2UI server → client message shapes for the V1 provisional subset.
 *
 * V1 accepts only the write-path messages needed to render a
 * server-assembled provisional surface:
 *
 *   - `createSurface`  — open a surface with a named catalog.
 *   - `updateComponents` — add/replace components by id.
 *   - `deleteSurface`  — tear down the surface (cancellation, handoff).
 *
 * Intentionally deferred (see `@ggui-ai/preview-a2ui` scope lock):
 *
 *   - `updateDataModel` — interactive data-binding surface. Not used
 *     while the provisional UI is non-interactive in V1.
 *   - Client → server `action` / `error` messages. Preview accepts no
 *     user interactions in V1; these would reject cleanly here if a
 *     client ever tried to forward them into this parser.
 *
 * Message shape note: A2UI wraps each envelope under a discriminator
 * key (not a `type` field). `{version, createSurface: {...}}` vs
 * `{version, updateComponents: {...}}`. We honor that shape; the Zod
 * union keys on presence of the payload key rather than on a
 * dedicated discriminator string.
 */
import { z } from 'zod';
import { ComponentSchema } from './components';

/** A2UI protocol version our V1 subset targets. */
export const A2UI_MESSAGE_VERSION = 'v0.9';

const VersionLiteral = z.literal(A2UI_MESSAGE_VERSION);
const SurfaceId = z.string().min(1);

/**
 * `createSurface` — opens a named surface tied to a catalog id. In
 * ggui's wiring, `surfaceId` equals the stack item id; `catalogId`
 * points at a ggui preview catalog manifest (see `./catalog`).
 *
 * Theming / data-model bootstrapping fields from the upstream spec
 * are deferred — they're not on the V1 path and would invite scope
 * creep to accept here.
 */
export const CreateSurfaceMessageSchema = z.object({
  version: VersionLiteral,
  createSurface: z.object({
    surfaceId: SurfaceId,
    catalogId: z.string().min(1),
  }),
});
export type CreateSurfaceMessage = z.infer<typeof CreateSurfaceMessageSchema>;

/**
 * `updateComponents` — ships a batch of components for the surface.
 * Each component's id is the replace key; the client accumulates
 * them into a flat adjacency-list tree.
 *
 * Empty component arrays are legal (no-op). This matters because the
 * preamble may emit an initial `updateComponents` with just the root
 * placeholder and fill children in later frames.
 */
export const UpdateComponentsMessageSchema = z.object({
  version: VersionLiteral,
  updateComponents: z.object({
    surfaceId: SurfaceId,
    components: z.array(ComponentSchema),
  }),
});
export type UpdateComponentsMessage = z.infer<
  typeof UpdateComponentsMessageSchema
>;

/**
 * `deleteSurface` — closes the surface. Emitted on preamble
 * cancellation (fast-path hit arrived) or on handoff (final
 * component code committed and the crossfade is complete).
 */
export const DeleteSurfaceMessageSchema = z.object({
  version: VersionLiteral,
  deleteSurface: z.object({
    surfaceId: SurfaceId,
  }),
});
export type DeleteSurfaceMessage = z.infer<typeof DeleteSurfaceMessageSchema>;

/**
 * Server → client message — the V1 write-path union.
 *
 * A2UI keys its envelopes on the payload key rather than a dedicated
 * discriminator. Using `z.union` (not `z.discriminatedUnion`) is
 * deliberate: the envelope keys are distinct object keys, not values
 * of a single discriminator field, so Zod can't narrow by discriminator.
 */
export const ServerMessageSchema = z.union([
  CreateSurfaceMessageSchema,
  UpdateComponentsMessageSchema,
  DeleteSurfaceMessageSchema,
]);

export type ServerMessage =
  | CreateSurfaceMessage
  | UpdateComponentsMessage
  | DeleteSurfaceMessage;

/** Narrow parse result — mirror of the component parse result shape. */
export type ServerMessageParseResult =
  | { readonly ok: true; readonly value: ServerMessage }
  | {
      readonly ok: false;
      readonly issues: ReadonlyArray<{ path: ReadonlyArray<PropertyKey>; message: string }>;
    };

/**
 * Safe-parse one server → client A2UI message. Returns a narrow
 * discriminated result without leaking Zod internals; callers handle
 * rejection by surfacing the `issues` list or by logging + dropping.
 */
export function parseServerMessage(input: unknown): ServerMessageParseResult {
  const result = ServerMessageSchema.safeParse(input);
  if (result.success) return { ok: true, value: result.data };
  return {
    ok: false,
    issues: result.error.issues.map((issue) => ({
      path: issue.path,
      message: issue.message,
    })),
  };
}

/**
 * Narrow type guards for the discriminated consumer code. Reading
 * the payload key is the canonical shape — avoids consumers having
 * to introspect Zod-parsed objects by presence of unrelated fields.
 */
export function isCreateSurfaceMessage(
  msg: ServerMessage,
): msg is CreateSurfaceMessage {
  return 'createSurface' in msg;
}

export function isUpdateComponentsMessage(
  msg: ServerMessage,
): msg is UpdateComponentsMessage {
  return 'updateComponents' in msg;
}

export function isDeleteSurfaceMessage(
  msg: ServerMessage,
): msg is DeleteSurfaceMessage {
  return 'deleteSurface' in msg;
}
