/**
 * `buildRenderSourceEnvelope` — reassemble a render's AUTHORED source
 * into the `{source, contract?, fixtureProps?}` blueprint envelope.
 *
 * Shared by every caller that exposes a render's source for saving as
 * a blueprint — the control-plane per-user variant
 * (`ggui_ops_get_render_source`) and the data-plane
 * `ggui_get_render_source` (`createGguiGetRenderSourceHandler`, this
 * package) both import this one function so their envelope shape can
 * never drift apart. Extracted verbatim from the control-plane tool's
 * original inline logic — behavior-neutral extraction, not a rewrite.
 *
 * **`source` is the AUTHORED text, never the compiled bundle — this is
 * a hard rule, not a preference.** A save-as-blueprint flow's selfCheck
 * validates authorable ESM/TSX with a default export; a compiled
 * bundle (`var s=Object.defineProperty(…)`) fails that check every
 * time. Callers supply `authoredSource` from wherever their
 * `GguiSessionStore` persisted it (see
 * `GguiSessionStore.getAuthoredSource`) — this function never reads
 * `render.componentCode` as a source-of-last-resort; a render with no
 * reachable authored source is the 4th `render_source_unavailable`
 * case below, not a silent fallback to compiled output.
 *
 * A live render has no stored `DataContract` object — it carries the
 * same four fields flattened directly onto the session (`propsSpec` /
 * `actionSpec` / `streamSpec` / `contextSpec`, exactly `DataContract`'s
 * field set). Reassembled here from whichever of the four are present;
 * omitted entirely when none are. `fixtureProps` maps from the
 * render's live `props` — the actual values it is currently rendering
 * with, a natural preview-props snapshot for re-registering as a
 * blueprint.
 *
 * Four `render_source_unavailable` cases, all sharing one message
 * prefix so callers can match on it without parsing which case fired:
 *
 *   1. Non-component variant (`mcpApps` locator-only, `system`
 *      server-emitted card) — neither carries a `componentCode` field
 *      at all, narrowed on the real type discriminator rather than a
 *      special case for `mcpApps` alone.
 *   2. Component variant whose `componentCode` is still the
 *      empty-string placeholder — created but never committed.
 *   3. No `authoredSource` supplied — the commit that produced this
 *      render never recorded a distinct authored form (a pre-#282-
 *      authored-source render, an operator/register_blueprint-sourced
 *      render, or a deployment whose store never wired
 *      `getAuthoredSource`).
 *   4. `authoredSource` supplied but byte-identical to
 *      `render.componentCode` — the generator that produced this
 *      render never distinguished authored text from its compiled
 *      output (typical of a generator whose `sourceCode` falls back to
 *      `componentCode` when no authored text exists); a value indistinguishable from compiled
 *      output is not authored source.
 */
import type { DataContract, GguiSession } from '@ggui-ai/protocol';

export interface RenderSourceEnvelope {
  readonly source: string;
  readonly contract?: DataContract;
  readonly fixtureProps?: unknown;
}

export function buildRenderSourceEnvelope(
  render: GguiSession,
  sessionId: string,
  authoredSource: string | undefined,
): RenderSourceEnvelope {
  const isComponent = render.type === undefined || render.type === 'component';
  if (!isComponent || render.componentCode.length === 0) {
    throw new Error(
      isComponent
        ? `render_source_unavailable: render ${JSON.stringify(sessionId)} has no source yet — it hasn't finished its first commit`
        : `render_source_unavailable: render ${JSON.stringify(sessionId)} is a ${render.type} render — it has no generated component source to fetch`,
    );
  }

  if (authoredSource === undefined || authoredSource === render.componentCode) {
    throw new Error(
      `render_source_unavailable: render ${JSON.stringify(sessionId)} has no authored source on record — only compiled output is available, and compiled output is never a substitute for authored source`,
    );
  }

  const contract: DataContract | undefined =
    render.propsSpec !== undefined ||
    render.actionSpec !== undefined ||
    render.streamSpec !== undefined ||
    render.contextSpec !== undefined
      ? {
          ...(render.propsSpec !== undefined ? { propsSpec: render.propsSpec } : {}),
          ...(render.actionSpec !== undefined ? { actionSpec: render.actionSpec } : {}),
          ...(render.streamSpec !== undefined ? { streamSpec: render.streamSpec } : {}),
          ...(render.contextSpec !== undefined ? { contextSpec: render.contextSpec } : {}),
        }
      : undefined;

  return {
    source: authoredSource,
    ...(contract !== undefined ? { contract } : {}),
    ...(render.props !== undefined ? { fixtureProps: render.props } : {}),
  };
}
