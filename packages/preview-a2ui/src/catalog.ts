/**
 * Catalog manifest for ggui's V1 provisional A2UI subset.
 *
 * The catalog names the component types that agents (or the server-side
 * preamble, via Haiku) may emit on the `_ggui:preview` channel. The
 * renderer refuses to render anything outside this set; the validator
 * in `./components` enforces the same boundary at parse time.
 *
 * Why a dedicated catalog rather than "A2UI Basic Catalog verbatim":
 *
 *   - V1 provisional rendering covers only the subset we can render
 *     as shimmering, non-interactive shells today. Types like
 *     `Video` / `AudioPlayer` are deferred; declaring
 *     them in the catalog now would let the preamble emit shapes the
 *     renderer can't handle.
 *   - The catalog is the contract the Haiku preamble is prompted
 *     against. Keeping it small keeps the prompt cheap and the output
 *     reliable.
 *
 * Additions go through a deliberate review. This is not a place to
 * casually grow.
 */

/** Public identifier for the V1 ggui provisional catalog. */
export const GGUI_PREVIEW_CATALOG_V1_ID = 'ggui.preview.v1';

/**
 * A2UI protocol version the V1 subset targets. Pinned so upstream spec
 * changes don't silently widen what we accept.
 */
export const A2UI_V1_SUBSET_VERSION = 'v0.9';

/**
 * The V1 catalog's supported component type names. These are the ONLY
 * values of `Component.component` the parser accepts.
 */
export const GGUI_PREVIEW_CATALOG_V1_COMPONENTS = [
  'Row',
  'Column',
  'Card',
  'List',
  'Divider',
  'Text',
  'Image',
  'Icon',
  'Button',
  'TextField',
  'CheckBox',
  'ChoicePicker',
] as const;

/** Union type of every supported component name. */
export type GguiPreviewComponentType =
  (typeof GGUI_PREVIEW_CATALOG_V1_COMPONENTS)[number];

/**
 * Structural manifest — what a client advertises support for during
 * subscribe-time capability negotiation. Server-side preamble consults
 * the same shape to pick a catalog.
 */
export interface A2UICatalogManifest {
  readonly id: string;
  readonly version: string;
  readonly components: readonly string[];
}

/** The single canonical manifest for V1. */
export const GGUI_PREVIEW_CATALOG_V1: A2UICatalogManifest = {
  id: GGUI_PREVIEW_CATALOG_V1_ID,
  version: A2UI_V1_SUBSET_VERSION,
  components: GGUI_PREVIEW_CATALOG_V1_COMPONENTS,
};

/** True when `name` is a V1-supported component type. */
export function isGguiPreviewComponentType(
  name: string,
): name is GguiPreviewComponentType {
  return (GGUI_PREVIEW_CATALOG_V1_COMPONENTS as readonly string[]).includes(
    name,
  );
}
