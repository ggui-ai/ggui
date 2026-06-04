/**
 * Props-echo blueprint — paired with ggui.ui.json.
 *
 * The Slice O props_update round-trip witness. Renders a server-driven
 * `count` prop into the DOM (stamped on `data-ggui-prop-count` for the
 * Lane-1 spec to assert) and exposes a `bump` button that fires the
 * `bump_count` wired action. The companion mount tool in
 * `tasks-mount.mjs` (extended in this slice) increments per-render
 * state and calls `ctx.sendPropsUpdate(ctx.pageId, {count: newValue})`,
 * which fans a `{type:'props_update', payload:{pageId, props}}` frame
 * to the live subscriber. The renderer's iframe-runtime applies the
 * new props in-place via its existing `props_update` branch, and the
 * DOM stamps the new value.
 *
 * Default `count = 0` covers the cold-start path: the render is
 * appended without seeded `props`, so the renderer passes `props ??
 * {}` to the component on initial mount; we guard with
 * `count ?? 0` so the first render asserts the baseline value
 * before any wired action has fired.
 *
 * NOT a useStream consumer — `count` flows over the wire-level
 * `props_update` channel, NOT a streamSpec channel. That's the
 * point of this fixture: prove the props_update round-trip works
 * end-to-end without conflating it with the streamSpec refresh
 * pass that `todo-list` already exercises.
 */
import { useAction } from '@ggui-ai/wire';

interface PropsEchoProps {
  readonly count?: number;
}

export default function PropsEcho(props: PropsEchoProps): JSX.Element {
  const count = props.count ?? 0;
  const bump = useAction('bump');

  return (
    <article
      data-testid="props-echo-blueprint"
      style={{ fontFamily: 'system-ui', maxWidth: 480, padding: 16 }}
    >
      <header style={{ marginBottom: 12 }}>
        <h1 style={{ fontSize: 24, margin: 0 }}>Props echo</h1>
        <p style={{ color: '#666', fontSize: 13, margin: '4px 0 0' }}>
          Server-driven prop via <code>props_update</code>.
        </p>
      </header>

      <div
        data-ggui-prop-count={String(count)}
        style={{
          fontSize: 32,
          fontWeight: 600,
          padding: '12px 16px',
          background: '#f5f5f5',
          borderRadius: 6,
          marginBottom: 12,
          textAlign: 'center',
        }}
      >
        {count}
      </div>

      <button
        data-testid="bump"
        onClick={() => {
          // Fires `data:submit` with `action: 'bump'` → `bump_count` via
          // the wiredActionRouter. The mount tool mutates per-render
          // counter state and calls `ctx.sendPropsUpdate(ctx.pageId,
          // {count: newValue})`. The renderer applies the patch
          // in-place, the DOM re-stamps `data-ggui-prop-count`, and
          // the spec's `toHaveAttribute` resolves.
          bump({});
        }}
        style={{
          width: '100%',
          padding: '10px 16px',
          background: '#292929',
          color: '#fff',
          border: 0,
          borderRadius: 4,
          cursor: 'pointer',
          fontSize: 14,
        }}
      >
        +1
      </button>
    </article>
  );
}
