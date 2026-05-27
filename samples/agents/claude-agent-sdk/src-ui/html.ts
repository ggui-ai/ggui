/**
 * Client-side iframe shell builder for AppRenderer.
 *
 * The sample-agent host receives the render slice envelope
 * (`{ "ai.ggui/render": {...} }`) either inline on the tool_result's
 * `_meta` field (Anthropic SDK strips `_meta` from result blocks today;
 * other SDKs may not) or recovered via `/api/renders/:id/state`. Either
 * way, we mint the iframe HTML LOCALLY rather than fetching a public
 * shortCode URL (R5 retired `/r/<shortCode>`).
 *
 * The minted HTML mirrors `buildSelfContainedShell` from
 * `@ggui-ai/mcp-server` — same shape the iframe-runtime expects to parse
 * out of the `__GGUI_META__` global at boot.
 */

/**
 * Compose the iframe HTML for one render from a slice envelope.
 *
 * @param envelope - Wire-shape `{ "ai.ggui/render": {...} }`
 *                   from `toMcpAppEnvelope(meta)`.
 */
export function buildSelfContainedHtml(envelope: Record<string, unknown>): string {
  const renderSlice = envelope['ai.ggui/render'] as
    | { runtimeUrl?: unknown }
    | undefined;
  const runtimeUrl =
    typeof renderSlice?.runtimeUrl === 'string' ? renderSlice.runtimeUrl : '';
  if (runtimeUrl.length === 0) {
    return `<!doctype html><html><body><pre style="font:14px system-ui,sans-serif;color:#c00;padding:24px">ggui meta missing runtimeUrl</pre></body></html>`;
  }
  // JSON-stringify then escape characters that break HTML / JS parsers
  // when embedded inline. U+2028 / U+2029 are JS-source line
  // terminators that JSON allows but historic JS parsers choked on.
  const json = JSON.stringify(envelope)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
    .replace(/ /g, '\\u2028')
    .replace(/ /g, '\\u2029');
  const safeRuntimeUrl = runtimeUrl
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>ggui render</title></head>
<body>
<div id="ggui-root" data-ggui-shell="self-contained"></div>
<script>window.__GGUI_META__ = ${json};</script>
<script type="module" crossorigin="anonymous" src="${safeRuntimeUrl}"></script>
</body></html>`;
}
