// packages/ui-gen/src/design-mode.ts
//
// The ONE definition of the `designMode` option and the rendering-canvas
// vocabulary. Every triad surface (system prompt, boilerplate, tier-0
// gate, axis checks, evaluator criteria) AND the visual evaluator import
// these types from here — nothing re-declares the unions.
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
// ONE canvas vocabulary shared by the prompt input (the `free` prompt
// TELLS the agent its canvas; the `constrained` prompt keeps its
// shell/screen descriptors byte-for-byte) and the visual evaluator (one
// screenshot + judge score per class at `CANVAS_VIEWPORTS[class]`).
//
// A class is derived from DISPLAY MODE + width, never from width alone:
// an inline chat card is `xs-chat-card` whatever the host window
// measures (the bubble, not the window, bounds the component); a
// fullscreen-class surface follows its width through the three
// breakpoints. `canvasForViewportWidth` is monotonic in width per
// display mode (pinned by `design-mode.test.ts`).

export const CANVAS_CLASSES = [
  "xs-chat-card",
  "mobile-fullscreen-small",
  "md",
  "lg",
  "xl",
] as const;

export type CanvasClass = (typeof CANVAS_CLASSES)[number];

export interface CanvasViewport {
  readonly width: number;
  readonly height: number;
}

/** The viewport (CSS px) each class is rendered + judged at. */
export const CANVAS_VIEWPORTS: Readonly<Record<CanvasClass, CanvasViewport>> = {
  "xs-chat-card": { width: 400, height: 640 },
  "mobile-fullscreen-small": { width: 390, height: 844 },
  md: { width: 768, height: 1024 },
  lg: { width: 1024, height: 768 },
  xl: { width: 1440, height: 900 },
};

/**
 * The two display modes the canvas derivation distinguishes. `inline`
 * is the chat card (MCP Apps `inline` display mode / the `chat` shell);
 * `fullscreen` is every surface the component owns edge to edge or as
 * a panel (`fullscreen`, `pip`, the `spatial` and `partial` shells) —
 * there the width decides the class.
 */
export type CanvasDisplayMode = "inline" | "fullscreen";

/**
 * Map a shell name (`chat` / `fullscreen` / `spatial` / `partial`) or an
 * MCP Apps display mode (`inline` / `fullscreen` / `pip`) onto the
 * canvas display mode. Only `chat` and `inline` are the inline card;
 * everything else is width-governed.
 */
export function canvasDisplayModeForShell(shell: string | undefined): CanvasDisplayMode {
  return shell === "chat" || shell === "inline" ? "inline" : "fullscreen";
}

/** Fullscreen-class breakpoints (inclusive lower bounds), CSS px. */
export const CANVAS_BREAKPOINTS = { md: 600, lg: 1024, xl: 1440 } as const;

/**
 * Derive the canvas class from display mode + container width.
 *
 *   inline      → `xs-chat-card` at every width
 *   fullscreen  → width <  600  → `mobile-fullscreen-small`
 *                 600 – 1023    → `md`
 *                 1024 – 1439   → `lg`
 *                 ≥ 1440        → `xl`
 */
export function canvasForViewportWidth(mode: CanvasDisplayMode, width: number): CanvasClass {
  if (mode === "inline") return "xs-chat-card";
  if (width < CANVAS_BREAKPOINTS.md) return "mobile-fullscreen-small";
  if (width < CANVAS_BREAKPOINTS.lg) return "md";
  if (width < CANVAS_BREAKPOINTS.xl) return "lg";
  return "xl";
}

/**
 * Map today's shell × screen descriptors onto a canvas class when no
 * width is known. `chat` is always the inline card; `spatial` is a
 * ~600px floating panel (`md`); `fullscreen` follows the screen. Unknown
 * values fall back to `lg` (the widest common fullscreen), matching the
 * skeleton's `fullscreen` / `universal` defaults.
 */
export function canvasForRendering(
  shellType: string | undefined,
  screen: string | undefined,
): CanvasClass {
  const shell = shellType ?? "fullscreen";
  if (canvasDisplayModeForShell(shell) === "inline") return "xs-chat-card";
  if (shell === "spatial") return "md";
  switch (screen ?? "universal") {
    case "mobile":
      return "mobile-fullscreen-small";
    case "tablet":
      return "md";
    default:
      return "lg";
  }
}

export interface CanvasDescriptor {
  /** Short human label. */
  readonly label: string;
  /** Inclusive width range the component must look right across, CSS px. */
  readonly minWidthPx: number;
  readonly maxWidthPx: number;
  /** What the host draws around the component at this canvas. */
  readonly host: string;
}

export const CANVAS_DESCRIPTORS: Readonly<Record<CanvasClass, CanvasDescriptor>> = {
  "xs-chat-card": {
    label: "extra-small chat card",
    minWidthPx: 320,
    maxWidthPx: 480,
    host: "an inline card inside a chat message bubble — the host draws the card border, shadow and rounded corners; the component fills the bubble width and takes its natural height",
  },
  "mobile-fullscreen-small": {
    label: "small mobile fullscreen",
    minWidthPx: 320,
    maxWidthPx: 599,
    host: "a phone-sized viewport the component owns edge to edge — single column, touch targets at least 44px, the component manages its own scroll",
  },
  md: {
    label: "medium panel",
    minWidthPx: 600,
    maxWidthPx: 1023,
    host: "a tablet viewport or a floating panel (spatial / picture-in-picture) — one or two columns, medium density",
  },
  lg: {
    label: "large fullscreen",
    minWidthPx: 1024,
    maxWidthPx: 1439,
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
 * The explicit sentence the `free` prompt renders for a canvas — the
 * agent is TOLD the canvas, it never guesses it.
 */
export function describeCanvas(canvas: CanvasClass): string {
  const d = CANVAS_DESCRIPTORS[canvas];
  return (
    `This component renders on the \`${canvas}\` canvas (${d.label}): ` +
    `${d.minWidthPx}–${d.maxWidthPx}px wide, ${d.host}. ` +
    `Design for the whole range — the host may size the iframe anywhere inside it.`
  );
}
