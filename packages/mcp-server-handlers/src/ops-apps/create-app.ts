/**
 * `ggui_ops_create_app` — create a new app owned by the calling user.
 *
 * The owner is always the caller's own identity (`resolveOwnerSub`),
 * never a userId passed as an argument, so an operator agent can only
 * create apps for the account it acts for. The appId is minted by the
 * deployment's {@link AppsSource}: the handler never takes one from the
 * caller, and uniqueness (including any retry on a collision) is the
 * store's job. An in-memory store can use any unique string; a store
 * over a database mints ids in whatever format that database keys on.
 *
 * Pure over the {@link AppsSource} seam.
 */
import { z } from 'zod';
import { defineHandler, type ShapeOutput, type HandlerContext } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppRecord, AppsSource } from './types.js';

const inputSchema = {
  displayName: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Human-friendly label for the new app. Defaults to 'My ggui app' when absent.",
    ),
} as const;

const outputSchema = {
  appId: z.string(),
  displayName: z.string(),
  systemPrompt: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
  connectUrl: z
    .string()
    .optional()
    .describe(
      'Per-app MCP connect URL — present when the deployment exposes per-app ingress. Paste-ready for an MCP client config.',
    ),
} as const;

/** The wire shape — derived from `outputSchema`, the one source of truth (#817). */
export type CreateAppOutput = ShapeOutput<typeof outputSchema>;

export interface CreateAppDeps {
  readonly apps: AppsSource;
}

export function createCreateAppHandler(
  deps: CreateAppDeps,
) {
  return defineHandler({
    name: 'ggui_ops_create_app',
    title: 'Create app',
    audience: ['ops'],
    description:
      "Create a new app owned by the calling user. The server mints the appId (it is never an argument), displayName defaults to 'My ggui app' when absent (max 120 chars). Returns the stored app — call `ggui_ops_set_default_app({appId})` afterwards to make it the caller's default.",
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<CreateAppOutput> {
      const ownerSub = resolveOwnerSub('ggui_ops_create_app', ctx);
      const parsed = z.object(inputSchema).parse(rawInput);
      const row: AppRecord = await deps.apps.create({
        ownerSub,
        ...(parsed.displayName !== undefined
          ? { displayName: parsed.displayName }
          : {}),
      });
      return {
        appId: row.appId,
        displayName: row.displayName,
        ...(row.systemPrompt !== undefined
          ? { systemPrompt: row.systemPrompt }
          : {}),
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      };
    },
  });
}
