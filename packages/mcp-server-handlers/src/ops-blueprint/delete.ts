/**
 * `ggui_ops_delete_blueprint` — operator-class idempotent removal.
 *
 * Removes a blueprint row by id. Idempotent — a second delete for
 * the same id returns `{deleted: true}` without throwing, matching
 * `BlueprintStore.delete`'s no-throw contract.
 *
 * ## Tenancy
 *
 * The blueprint id is globally unique, but the delete path scopes
 * by `ctx.appId`: if the row exists AND its `appId` doesn't match
 * the caller's, the handler treats it as "not found from the
 * caller's perspective" and returns `{deleted: true}` — a uniform
 * shape that doesn't leak whether the id exists in another tenant.
 * The store's underlying delete is NOT invoked in that case.
 *
 * ## Audience
 *
 * `['ops']` — registered on `/ops`. NOT visible to agents on `/mcp`.
 */

import { z } from 'zod';
import {
  opsDeleteBlueprintInputSchema,
  type OpsDeleteBlueprintInput,
  type OpsDeleteBlueprintOutput,
} from '@ggui-ai/protocol';
import type { BlueprintStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';

const opsInputSchema = opsDeleteBlueprintInputSchema.shape;
const opsOutputSchema = {
  deleted: z.literal(true),
} as const;

/**
 * Deps for `ggui_ops_delete_blueprint`.
 */
export interface GguiOpsDeleteBlueprintDeps {
  readonly blueprintStore: BlueprintStore;
}

export function createGguiOpsDeleteBlueprintHandler(
  deps: GguiOpsDeleteBlueprintDeps,
): SharedHandler<
  typeof opsInputSchema,
  typeof opsOutputSchema,
  OpsDeleteBlueprintOutput
> {
  return {
    name: 'ggui_ops_delete_blueprint',
    title: 'Delete blueprint',
    audience: ['ops'],
    description:
      "Remove a blueprint row by id. Idempotent — a second delete for the same id returns `{deleted: true}` without throwing. Cross-tenant probes return the same shape (no existence leak across apps). Mirrors `BlueprintStore.delete`'s no-throw contract.",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OpsDeleteBlueprintOutput> {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_delete_blueprint: missing caller identity (appId empty)',
        );
      }
      const parsed: OpsDeleteBlueprintInput =
        opsDeleteBlueprintInputSchema.parse(rawInput);

      const existing = await deps.blueprintStore.get(parsed.blueprintId);
      if (existing === null) {
        // Unknown id — idempotent. Return the success shape.
        return { deleted: true };
      }
      if (existing.appId !== ctx.appId) {
        // Cross-tenant probe — return the success shape WITHOUT
        // actually deleting. Uniform shape across "doesn't exist"
        // and "exists in another tenant" prevents id-existence
        // leak across app boundaries.
        return { deleted: true };
      }
      await deps.blueprintStore.delete(parsed.blueprintId);
      return { deleted: true };
    },
  };
}
