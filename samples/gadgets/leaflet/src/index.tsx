/**
 * `@ggui-samples/gadget-leaflet` — reference ggui COMPONENT gadget for
 * Leaflet (https://leafletjs.com).
 *
 * This package exposes a component gadget. Rather than handing the
 * caller a `containerRef` to attach by hand, the
 * `LeafletMap` component owns the whole thing — the container `<div>`,
 * its sizing, the `L.map()` lifecycle, marker sync, tile-layer swaps,
 * and teardown. Generated UI code renders it declaratively:
 *
 *   ```tsx
 *   <LeafletMap center={[37.77, -122.42]} zoom={12}
 *     markers={[{ lat: 37.78, lng: -122.40, label: 'Pickup' }]} />
 *   ```
 *
 * No ref dance, no "give the div a non-zero height" gotcha — the
 * component applies a default 400px height itself. Changing `center` /
 * `zoom` / `markers` props re-drives the map; React idiom throughout.
 *
 * End-to-end use of the {@link defineGadgetPackage} SDK: one package
 * descriptor with a single component export. Self-bundles Leaflet at
 * build time (npm dep) — no runtime CDN load for the library. Leaflet's
 * CSS rides on the descriptor's `styleUrl`.
 *
 * # Marker icon URL workaround
 *
 * Leaflet's default marker icons resolve at module-load time against
 * the CSS file's location (relative URLs in `leaflet.css`). Under any
 * bundler that doesn't ship a sibling `images/` folder, the icons 404.
 * The two-line patch below (`delete _getIconUrl` +
 * `Icon.Default.mergeOptions`) pins absolute unpkg URLs so markers
 * render without operator-side asset hosting.
 */

import { useEffect, useRef, type ReactElement } from 'react';
import L from 'leaflet';
import { defineGadgetPackage } from '@ggui-ai/gadgets';

const LEAFLET_VERSION = '1.9.4';
const LEAFLET_CDN_BASE = `https://unpkg.com/leaflet@${LEAFLET_VERSION}/dist`;
const DEFAULT_TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const DEFAULT_TILE_ATTRIBUTION = '© OpenStreetMap contributors';
const DEFAULT_HEIGHT = 400;

// Pin marker icons to absolute unpkg URLs. Leaflet's default resolution
// uses the CSS file's location; under any bundler that doesn't ship a
// sibling `images/` folder the icons 404. Run once at module load —
// `Icon.Default` is global state so every map mount inherits the pins.
type LeafletIconDefaultProto = {
  _getIconUrl?: unknown;
};
delete (L.Icon.Default.prototype as LeafletIconDefaultProto)._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: `${LEAFLET_CDN_BASE}/images/marker-icon-2x.png`,
  iconUrl: `${LEAFLET_CDN_BASE}/images/marker-icon.png`,
  shadowUrl: `${LEAFLET_CDN_BASE}/images/marker-shadow.png`,
});

/** A single marker on the map. */
export interface LeafletMarker {
  /** Stable id used to diff markers across renders. Optional — absent
   * ids fall back to lat/lng identity. */
  readonly id?: string;
  /** Marker latitude. */
  readonly lat: number;
  /** Marker longitude. */
  readonly lng: number;
  /** Optional popup text. When set, clicking the marker opens a
   * Leaflet popup with this content. */
  readonly label?: string;
}

/** Props for the {@link LeafletMap} component gadget. */
export interface LeafletMapProps {
  /** Map center as `[latitude, longitude]`. Changing it pans the map. */
  readonly center: readonly [number, number];
  /** Zoom level (Leaflet's 0..20 scale; 2 = world view). Changing it
   * re-zooms the map. */
  readonly zoom: number;
  /** Markers to render. Synced on each render — adds, removes, and id
   * changes propagate automatically. */
  readonly markers?: readonly LeafletMarker[];
  /** Tile-layer template URL. Defaults to OpenStreetMap's standard
   * tiles. A custom provider origin must be on the descriptor's
   * `connect[]` so CSP allowlists it. */
  readonly tileUrl?: string;
  /** Attribution string under the tiles. Defaults to the OSM credit. */
  readonly attribution?: string;
  /** Map height in CSS pixels. Defaults to `400`. */
  readonly height?: number;
  /** Optional class applied to the map container `<div>`. */
  readonly className?: string;
}

/** Author id wins; fall back to `<lat>,<lng>` so unkeyed markers still
 * diff correctly (move-by-coords = remove + re-add). */
function markerKey(marker: LeafletMarker): string {
  return marker.id ?? `${marker.lat},${marker.lng}`;
}

/** Reconcile the live marker layer against the next declared set. */
function syncMarkers(
  map: L.Map,
  store: Map<string, L.Marker>,
  next: readonly LeafletMarker[] | undefined,
): void {
  const nextKeys = new Set<string>();
  for (const declared of next ?? []) {
    const key = markerKey(declared);
    nextKeys.add(key);
    if (store.has(key)) continue;
    const marker = L.marker([declared.lat, declared.lng]).addTo(map);
    if (typeof declared.label === 'string' && declared.label.length > 0) {
      marker.bindPopup(declared.label);
    }
    store.set(key, marker);
  }
  for (const [key, marker] of store) {
    if (!nextKeys.has(key)) {
      marker.remove();
      store.delete(key);
    }
  }
}

/**
 * Render an interactive Leaflet map. The component owns the container
 * `<div>`, the map lifecycle, and teardown — callers just pass props.
 */
export function LeafletMap(props: LeafletMapProps): ReactElement {
  const {
    center,
    zoom,
    markers,
    tileUrl,
    attribution,
    height = DEFAULT_HEIGHT,
    className,
  } = props;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const tileRef = useRef<L.TileLayer | null>(null);
  const markersRef = useRef<Map<string, L.Marker>>(new Map());
  // Live snapshot of the latest props for the mount-once effect, which
  // reads them without listing each as a dependency.
  const propsRef = useRef(props);
  propsRef.current = props;

  // Mount the map once on first attach; tear it down on unmount.
  useEffect(() => {
    const el = containerRef.current;
    if (el === null) return;
    const initial = propsRef.current;
    const map = L.map(el).setView(
      [initial.center[0], initial.center[1]],
      initial.zoom,
    );
    tileRef.current = L.tileLayer(initial.tileUrl ?? DEFAULT_TILE_URL, {
      attribution: initial.attribution ?? DEFAULT_TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
    syncMarkers(map, markersRef.current, initial.markers);
    mapRef.current = map;
    return () => {
      map.remove();
      mapRef.current = null;
      tileRef.current = null;
      markersRef.current.clear();
    };
  }, []);

  // Re-center / re-zoom when those props change.
  useEffect(() => {
    if (mapRef.current === null) return;
    mapRef.current.setView([center[0], center[1]], zoom);
  }, [center, zoom]);

  // Sync the marker layer when `markers` changes.
  useEffect(() => {
    if (mapRef.current === null) return;
    syncMarkers(mapRef.current, markersRef.current, markers);
  }, [markers]);

  // Swap the tile layer when its URL or attribution changes.
  useEffect(() => {
    const map = mapRef.current;
    if (map === null) return;
    tileRef.current?.remove();
    tileRef.current = L.tileLayer(tileUrl ?? DEFAULT_TILE_URL, {
      attribution: attribution ?? DEFAULT_TILE_ATTRIBUTION,
      maxZoom: 19,
    }).addTo(map);
  }, [tileUrl, attribution]);

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ height, width: '100%' }}
    />
  );
}

/**
 * The registry descriptor for the Leaflet package. Operators register
 * this on `App.gadgets` (or via `ggui.json#app.gadgets`); generated
 * component code imports `LeafletMap` directly and renders it.
 */
export const leafletGadget = defineGadgetPackage({
  package: '@ggui-samples/gadget-leaflet',
  version: '0.0.1',
  styleUrl: `${LEAFLET_CDN_BASE}/leaflet.css`,
  connect: ['https://tile.openstreetmap.org', 'https://unpkg.com'],
  exports: [
    {
      component: 'LeafletMap',
      impl: LeafletMap,
      description:
        'Render an interactive Leaflet map with a tile layer, pan/zoom, and optional markers. The component owns the container, sizing, and lifecycle.',
      usage:
        'Render `<LeafletMap center={[lat, lng]} zoom={2..20} />` when the intent names a rendered map (location browsing, route preview, delivery tracking, points-of-interest). Optional `markers={[{ lat, lng, label? }]}` plot pins; optional `tileUrl` swaps the OpenStreetMap default; optional `height` (default 400) sizes the map.',
      example: {
        componentSnippet:
          'function DeliveryMap({ center, deliveries }: Props) { return <LeafletMap center={center} zoom={12} markers={deliveries.map((d) => ({ id: d.id, lat: d.lat, lng: d.lng, label: d.label }))} />; }',
        props: {
          center: [37.7749, -122.4194],
          zoom: 12,
          markers: [{ lat: 37.78, lng: -122.4, label: 'Pickup' }],
        },
      },
      gotchas:
        'The component owns map sizing (default 400px height; override with the `height` prop) and the full Leaflet lifecycle — just render `<LeafletMap center={[lat, lng]} zoom={n} />`. Do NOT import `leaflet` directly or hand-roll a container ref. `center` is `[latitude, longitude]`.',
    },
  ],
});
