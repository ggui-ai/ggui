'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

interface Props {
  /** Compiled ESM code from `result.generation.compiledCode`. */
  compiledCode: string;
  /**
   * Origin where /runtime/{primitives,tokens}.bundle.js are served.
   * Defaults to current page's origin. Pass for cross-origin embeds.
   */
  bundleOrigin?: string;
  /** Iframe height in px. Defaults to 480. */
  height?: number;
}

const REACT_VERSION = '19.0.0';

/**
 * Renders a compiled `@ggui-ai/benchmark` component output in an iframe.
 *
 * The compiled code is ESM with bare imports for `react`, `react/jsx-runtime`,
 * `@ggui-ai/design/primitives`, and `@ggui-ai/design/tokens`. The iframe's
 * import map resolves all four:
 *   - react / jsx-runtime / react-dom → esm.sh
 *   - design specifiers → /runtime/{primitives,tokens}.bundle.js
 *     (pre-bundled by apps/benchmarks/scripts/build-design-bundle.mjs)
 *
 * No code-rewriting needed in the viewer — the import map does the work.
 *
 * Failure modes surfaced inline (visible inside the iframe):
 *   - module load error → red preformatted error in the iframe body
 *   - bundle 404 (design bundles not built yet) → same path, browser errors
 *
 * Same-origin only by design — uses a relative `/runtime/` path so the
 * embedding page's origin serves the bundles. Cross-origin embeds need
 * to pass `bundleOrigin` AND ensure CORS headers on the bundle host.
 */
export function LiveRenderFrame({ compiledCode, bundleOrigin, height = 480 }: Props) {
  const [origin, setOrigin] = useState<string | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  // Read window origin only on client (avoids SSR mismatch).
  useEffect(() => {
    setOrigin(bundleOrigin ?? window.location.origin);
  }, [bundleOrigin]);

  const srcdoc = useMemo(() => {
    if (!origin) return '';
    return buildSrcdoc(compiledCode, origin);
  }, [compiledCode, origin]);

  if (!origin) {
    return (
      <div
        className="flex items-center justify-center bg-paper-2 border border-line-2 text-ink-3 text-sm"
        style={{ height }}
      >
        loading preview…
      </div>
    );
  }

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcdoc}
      sandbox="allow-scripts allow-same-origin"
      title="Component preview"
      style={{
        width: '100%',
        height,
        border: '1px solid #D6D4CB',
        background: '#FFFFFF',
      }}
    />
  );
}

function buildSrcdoc(compiledCode: string, origin: string): string {
  const importMap = {
    imports: {
      react: `https://esm.sh/react@${REACT_VERSION}`,
      'react/jsx-runtime': `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
      'react/jsx-dev-runtime': `https://esm.sh/react@${REACT_VERSION}/jsx-runtime`,
      'react-dom': `https://esm.sh/react-dom@${REACT_VERSION}`,
      'react-dom/client': `https://esm.sh/react-dom@${REACT_VERSION}/client`,
      '@ggui-ai/design/primitives': `${origin}/runtime/primitives.bundle.js`,
      '@ggui-ai/design/tokens': `${origin}/runtime/tokens.bundle.js`,
    },
  };

  // The compiled code goes into a <script> tag verbatim — but since it
  // contains ESM `import` statements, we need it as a Blob URL inside a
  // type="module" wrapper. The wrapper script creates a Blob from a
  // string literal that we encode as JSON to safely embed any character.
  const compiledCodeJson = JSON.stringify(compiledCode);

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<script type="importmap">${JSON.stringify(importMap)}</script>
<style>
  html,body { margin:0; padding:0; background:#fff; font-family: system-ui, sans-serif; }
  #root { padding: 16px; min-height: 100%; }
  .live-render-error {
    color: #D93822;
    font-family: ui-monospace, monospace;
    font-size: 12px;
    white-space: pre-wrap;
    padding: 16px;
    background: #FBF2F1;
    border: 1px solid #D93822;
  }
</style>
</head>
<body>
<div id="root"></div>
<script type="module">
  import * as React from "react";
  import { createRoot } from "react-dom/client";

  const code = ${compiledCodeJson};
  const blob = new Blob([code], { type: "text/javascript" });
  const url = URL.createObjectURL(blob);

  try {
    const mod = await import(url);
    const Component = mod.default;
    if (typeof Component !== "function") {
      throw new Error("Compiled module has no default export (or it's not a component).");
    }
    const root = createRoot(document.getElementById("root"));
    root.render(React.createElement(Component));
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    const stack = err && err.stack ? "\\n\\n" + err.stack : "";
    document.getElementById("root").innerHTML =
      '<div class="live-render-error"><strong>Live render failed</strong>\\n' +
      msg + stack + '</div>';
  } finally {
    URL.revokeObjectURL(url);
  }
</script>
</body>
</html>`;
}
