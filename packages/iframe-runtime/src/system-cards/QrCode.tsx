/**
 * Tiny QR code component — renders a URL as a scannable SVG QR code.
 *
 * The mobile-best fallback for system cards that need to send the
 * user out to a real browser. From inside an MCP App iframe sandbox
 * (claudemcpcontent.com etc.), no JS API can spawn a browser tab —
 * `window.open` is blocked, `target="_blank"` silently fails, and
 * postMessage host-intents (`ui/request/open-url`) are speculative.
 * A QR code bypasses every sandbox limit: phone camera scans →
 * opens the URL in real Safari/Chrome with no host cooperation
 * required.
 *
 * Renders inline SVG (no canvas, no images, no network fetch). Bundle
 * cost: `qrcode-generator` is ~6 KB unminified, ~3 KB gzipped — tiny
 * compared to the alternative of "tell the user to scan a clipboard".
 */
import * as React from 'react';
import qrcodeFactory from 'qrcode-generator';

export interface QrCodeProps {
  /** URL to encode. Truncated implicitly by the QR encoder if too long. */
  readonly value: string;
  /**
   * Side length in CSS pixels. Default 128 — readable on a phone
   * camera at arm's length without being visually dominant on the
   * card.
   */
  readonly size?: number;
  /**
   * Error correction level. `M` (medium, ~15% recoverable) is the
   * default sweet spot — robust to dust / glare without bloating
   * module count for short URLs. Bump to `Q` or `H` only when
   * encoding into a high-traffic surface.
   */
  readonly errorCorrection?: 'L' | 'M' | 'Q' | 'H';
  /** Foreground color (the dots). Defaults to theme onSurface. */
  readonly foreground?: string;
  /** Background color. Defaults to theme surface. */
  readonly background?: string;
  /** Optional aria-label override. */
  readonly ariaLabel?: string;
}

/**
 * GguiSession a QR code as inline SVG. Returns `null` when the encoder
 * fails (e.g., URL too long for any error-correction level) so the
 * caller can render a fallback.
 */
export function QrCode({
  value,
  size = 128,
  errorCorrection = 'M',
  foreground = 'var(--ggui-color-onSurface, #18181b)',
  background = 'var(--ggui-color-surface, #ffffff)',
  ariaLabel,
}: QrCodeProps): React.JSX.Element | null {
  const moduleMatrix = React.useMemo(() => {
    try {
      // typeNumber=0 lets the encoder pick the smallest fit. The
      // qrcode-generator default-export is a factory function —
      // calling it returns a `qr` object with `.addData()` /
      // `.make()` / `.getModuleCount()` / `.isDark(row, col)`.
      const qr = qrcodeFactory(0, errorCorrection);
      qr.addData(value);
      qr.make();
      const count = qr.getModuleCount();
      const matrix: boolean[][] = [];
      for (let row = 0; row < count; row += 1) {
        const r: boolean[] = [];
        for (let col = 0; col < count; col += 1) {
          r.push(qr.isDark(row, col));
        }
        matrix.push(r);
      }
      return matrix;
    } catch {
      return null;
    }
  }, [value, errorCorrection]);

  if (moduleMatrix === null) return null;

  const moduleCount = moduleMatrix.length;
  // 1px viewBox per module — let CSS handle final size scaling.
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${moduleCount} ${moduleCount}`}
      width={size}
      height={size}
      role="img"
      aria-label={ariaLabel ?? `QR code for ${value}`}
      shapeRendering="crispEdges"
      style={{ display: 'block', flexShrink: 0 }}
    >
      <rect width={moduleCount} height={moduleCount} fill={background} />
      {moduleMatrix.flatMap((row, y) =>
        row.map((isDark, x) =>
          isDark ? (
            <rect
              key={`${x}-${y}`}
              x={x}
              y={y}
              width={1}
              height={1}
              fill={foreground}
            />
          ) : null,
        ),
      )}
    </svg>
  );
}
