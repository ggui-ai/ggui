/**
 * `createGguiGetRenderSourceHandler` — read the generated source of
 * the calling app's render.
 *
 * Shared by every deployment — both the cloud server and the
 * standalone `@ggui-ai/mcp-server` compose this one factory. Data
 * plane (bare `ggui_*` wire name, `agent` audience) — the calling app
 * reads its OWN render's source, no user-identity logic anywhere.
 * Deliberately separate from the control-plane
 * `ggui_ops_get_render_source` (which a signed-in console user calls
 * to read one of their own renders by user identity, not app
 * identity) — two different callers, two different tenancy models,
 * two tools.
 *
 * Behavior:
 *   - Resolves render via `renderStore.get(sessionId)`.
 *   - Tenancy gate via `ctx.appId` — cross-tenant + missing both
 *     surface uniformly as {@link GguiSessionNotFoundError}, same
 *     posture as `ggui_get_session` (modeled on it structurally; same
 *     deps shape, minus the heartbeat — reading source once is not an
 *     activity signal, so this handler never bumps TTL).
 *   - Reassembles `{source, contract?, fixtureProps?}` via the shared
 *     {@link buildRenderSourceEnvelope} helper — the SAME function the
 *     control-plane `ggui_ops_get_render_source` uses, so the two
 *     tools' envelope shape can never drift apart even though their
 *     tenancy models differ completely.
 */

import { z } from 'zod';
import { dataContractSchema, getRenderSourceInputShape } from '@ggui-ai/protocol';
import type { GguiGetRenderSourceOutput } from '@ggui-ai/protocol';
import type { GguiSessionStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { GguiSessionNotFoundError } from './errors.js';
import { isVisibleToCaller } from './tenancy.js';
import { buildRenderSourceEnvelope } from './render-source-envelope.js';

// Canonical SSoT shape — authored once in `@ggui-ai/protocol`
// (`schemas/mcp.ts`).
const inputSchema = getRenderSourceInputShape;

const outputSchema = {
  sessionId: z.string(),
  blueprint: z.object({
    source: z.string().min(1).describe('TSX with a default-exported React component.'),
    contract: dataContractSchema
      .optional()
      .describe(
        "The DataContract envelope reassembled from the render's propsSpec/actionSpec/streamSpec/contextSpec, when any are present.",
      ),
    fixtureProps: z
      .unknown()
      .optional()
      .describe("The render's live prop values, when present — a natural preview-props snapshot."),
  }),
} as const;

export interface GguiGetRenderSourceHandlerDeps {
  readonly renderStore: GguiSessionStore;
}

export function createGguiGetRenderSourceHandler(
  deps: GguiGetRenderSourceHandlerDeps,
): SharedHandler<typeof inputSchema, typeof outputSchema, GguiGetRenderSourceOutput> {
  return {
    name: 'ggui_get_render_source',
    title: 'Get render source',
    audience: ['agent'],
    description:
      'Read the generated source of the calling app\'s render, as {sessionId, blueprint: {source, contract?, fixtureProps?}}. Only a component-variant render has source; a render created by another app, a missing sessionId, or a render with no generated component source (MCP-Apps, system-card, or not yet committed) all answer a not-found or typed no-source error rather than an empty string.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiGetRenderSourceOutput> {
      const { sessionId } = z.object(inputSchema).parse(rawInput);

      const stored = await deps.renderStore.get(sessionId);
      if (!isVisibleToCaller(stored, ctx)) {
        // Tenancy + missing both surface uniformly so cross-tenant
        // existence is not leaked. `stored` is narrowed to
        // StoredGguiSession past this guard.
        throw new GguiSessionNotFoundError(sessionId);
      }

      const blueprint = buildRenderSourceEnvelope(stored.render, sessionId);
      return { sessionId: stored.id, blueprint };
    },
  };
}
