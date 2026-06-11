/**
 * `ggui_ops_create_app` — provision a fresh `GguiApp` owned by the
 * calling user. Sibling of the `provisionGguiApp` AppSync mutation
 * (`backend/amplify/data/create-app/handler.ts`); same identity gate
 * (caller's sub, NEVER an argument-supplied userId), same default
 * displayName, same server-side appId allocation — exposed through
 * the `ops` MCP surface so an LLM agent in the console can create an
 * app without a custom GraphQL call.
 *
 * Pure over the {@link AppsSource} seam. AppId minting + collision
 * retry is the adapter's responsibility — the in-memory test fake
 * picks any unique string; the cloud adapter calls the existing
 * `provisionGguiApp` Lambda which already enforces base62 + retry.
 */
import { z } from 'zod';
import type { HandlerContext, SharedHandler } from '../types.js';
import { resolveOwnerSub } from './identity.js';
import type { AppRecord, AppsSource } from './types.js';

const inputSchema = {
  displayName: z
    .string()
    .min(1)
    .max(120)
    .optional()
    .describe(
      "Human-friendly label for the new app. Defaults to 'My ggui app' when absent — the same label the deployment's first-load auto-create uses.",
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

export interface CreateAppOutput {
  readonly appId: string;
  readonly displayName: string;
  readonly systemPrompt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  /**
   * Per-app MCP connect URL. Optional: emitted only by deployments
   * that expose per-app ingress (this handler has no ingress
   * knowledge, so the default composition never sets it).
   */
  readonly connectUrl?: string;
}

export interface CreateAppDeps {
  readonly apps: AppsSource;
}

export function createCreateAppHandler(
  deps: CreateAppDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, CreateAppOutput> {
  return {
    name: 'ggui_ops_create_app',
    title: 'Create app',
    audience: ['ops'],
    description:
      "Provision a fresh `GguiApp` owned by the calling user: an opaque base62 appId is minted server-side, the row is owned by the caller's identity, displayName defaults to 'My ggui app' when absent (cap 120 chars). Returns the persisted shape — call `ggui_ops_set_default_app({appId})` afterwards to promote the new app to the user's default.",
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
  };
}
