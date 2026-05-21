/**
 * `ggui_ops_update_blueprint` — operator-class mutable-field patch.
 *
 * Patches the two mutable surfaces of a blueprint:
 *
 *   1. `isOperatorDefault` — pin as the operator default for the
 *      blueprint's `(appId, contractHash)` group. The store
 *      automatically clears any prior default in the same group
 *      (see `BlueprintStore.setOperatorDefault`).
 *   2. `variance` — partial merge into the persisted variance. Keys
 *      supplied on input overwrite; keys omitted preserve. Empty-
 *      string persona (`{persona: ""}`) is treated as removal
 *      (normalized to `undefined`).
 *
 * Immutable fields (contractHash, appId, codeS3Url, codeHash,
 * generator, createdAt, createdBy) are NOT mutable through this
 * tool — the schema doesn't accept them. Operators who want to
 * "replace" a row delete + re-generate.
 *
 * ## Audience
 *
 * `['ops']` — registered on `/ops`. NOT visible to agents on `/mcp`.
 */

import { z } from 'zod';
import {
  opsUpdateBlueprintInputSchema,
  type Blueprint,
  type BlueprintVariance,
  type OpsUpdateBlueprintInput,
  type OpsUpdateBlueprintOutput,
} from '@ggui-ai/protocol';
import type {
  BlueprintStore,
} from '@ggui-ai/mcp-server-core';
import { BlueprintNotFoundError } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { normalizePersona } from './persona-normalization.js';

const opsInputSchema = opsUpdateBlueprintInputSchema.shape;
const opsOutputSchema = {
  blueprintId: z.string().min(1),
  updatedAt: z.string().min(1),
} as const;

/**
 * Cross-tenant probe — thrown when an operator tries to update a
 * blueprint whose `appId` doesn't match `ctx.appId` resolved by the
 * upstream auth adapter. The blueprintId itself is technically
 * lookupable across tenants because the store's primary key is
 * global, but the update path scopes by caller identity.
 */
export class BlueprintAppMismatchError extends Error {
  readonly code = 'blueprint_app_mismatch' as const;
  constructor(blueprintId: string) {
    super(
      `blueprint_app_mismatch: blueprint ${JSON.stringify(blueprintId)} does not belong to the caller's app. Operators cannot mutate blueprints across tenancy.`,
    );
    this.name = 'BlueprintAppMismatchError';
  }
}

/**
 * Deps for `ggui_ops_update_blueprint`.
 */
export interface GguiOpsUpdateBlueprintDeps {
  readonly blueprintStore: BlueprintStore;
  /**
   * Optional clock injection — defaults to
   * `() => new Date().toISOString()`. Tests override.
   */
  readonly now?: () => string;
}

/**
 * Merge a partial variance patch into the persisted variance.
 * Supplied keys overwrite; omitted keys preserve. Empty-string
 * persona is treated as removal (drops the field).
 */
function mergeVariance(
  current: BlueprintVariance,
  patch: BlueprintVariance,
): BlueprintVariance {
  const next: { -readonly [K in keyof BlueprintVariance]: BlueprintVariance[K] } = {
    ...current,
  };
  if (Object.prototype.hasOwnProperty.call(patch, 'persona')) {
    const normalized = normalizePersona(patch.persona);
    if (normalized === undefined) {
      delete next.persona;
    } else {
      next.persona = normalized;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'context')) {
    if (patch.context === undefined) {
      delete next.context;
    } else {
      next.context = patch.context;
    }
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'seedPrompt')) {
    if (patch.seedPrompt === undefined) {
      delete next.seedPrompt;
    } else {
      next.seedPrompt = patch.seedPrompt;
    }
  }
  return next;
}

export function createGguiOpsUpdateBlueprintHandler(
  deps: GguiOpsUpdateBlueprintDeps,
): SharedHandler<
  typeof opsInputSchema,
  typeof opsOutputSchema,
  OpsUpdateBlueprintOutput
> {
  const now = deps.now ?? (() => new Date().toISOString());

  return {
    name: 'ggui_ops_update_blueprint',
    title: 'Update blueprint',
    audience: ['ops'],
    description:
      'Patch the mutable surface of an existing blueprint: pin/unpin operator-default + merge variance tags. Immutable fields (contractHash, appId, codeS3Url, codeHash, generator, createdAt, createdBy) are absent from the schema — to "replace" a row, delete + re-generate. Partial-merge semantics: supplied variance keys overwrite, omitted keys preserve. Empty-string persona is removal.',
    inputSchema: opsInputSchema,
    outputSchema: opsOutputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<OpsUpdateBlueprintOutput> {
      if (!ctx.appId) {
        throw new Error(
          'ggui_ops_update_blueprint: missing caller identity (appId empty)',
        );
      }
      const parsed: OpsUpdateBlueprintInput =
        opsUpdateBlueprintInputSchema.parse(rawInput);

      const existing = await deps.blueprintStore.get(parsed.blueprintId);
      if (existing === null) {
        throw new BlueprintNotFoundError(parsed.blueprintId);
      }
      if (existing.appId !== ctx.appId) {
        // Tenancy boundary — cross-app updates are a security
        // violation. The blueprint id is global but the mutation
        // scope is per-app.
        throw new BlueprintAppMismatchError(parsed.blueprintId);
      }

      // Compute the new row. Variance is partial-merged; the
      // `isOperatorDefault` toggle is applied via the store's
      // dedicated method (so the at-most-one-per-group invariant
      // holds).
      const nextVariance =
        parsed.variance === undefined
          ? existing.variance
          : mergeVariance(existing.variance, parsed.variance);

      // The store doesn't expose a generic `update` method — the
      // primary mutation path is `delete + put`. Delete the existing
      // row, then put the updated copy. The code body is
      // referenced by `codeHash`; `delete` GCs the in-memory code
      // map only when no row references the hash, so the brief
      // delete→put window does NOT lose code data because the new
      // row carries the same `codeHash`.
      await deps.blueprintStore.delete(parsed.blueprintId);
      const updatedRow: Blueprint = {
        ...existing,
        variance: nextVariance,
      };
      await deps.blueprintStore.put(updatedRow);

      // Pin as default after re-insert so `setOperatorDefault`'s
      // group lookup finds the new row.
      if (parsed.isOperatorDefault === true) {
        await deps.blueprintStore.setOperatorDefault(parsed.blueprintId);
      }

      return {
        blueprintId: parsed.blueprintId,
        updatedAt: now(),
      };
    },
  };
}
