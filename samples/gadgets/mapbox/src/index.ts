/**
 * `@ggui-samples/gadget-mapbox` — reference ggui gadget wrapper for
 * Mapbox GL JS (https://www.mapbox.com).
 *
 * This sample is the canonical end-to-end demonstration of the public
 * env channel:
 *
 *   1. The wrapper declares `requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN']`
 *      on its descriptor. The push gate refuses to push any contract
 *      using `useMapbox` unless the operator stamped that key on
 *      `App.publicEnv` first.
 *
 *   2. The hook body reads the token via `getPublicEnv(...)`. The
 *      server projects only the keys this wrapper requires (subset of
 *      `App.publicEnv`, filtered by `requires`) onto
 *      `globalThis.__ggui__.publicEnv`, and `getPublicEnv` reads from
 *      there.
 *
 * **CRITICAL wrapper-authoring rule** — call `getPublicEnv` LAZILY,
 * inside the hook body, NOT at module top level:
 *
 *   ❌ const TOKEN = getPublicEnv('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
 *   ❌ mapboxgl.accessToken = getPublicEnv(...);
 *      // (both throw at module-load — `globalThis.__ggui__` is undefined
 *      //  until the iframe runtime boots, which happens AFTER the
 *      //  wrapper bundle is fetched and evaluated.)
 *
 *   ✅ hookImpl: (opts) => {
 *        mapboxgl.accessToken = getPublicEnv('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
 *        // …mount Mapbox, return value…
 *      }
 *
 * The hook body runs on first React render — well after the runtime
 * installed `globalThis.__ggui__`. By then the registry is populated
 * and the value is available.
 *
 * **Placeholder note** — this sample currently exposes the descriptor
 * plus a stub hook body that exercises `getPublicEnv` but does not
 * actually mount a map. A full Mapbox integration would add the DOM
 * container ref, `new mapboxgl.Map(...)`, style URL, marker layer, and
 * lifecycle teardown. See `@ggui-samples/gadget-leaflet` for a
 * complete, mounted component-gadget reference.
 */

import {
  createGguiGadget,
  getPublicEnv,
  type GadgetHook,
} from '@ggui-ai/gadgets';

/** Options the consumer passes to `useMapbox()`. */
export interface MapboxOptions {
  /** Initial center as `[longitude, latitude]` (Mapbox order — note: lng first, opposite of Leaflet). */
  readonly center: readonly [number, number];
  /** Initial zoom level (Mapbox's 0..22 scale; 2 = world view). */
  readonly zoom: number;
  /**
   * Optional Mapbox style URL. Defaults to `mapbox://styles/mapbox/streets-v12`.
   * Authors using their own style declare its origin on the wrapper
   * registration's `connect[]` so CSP allowlists it.
   */
  readonly styleUrl?: string;
}

/** Value returned by `useMapbox()` once the map mounts. */
export interface MapboxValue {
  /** Mounted DOM element ref to attach via `<div ref={value.containerRef} />`. */
  readonly containerRef: (el: HTMLDivElement | null) => void;
}

/**
 * Stub hook body. Demonstrates the canonical lazy `getPublicEnv`
 * pattern: the factory's conformance check needs a function reference
 * at module-load time, but the `getPublicEnv` call lives INSIDE the
 * hook function body (NOT at module top) so it only fires after the
 * iframe runtime populated `globalThis.__ggui__`.
 *
 * The real implementation would:
 *
 *   1. `useRef<HTMLDivElement | null>(null)` for the container.
 *   2. `useEffect`: on mount, set `mapboxgl.accessToken = token` (read
 *      at the top of the hook body), construct
 *      `new mapboxgl.Map({ container, style, center, zoom })`, return
 *      a cleanup that calls `.remove()`.
 *   3. Return `{ value: { containerRef }, status: 'completed', start }`.
 *
 * The stub reads the token at the top of the body the same way the
 * real impl would — keeps the env-channel exercised on every render
 * so a test harness can observe the path without needing to drive
 * `start()` manually.
 */
const useMapboxImpl: GadgetHook<MapboxValue, MapboxOptions> = () => {
  // Lazy read inside the hook body — `globalThis.__ggui__.publicEnv`
  // is populated by the iframe runtime BEFORE any component renders.
  // The real impl would assign this to `mapboxgl.accessToken`; the
  // stub just exercises the channel so test harnesses observe the
  // read without driving `start()`.
  const token = getPublicEnv('GGUI_PUBLIC_APP_MAPBOX_TOKEN');
  void token;
  return {
    value: undefined,
    status: 'idle',
    start: async () => undefined,
  };
};

/**
 * The exported hook + descriptor. Component code imports `useMapbox`
 * and calls it like a normal React hook; operators read
 * `useMapbox.descriptor` to register the wrapper on
 * `App.gadgets` (or via `ggui.json#app.gadgets`).
 *
 * The `requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN']` line is what wires
 * the push gate: the operator MUST set this key on `App.publicEnv`
 * before any contract using `useMapbox` can push.
 */
export const useMapbox = createGguiGadget<MapboxValue, MapboxOptions>({
  hook: 'useMapbox',
  description:
    'Render an interactive Mapbox GL map with style, pan/zoom controls, and marker support. Returns a container ref to attach to a <div>.',
  usage:
    "Mount when the intent names a rendered map and the operator has stamped a Mapbox access token on App.publicEnv. Pass `center: [lng, lat]` (Mapbox uses lng-first order, opposite of Leaflet) + `zoom: 2..22`. Default style is `mapbox://styles/mapbox/streets-v12`; declare a custom `styleUrl` to use a different style (and add its origin to the wrapper registration's `connect[]`).",
  example: {
    call: 'const map = useMapbox({ center: [-122.4194, 37.7749], zoom: 12 });',
    returns: {
      status: 'completed',
      value: { containerRef: '<DOM ref callback>' },
    },
    componentSnippet:
      'function MapView() { const map = useMapbox({ center: [-122.4194, 37.7749], zoom: 12 }); return <div ref={map.value?.containerRef} style={{ height: 400 }} />; }',
  },
  gotchas:
    "Mapbox requires the container <div> to have a non-zero height before the map mounts — apply `style={{ height: 400 }}` (or similar) directly. `center` is `[longitude, latitude]` in Mapbox (opposite of Leaflet's `[lat, lng]`). The container ref MUST be stable across renders — don't recreate the callback or Mapbox will re-initialize on every render. Operators must stamp `GGUI_PUBLIC_APP_MAPBOX_TOKEN` on App.publicEnv before any contract using this hook can push (the push gate enforces this).",
  version: '0.0.1',
  requires: ['GGUI_PUBLIC_APP_MAPBOX_TOKEN'],
  package: '@ggui-samples/gadget-mapbox',
  bundleUrl: 'https://registry.ggui.ai/mapbox@0.0.1/bundle.js',
  styleUrl: 'https://registry.ggui.ai/mapbox@0.0.1/mapbox-gl.css',
  connect: ['https://api.mapbox.com', 'https://*.tiles.mapbox.com'],
  hookImpl: useMapboxImpl,
});
