/**
 * Strip Markers
 *
 * Removes `__GGUI_META__` and `__GGUI_STREAM_SPEC__` marker blocks from
 * compiled component code. These markers are injected during generation
 * for metadata extraction and must be stripped before rendering.
 */

/**
 * Remove all ggui marker blocks from compiled code.
 *
 * Strips two marker types:
 * - `__GGUI_META__....__GGUI_META_END__` — component metadata
 * - `__GGUI_STREAM_SPEC__....__GGUI_STREAM_SPEC_END__` — streaming spec
 *
 * @param code - Compiled ESM code potentially containing marker blocks
 * @returns Code with all marker blocks removed
 */
export function stripMarkers(code: string): string {
  return code
    .replace(/__GGUI_META__[\s\S]*?__GGUI_META_END__/g, '')
    .replace(/__GGUI_STREAM_SPEC__[\s\S]*?__GGUI_STREAM_SPEC_END__/g, '');
}
