/**
 * `buildRenderSourceEnvelope` — reassemble a render's generated source
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
 * A live render has no stored `DataContract` object — it carries the
 * same four fields flattened directly onto the session (`propsSpec` /
 * `actionSpec` / `streamSpec` / `contextSpec`, exactly `DataContract`'s
 * field set). Reassembled here from whichever of the four are present;
 * omitted entirely when none are. `fixtureProps` maps from the
 * render's live `props` — the actual values it is currently rendering
 * with, a natural preview-props snapshot for re-registering as a
 * blueprint.
 *
 * Only a component-variant render has generated source. `mcpApps`
 * (locator-only, no `componentCode` field at all) and `system`
 * (server-emitted card, also no `componentCode`) both throw — narrowed
 * on the real type discriminator, not a special case for `mcpApps`
 * alone, since neither non-component variant has source to return. A
 * component variant whose `componentCode` is still the empty-string
 * placeholder (created but never committed) throws the identical error
 * for the identical reason, rather than returning a hollow envelope.
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
): RenderSourceEnvelope {
  const isComponent = render.type === undefined || render.type === 'component';
  if (!isComponent || render.componentCode.length === 0) {
    throw new Error(
      isComponent
        ? `render_source_unavailable: render ${JSON.stringify(sessionId)} has no source yet — it hasn't finished its first commit`
        : `render_source_unavailable: render ${JSON.stringify(sessionId)} is a ${render.type} render — it has no generated component source to fetch`,
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
    source: render.componentCode,
    ...(contract !== undefined ? { contract } : {}),
    ...(render.props !== undefined ? { fixtureProps: render.props } : {}),
  };
}
