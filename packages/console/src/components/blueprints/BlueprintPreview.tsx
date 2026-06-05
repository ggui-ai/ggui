/**
 * Iframe wrapper for previewing a generated blueprint variant.
 *
 * Reuses the established `/preview/<blueprintId>` deep-link surface
 * (see `BlueprintViewer` + `router.parseRoute`). When the variant has
 * `codeHash` present, the iframe loads the preview page; when the
 * blueprint is pending generation (no `codeHash`), the component
 * surfaces a "pending" placeholder rather than mounting a broken
 * iframe.
 *
 * **Why iframe and not in-process `GguiSessionRenderer`.** Blueprint
 * variant code lives in S3 (cloud) or an in-memory map (OSS); to
 * fetch it for in-process render the SPA would need a code-body REST
 * endpoint the console does not have. The iframe approach pushes
 * that fetch into the existing preview transport, which already
 * knows how to resolve a blueprint id → code body. Renders may 404
 * if the variant store isn't wired to the preview endpoint; that's
 * an operator signal, not a console bug.
 *
 * Test contract (data-attrs):
 *
 *   - `data-ggui-variant-preview` on the wrapper.
 *   - `data-ggui-variant-preview-id={blueprintId}` for identity.
 *   - `data-ggui-variant-preview-state="ready"|"pending"|"empty"` so
 *     specs can assert which branch rendered without inspecting
 *     iframe internals.
 */
import type { ReactElement } from 'react';
import type { Blueprint } from '@ggui-ai/protocol';
import { StatusBadge } from '../../brand/StatusBadge.js';

export interface BlueprintPreviewProps {
  readonly blueprint: Blueprint;
  /** Optional iframe height. Defaults to 320px — operator can size
   *  larger when comparing many variants on one screen. */
  readonly height?: number;
  /** Optional title for screen-reader / a11y labelling. Defaults to
   *  the blueprint's persona or a placeholder. */
  readonly title?: string;
}

export function BlueprintPreview({
  blueprint,
  height,
  title,
}: BlueprintPreviewProps): ReactElement {
  const hasCode = typeof blueprint.codeHash === 'string';
  const label =
    title ??
    blueprint.variance.persona ??
    `variant ${blueprint.blueprintId.slice(0, 8)}`;
  if (!hasCode) {
    return (
      <div
        data-ggui-variant-preview
        data-ggui-variant-preview-id={blueprint.blueprintId}
        data-ggui-variant-preview-state="pending"
        className="ggui-card"
        style={{
          height: height ?? 320,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <div style={{ textAlign: 'center' }}>
          <p className="ggui-body" style={{ margin: 0 }}>
            <StatusBadge tone="draft">pending</StatusBadge>
          </p>
          <p className="ggui-muted" style={{ margin: '8px 0 0' }}>
            This variant has no code yet — the next render against the
            same contract will gen against{' '}
            <code className="ggui-code">{blueprint.blueprintId}</code>.
          </p>
        </div>
      </div>
    );
  }
  const previewUrl = `/preview/${encodeURIComponent(blueprint.blueprintId)}`;
  return (
    <div
      data-ggui-variant-preview
      data-ggui-variant-preview-id={blueprint.blueprintId}
      data-ggui-variant-preview-state="ready"
      className="ggui-pane"
    >
      <div className="ggui-pane__head">
        <div className="ggui-pane__traffic" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <span className="ggui-pane__title">{label}</span>
        <span className="ggui-pane__meta">
          <code className="ggui-code">
            {blueprint.codeHash?.slice(0, 12)}…
          </code>
        </span>
      </div>
      <div className="ggui-pane__body" style={{ padding: 0 }}>
        <iframe
          src={previewUrl}
          title={`Preview of ${label}`}
          // `sandbox` keeps the variant's JS isolated from the console;
          // `allow-same-origin` is required so the preview surface can
          // hit the server's own static asset URLs. `allow-scripts`
          // lets the rendered component mount.
          sandbox="allow-scripts allow-same-origin"
          style={{
            width: '100%',
            height: height ?? 320,
            border: 'none',
            display: 'block',
          }}
        />
      </div>
    </div>
  );
}

/**
 * Empty placeholder when the operator hasn't picked any variant yet
 * (e.g. before the first list fetch resolves). Same data-attrs so
 * browser specs can target a stable state.
 */
export function BlueprintPreviewEmpty({
  message,
}: {
  readonly message: string;
}): ReactElement {
  return (
    <div
      data-ggui-variant-preview
      data-ggui-variant-preview-state="empty"
      className="ggui-card"
      style={{
        height: 320,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <p className="ggui-muted" style={{ margin: 0 }}>
        {message}
      </p>
    </div>
  );
}
