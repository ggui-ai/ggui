/**
 * `ggui_amend` — in-place props mutation on the ALREADY-MOUNTED card
 * (#483 tool split). Same wire grammar as `ggui_update`
 * (replace/merge via the shared {@link runPropsMutation} core), the
 * opposite mount identity:
 *
 *   - NO history record: the head epoch is untouched by construction
 *     (the core advances it only for `ggui_update`).
 *   - NO `_meta.ui` on the tool DECLARATION and NO `resultMeta` — this
 *     is a plain data tool. Hosts never reserve a per-result view for
 *     it (hosts mint views from `_meta` on UI-bound success results —
 *     live-proven 2026-08-12), so nothing new appears in the
 *     conversation. The mounted card receives the new props over the
 *     live-channel ladder (WS / SSE / polling / bridge-pull); the
 *     spec tool-result forwarding path is deliberately not part of
 *     this tool's contract.
 *
 * Git reading: `ggui_update` = commit (new history entry);
 * `ggui_amend` = commit --amend (fix up the current one).
 */
import {
  amendOutputSchema,
  type GguiAmendOutput,
} from '@ggui-ai/protocol';
import type { HandlerContext, SharedHandler } from '../types.js';
import {
  mutationInputSchema,
  runPropsMutation,
} from './props-mutation-core.js';
import type { GguiUpdateHandlerDeps } from './update.js';

/**
 * Same seam set as `ggui_update` on purpose — the two tools share ONE
 * mutation core, so composers wire ONE deps object for both. The
 * slice-meta options (`mintWsToken` / `runtimeUrl` / theme plumbing)
 * are simply never read on the amend path (no result meta exists to
 * emit them into).
 */
export type GguiAmendHandlerDeps = GguiUpdateHandlerDeps;

/**
 * Canonical wire output shape — pulled from `@ggui-ai/protocol`'s
 * `amendOutputSchema`, the same way `ggui_update` pulls
 * `updateOutputSchema` and `ggui_render` pulls `renderOutputSchema`.
 * `.shape` unpacks the zod object back to a field-record for
 * SharedHandler's type-level inference and for MCP registration.
 *
 * The field docs — including the `.describe()` strings that reach an
 * agent through `tools/list` — live on the schema in
 * `@ggui-ai/protocol`; restating them here is what made this a
 * parallel declaration (ggui#798). The one claim worth keeping local
 * is the NO-resultMeta pin below, which is about this handler rather
 * than about the wire shape.
 */
const outputSchema = amendOutputSchema.shape;


/**
 * Build the OSS `ggui_amend` handler. Additive, like `update:` — server
 * composers opt in via the dedicated `amend:` slot.
 */
export function createGguiAmendHandler(
  deps: GguiAmendHandlerDeps,
): SharedHandler<
  typeof mutationInputSchema,
  typeof outputSchema,
  GguiAmendOutput
> {
  return {
    name: 'ggui_amend',
    title: 'Amend',
    // Deliberately NO `_meta` — see the module docstring. Declaring
    // the UI binding here would make hosts treat amend results as
    // renderable views, which is exactly what this tool exists to
    // avoid.
    audience: ['agent'],
    description:
      deps.description ??
      "Update the rendered UI's props IN PLACE — repaint the currently mounted card without adding a new card to the conversation; the history number does not advance. This is the DEFAULT mutation of the render/update family for reacting to user gestures (see ggui_update for the new-card variant). USE THIS AFTER ANY DOMAIN-TOOL CALL THAT CHANGED DATA THE UI SHOWS — e.g. you handled a `todo_toggle`/`cart_add`/`note_save` event from `ggui_consume`, mutated backend state, and the user is staring at stale props. Skipping this leaves the card frozen on the old state and is the #1 wire bug. Pattern: `consume → domain-tool → ggui_amend → loop`. The card repaints WITHOUT losing scroll position, focus, or uncommitted input.  Two mutation modes:  (1) `{sessionId, kind:'replace', props}` — full props replacement.  (2) `{sessionId, kind:'merge', patch}` — RFC 7396 JSON Merge Patch; send ONLY the delta (null deletes a key; arrays fully replace). Prefer `merge` after a single domain-tool mutation.  Both modes validate the FINAL props against the GguiSession's `propsSpec` (when declared) and reject on violation.  For a state MILESTONE that deserves its own new card in the conversation — or when the original card is no longer visible or usable — use ggui_update instead (it renders the state as a new card and advances the history number).",
    inputSchema: mutationInputSchema,
    outputSchema,
    async handler(input, ctx: HandlerContext): Promise<GguiAmendOutput> {
      const r = await runPropsMutation(deps, 'ggui_amend', input, ctx);
      return {
        sessionId: r.sessionId,
        updated: r.updated,
        resourceUri: r.mountResourceUri,
        ...(r.warning !== undefined ? { warning: r.warning } : {}),
        ...(r.propsSchemaHash !== undefined
          ? { propsSchemaHash: r.propsSchemaHash }
          : {}),
        ...(r.propsSchemaProfile !== undefined
          ? { propsSchemaProfile: r.propsSchemaProfile }
          : {}),
      };
    },
    // NO resultMeta — a `_meta`-carrying success result would make
    // hosts mint a per-result view (live-proven), defeating the tool.
  };
}
