/**
 * `ggui_list_gadgets` — per-app browser-capability gadget
 * catalog discovery tool.
 *
 * Returns the list of `GadgetDescriptor` declarations registered for
 * an app — the stdlib seed (`STDLIB_GADGETS` from
 * `@ggui-ai/protocol`) by default, or an operator-mutated catalog
 * once operator mutation is supported.
 *
 * ## Behavior
 *
 *   1. Validates the input shape (`{appId?: string}`). When omitted,
 *      `appId` defaults to `ctx.appId` resolved by the upstream auth
 *      adapter.
 *   2. When `appId` is supplied explicitly, asserts it matches
 *      `ctx.appId`; cross-tenant requests fail with
 *      {@link AppAccessDeniedError}.
 *   3. Reads `app.gadgets` from the bound {@link AppMetadataStore}.
 *      When the store returns `null` (app not registered — common for
 *      OSS sandbox apps that bypass an explicit register call) the
 *      handler falls back to `STDLIB_GADGETS` so callers
 *      always get a meaningful catalog. This is a permitted-error
 *      path, not a tenancy escape — `ctx.appId` was already proved
 *      by the auth adapter; the absence of a registry row just means
 *      the deployment runs default-seeded.
 *
 * ## Audience
 *
 * `['agent']` — registered on `/mcp` alongside the rest of the
 * runtime tools. NOT `ggui_protocol_*` (that family is for static
 * spec/discovery); this tool fetches RUNTIME, per-app data.
 *
 * ## Why a tool (not a static endpoint)
 *
 * Each agent gets exactly the catalog its app is configured for —
 * the same generator request fed into two apps with different
 * `gadgets` lists produces different boilerplate. A static
 * spec endpoint would have to expose every-possible-gadget, which
 * defeats per-app curation.
 */

import { z } from 'zod';
import {
  STDLIB_GADGETS,
  gadgetDescriptorSchema,
  type GadgetDescriptor,
} from '@ggui-ai/protocol';
import type { AppMetadataStore } from '@ggui-ai/mcp-server-core';
import type { HandlerContext, SharedHandler } from '../types.js';
import { AppAccessDeniedError } from './errors.js';

const inputSchema = {
  appId: z
    .string()
    .min(1)
    .optional()
    .describe(
      'The app id whose gadget catalog to return. Defaults to the caller-resolved app id from the auth header. Cross-tenant requests fail with app_access_denied.',
    ),
} as const;

/**
 * Output wire schema for one catalog entry. The handler returns
 * PACKAGE descriptors — `{package, version, exports:
 * GadgetExport[], …transport}` — so the entry schema is the
 * protocol's own {@link gadgetDescriptorSchema} re-used directly. A
 * GadgetDescriptor is a package: identity (`package`, `version`), an
 * `exports` array (≥1, each a field-presence-discriminated hook or
 * component export), and the per-package transport fields.
 *
 * Re-using the exported schema (rather than re-describing the shape)
 * makes drift between this MCP-boundary parse and the protocol
 * structurally impossible — when the descriptor shape evolves, this
 * tool's `outputSchema` evolves with it.
 */
const gadgetEntryWireSchema = gadgetDescriptorSchema;

const outputSchema = {
  gadgets: z.array(gadgetEntryWireSchema),
} as const;

export interface GguiListGadgetsHandlerDeps {
  /**
   * Per-app metadata source. The handler reads `app.gadgets`
   * off the resolved record; when `get()` returns `null` the
   * handler falls back to `STDLIB_GADGETS` (sandbox-app
   * permitted-error path).
   */
  readonly appMetadataStore: AppMetadataStore;
}

export interface GguiListGadgetsOutput {
  readonly gadgets: readonly GadgetDescriptor[];
}

export function createGguiListGadgetsHandler(
  deps: GguiListGadgetsHandlerDeps,
): SharedHandler<
  typeof inputSchema,
  typeof outputSchema,
  GguiListGadgetsOutput
> {
  return {
    name: 'ggui_list_gadgets',
    title: 'List gadgets',
    audience: ['agent'],
    description:
      'List the per-app catalog of browser-capability gadget hooks the UI may import in `clientCapabilities.gadgets[*]` of a DataContract. Returns the v1 stdlib catalog by default; operator-mutated per-app overrides ship in a follow-up slice. Pass appId to scope explicitly (must match the caller identity); omit to default to the caller-resolved app.',
    inputSchema,
    outputSchema,
    async handler(
      rawInput: Record<string, unknown>,
      ctx: HandlerContext,
    ): Promise<GguiListGadgetsOutput> {
      const parsed = z.object(inputSchema).parse(rawInput);
      const resolvedAppId = parsed.appId ?? ctx.appId;
      if (parsed.appId !== undefined && parsed.appId !== ctx.appId) {
        throw new AppAccessDeniedError();
      }

      const app = await deps.appMetadataStore.get(resolvedAppId);
      // App-not-found is a permitted-error path: ctx.appId was already
      // proved by the auth adapter; the registry row just hasn't been
      // explicitly created. Return the stdlib seed so callers always
      // get a meaningful catalog. This mirrors the cloud DDB adapter's
      // default-on-read pattern at the row-projection site.
      const gadgets = app?.gadgets ?? STDLIB_GADGETS;
      return { gadgets };
    },
  };
}
