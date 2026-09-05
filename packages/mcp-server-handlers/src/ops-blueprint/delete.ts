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
 * by the resolved effective appId (see {@link resolveEffectiveAppId}):
 * if the row exists AND its `appId` doesn't match, the handler
 * treats it as "not found from the caller's perspective" and
 * returns `{deleted: true}` — a uniform shape that doesn't leak
 * whether the id exists for another app. The store's underlying
 * delete is NOT invoked in that case. This row-level uniformity is
 * separate from (and downstream of) the app-level authorizer check:
 * a foreign `appId` input the authorizer denies surfaces the denial
 * error before the row lookup ever runs.
 *
 * ## Audience
 *
 * `['ops']` — served on `/control`. NOT visible to agents on `/mcp`.
 */

import { z } from 'zod';
import {
  opsDeleteBlueprintInputSchema,
  type OpsDeleteBlueprintInput,
  type OpsDeleteBlueprintOutput,
} from '@ggui-ai/protocol';
import type { BlueprintStore } from '@ggui-ai/mcp-server-core';
import { defineHandler, type HandlerContext } from '../types.js';
import { resolveEffectiveAppId, type OpsBlueprintAppAuthorizer } from './app-access.js';

const opsInputSchema = opsDeleteBlueprintInputSchema.shape;
const opsOutputSchema = {
  deleted: z.literal(true),
} as const;

/**
 * Deps for `ggui_ops_delete_blueprint`.
 */
export interface GguiOpsDeleteBlueprintDeps {
  readonly blueprintStore: BlueprintStore;
  /**
   * Optional app-access authorizer — when bound, consulted on EVERY
   * resolution (see {@link resolveEffectiveAppId}) to decide whether
   * the caller may curate the effective `appId`, including cross-app
   * calls that supply an explicit `appId` input different from
   * `ctx.appId`. Unbound: legacy bound-only posture, cross-app input
   * fails closed with `CrossAppCurationUnavailableError`.
   *
   * This app-level check runs BEFORE the row-level tenancy lookup
   * below: a foreign `appId` INPUT denied by the authorizer surfaces
   * the denial error, while an authorizer-approved effective appId
   * still hits the row-level uniform `{deleted: true}` posture when
   * the target row belongs to a different app (no existence leak).
   */
  readonly authorizeAppAccess?: OpsBlueprintAppAuthorizer;
}

export function createGguiOpsDeleteBlueprintHandler(
  deps: GguiOpsDeleteBlueprintDeps,
) {
  return defineHandler({
    name: 'ggui_ops_delete_blueprint',
    title: 'Delete blueprint',
    audience: ['ops'],
    description:
      "Remove a blueprint row by id. Idempotent — a second delete for the same id returns `{deleted: true}` without throwing. Cross-app probes return the same shape (no existence leak across apps). Mirrors `BlueprintStore.delete`'s no-throw contract. App-scoped variant curation for an app you operate — distinct from the personal saved-blueprint library (the _my_ tools).",
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OpsDeleteBlueprintOutput> {
      const parsed: OpsDeleteBlueprintInput =
        opsDeleteBlueprintInputSchema.parse(rawInput);

      const appId = await resolveEffectiveAppId({
        toolName: 'ggui_ops_delete_blueprint',
        inputAppId: parsed.appId,
        ctx,
        ...(deps.authorizeAppAccess ? { authorize: deps.authorizeAppAccess } : {}),
      });

      const existing = await deps.blueprintStore.get(parsed.blueprintId);
      if (existing === null) {
        // Unknown id — idempotent. Return the success shape.
        return { deleted: true };
      }
      if (existing.appId !== appId) {
        // Cross-app probe — return the success shape WITHOUT
        // actually deleting. Uniform shape across "doesn't exist"
        // and "exists for another app" prevents id-existence
        // leak across app boundaries.
        return { deleted: true };
      }
      await deps.blueprintStore.delete(parsed.blueprintId);
      return { deleted: true };
    },
  });
}
