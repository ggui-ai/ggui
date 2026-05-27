/**
 * Slice O props-echo mount — exposes `bump_count` for the
 * `props-update-roundtrip` Lane-1 fixture (companion to
 * `ui/props-echo/`).
 *
 * The single tool maintains a per-render counter (in-memory `Map`
 * keyed by `ctx.renderId`) and calls
 * `ctx.sendPropsUpdate({count: newValue})` on every dispatch. The
 * render-channel server fans a `{type:'props_update', payload:{renderId,
 * props}}` frame to the live subscriber; the renderer's iframe-runtime
 * applies the patch in-place via its existing `props_update` branch and
 * the blueprint's `data-ggui-prop-count` attribute re-stamps with the
 * new value.
 *
 * This mount is INTENTIONALLY separate from `tasks-mount.mjs` — the
 * Tasks mount owns the `tasks_*` namespace + a `tasks` channel
 * convention; muddying it with a counter tool would couple two
 * unrelated fixtures. Both mounts compose onto the same `/mcp` and
 * the same wired-action router via `composeHandlersWithMounts`
 * (collisions across mounts already throw at construction time).
 *
 * Entry-point contract per
 * `packages/project-config/src/mcp-mount-discovery.ts`:
 * export `createGguiMcpMount()` returning `{name, handlers:
 * SharedHandler[]}`. `outputSchema` MUST declare the fields the
 * handler returns (MCP SDK strips unknowns; the
 * `composeHandlersWithMounts` guardrail rejects empty shapes at
 * compose time).
 *
 * Why ctx fields are read structurally: the JS-side `handler(input,
 * ctx)` sees a runtime ctx that satisfies the static `HandlerContext`
 * type AND structurally carries the wired-action runtime fields
 * (`renderId`, `sendPropsUpdate`). See `WiredMountContext` + the slice
 * doctrine in `mcp-mounts.ts`.
 */
import { z } from 'zod';

export function createGguiMcpMount() {
  /** Per-render counter store. Keyed by `ctx.renderId` so multiple
   * concurrent renders in the same process don't share state — the
   * Lane-1 spec runs serially today, but the contract should hold for
   * parallel renders when a future fixture exercises that path. */
  const counters = new Map();

  return {
    name: 'props-echo',
    handlers: [
      {
        name: 'bump_count',
        title: 'Bump count',
        description:
          'Increment the per-render counter and push the new value via `ctx.sendPropsUpdate`. Used by the Slice O props_update round-trip fixture (`props-update-roundtrip`).',
        inputSchema: {},
        outputSchema: { count: z.number() },
        async handler(_input, ctx) {
          const renderId = ctx.renderId;
          const sendPropsUpdate = ctx.sendPropsUpdate;
          if (typeof renderId !== 'string' || renderId.length === 0) {
            throw new Error(
              'bump_count: ctx.renderId is missing — the wired-action router must thread it.',
            );
          }
          if (typeof sendPropsUpdate !== 'function') {
            throw new Error(
              'bump_count: ctx.sendPropsUpdate is missing — the wired-action router must thread it.',
            );
          }
          const previous = counters.get(renderId) ?? 0;
          const next = previous + 1;
          counters.set(renderId, next);
          // Fan-out via the channel server's `sendPropsUpdate` seam.
          // Best-effort by contract — the call returns a Promise but
          // the seam never throws (orphan + closed-socket no-ops), so
          // we can safely fire-and-forget without `await`.
          sendPropsUpdate({ count: next });
          return { count: next };
        },
      },
    ],
  };
}
