// packages/ui-gen/src/design-mode.ts
//
// The ONE definition of the `designMode` option and the rendering-canvas
// vocabulary. Every triad surface (system prompt, boilerplate, tier-0
// gate, axis checks, evaluator criteria) imports these types from here —
// nothing re-declares the union.
//
//   - `constrained` (default) — today's triad: the component composes
//     from the `@ggui-ai/design` primitives, prop enums and spacing
//     scale, and tier-0 enforces the design vocabulary. Byte-identical
//     to the pre-`designMode` behaviour (pinned by
//     `design-mode.pin.test.ts`).
//   - `free` — the design vocabulary is relaxed: raw HTML elements,
//     inline styles and `<style>` blocks are allowed; the design package
//     is importable but optional. Every HARD contract stays: the data
//     contract via the boilerplate-typed wire hooks, the import
//     allowlist + security bans, the host envelope, the budgets, the
//     blueprint-reuse shape, and brand-bearing color via the closed
//     `--ggui-color-*` token manifest (no literals, no fallbacks).

export const DESIGN_MODES = ["constrained", "free"] as const;

export type DesignMode = (typeof DESIGN_MODES)[number];

export const DEFAULT_DESIGN_MODE: DesignMode = "constrained";

// ─── Rendering canvas ───────────────────────────────────────────────────────
//
// The canvas class the generated component is told it renders into —
// `free` mode only (the `constrained` prompt keeps its shell/screen
// descriptors byte-for-byte). Mapped from today's shell × screen
// descriptors when the caller has no better signal; a caller that knows
// the host's `containerDimensions` passes the class explicitly.

export const RENDER_CANVASES = ["xs-card", "mobile", "md", "lg", "xl"] as const;

export type RenderCanvas = (typeof RENDER_CANVASES)[number];

export interface CanvasDescriptor {
  /** Short human label. */
  readonly label: string;
  /** Inclusive width range the component must look right across, CSS px. */
  readonly minWidthPx: number;
  readonly maxWidthPx: number;
  /** What the host draws around the component at this canvas. */
  readonly host: string;
}

export const CANVAS_DESCRIPTORS: Readonly<Record<RenderCanvas, CanvasDescriptor>> = {
  "xs-card": {
    label: "extra-small inline card",
    minWidthPx: 320,
    maxWidthPx: 480,
    host: "an inline card inside a chat message bubble — the host draws the card border, shadow and rounded corners; the component fills the bubble width and takes its natural height",
  },
  mobile: {
    label: "mobile fullscreen",
    minWidthPx: 360,
    maxWidthPx: 600,
    host: "a phone-sized viewport the component owns edge to edge — single column, touch targets at least 44px, the component manages its own scroll",
  },
  md: {
    label: "medium panel",
    minWidthPx: 600,
    maxWidthPx: 1024,
    host: "a tablet viewport or a floating panel (spatial / picture-in-picture) — one or two columns, medium density",
  },
  lg: {
    label: "large fullscreen",
    minWidthPx: 1024,
    maxWidthPx: 1440,
    host: "a desktop viewport the component owns edge to edge — multi-column layouts, hover states and pointer interactions are available",
  },
  xl: {
    label: "extra-large fullscreen",
    minWidthPx: 1440,
    maxWidthPx: 1920,
    host: "a wide desktop viewport the component owns edge to edge — cap content width or use the extra room deliberately; never stretch a single column across the whole width",
  },
};

/**
 * Map today's shell × screen descriptors onto a canvas class. `chat` is
 * always the inline card; `spatial` is a medium floating panel;
 * `fullscreen` follows the screen. Unknown values fall back to `lg`
 * (the widest common fullscreen), matching the skeleton's
 * `fullscreen` / `universal` defaults.
 */
export function canvasForRendering(
  shellType: string | undefined,
  screen: string | undefined,
): RenderCanvas {
  const shell = shellType ?? "fullscreen";
  if (shell === "chat") return "xs-card";
  if (shell === "spatial") return "md";
  switch (screen ?? "universal") {
    case "mobile":
      return "mobile";
    case "tablet":
      return "md";
    default:
      return "lg";
  }
}

/** Map a known container width (CSS px) onto the canvas class whose range holds it. */
export function canvasForViewportWidth(width: number): RenderCanvas {
  if (width < 480) return width <= 360 ? "mobile" : "xs-card";
  if (width < 600) return "mobile";
  if (width < 1024) return "md";
  if (width < 1440) return "lg";
  return "xl";
}

/**
 * The explicit sentence the `free` prompt renders for a canvas — the
 * agent is TOLD the canvas, it never guesses it.
 */
export function describeCanvas(canvas: RenderCanvas): string {
  const d = CANVAS_DESCRIPTORS[canvas];
  return (
    `This component renders on the \`${canvas}\` canvas (${d.label}): ` +
    `${d.minWidthPx}–${d.maxWidthPx}px wide, ${d.host}. ` +
    `Design for the whole range — the host may size the iframe anywhere inside it.`
  );
}
