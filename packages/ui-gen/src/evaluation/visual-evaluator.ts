// packages/ui-gen/src/evaluation/visual-evaluator.ts
//
// Visual evaluator — renders compiled component, takes screenshot,
// sends to multimodal LLM for visual quality scoring.
//
// Two modes:
// 1. Screenshot mode (puppeteer available): full visual evaluation
// 2. Source-only mode (no puppeteer): falls back to code-based evaluation
//
// The visual evaluator complements the code-based evaluator by catching
// issues only visible when rendered: broken layouts, overlapping elements,
// poor visual hierarchy, missing whitespace.

import { buildStylingProfileJudgeBlock } from '../boilerplate/styling-profile.js';
import type { GenerationProfileInput } from '../boilerplate/styling-profile.js';
import { build } from 'esbuild';
import { fillFitRule, getCssTokens } from '@ggui-ai/design/rendering';
import { judgeDesignIdentity, type JudgeDesignIdentity } from './design-identity.js';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import { existsSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'os';
import { createVisionAgent, type AgentConfig } from '../harness/llm-router';
import type { EvaluationResult, EvaluationIssue, DimensionScores } from './types';
import type { CanvasJudgeRecord, CanvasVisualSummary, EvalIssue, VisualEvalSummary, VisualFitStamp } from './types-public.js';
import type { LaunchOptions } from 'puppeteer-core';
import { CANVAS_VIEWPORTS, displayModeForCanvas, type CanvasClass, type CanvasViewport } from '../design-mode.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VisualEvalConfig {
  /** LLM provider for multimodal evaluation */
  provider: 'claude' | 'google';
  /** Model ID (must support vision/multimodal) */
  model?: string;
  /** Pass threshold for visual score (0-100) */
  passThreshold: number;
  /** Sample props to render the component with */
  sampleProps?: Record<string, unknown>;
  /** Viewport dimensions for screenshot */
  viewport?: { width: number; height: number };
  /**
   * Per-canvas judging — ARM-NEUTRAL (the same judge, prompt and
   * threshold in every design mode). When set, the SAME rendered HTML
   * shell is screenshotted once per class at `CANVAS_VIEWPORTS[class]`
   * and judged once per class; the result carries one entry per class
   * in `canvases`, and the single-shot fields aggregate: `finalScore` =
   * mean of the canvas scores (rounded), `passed` = every canvas passed,
   * `dimensions` = per-dimension means, `issues` = every canvas's issues
   * (description prefixed `[<canvas>]`). Unset (or empty) = today's
   * single screenshot at `viewport`; no `canvases` field on the result.
   */
  canvases?: readonly CanvasClass[];
  /**
   * ggui#1195 — the box a canvas is COMPOSED for and CAPTURED at when the
   * order declared one (the chat card at the visitor's real column, not the
   * class's 400×640). Keyed by canvas; a canvas without an entry is judged
   * at `CANVAS_VIEWPORTS[canvas]` as before. The composer's
   * `rendering.viewport` and this entry are ONE value written once (the
   * seam derives it), so the judge never scores a box the mint did not
   * target. Only read in per-canvas mode.
   */
  canvasViewports?: Partial<Readonly<Record<CanvasClass, CanvasViewport>>>;
  /**
   * Optional provider-routing override — see
   * `AgentConfig.routeOverride`. Threaded onto the agent this
   * evaluator constructs so its multimodal call never falls back to
   * `process.env` for credentials or model routing.
   */
  /**
   * Vision calls per judged canvas on the SAME captured frame, aggregated by
   * the median (ggui#1072). Default 1 — a single judgement, byte-identical to
   * the instrument before this option existed. K is an instrument dial: a
   * run mixes K at its own peril.
   */
  judgeK?: number;
  /** The canvases sampled `judgeK` times; default = every judged canvas when `judgeK > 1`. */
  judgeKCanvases?: readonly CanvasClass[];
  /**
   * The design `src` tree the judge bundles the component against
   * (ggui#1042): an explicit input, so a judge-only re-judge names the tree
   * it painted with. Default: the design package beside this one.
   */
  designSrcDir?: string;
  /** The mode the caller composed `cssTokens` in — a receipt on the row, never a switch (ggui#1076: judge and runtime must name the same mode). */
  themeMode?: 'light' | 'dark';
  routeOverride?: AgentConfig['routeOverride'];
  /**
   * Provider-429-retry observer — see `AgentConfig.onRetry`.
   * Without it, a rate-limited retry inside the evaluation call
   * happens (the agent's retry loop is unconditional) but never
   * reaches the caller's structured log.
   */
  onRetry?: AgentConfig['onRetry'];
}

/** One canvas's verdict — screenshot + judge score at that class's viewport. */
export interface CanvasVisualResult {
  canvas: CanvasClass;
  viewport: CanvasViewport;
  /** The judge's weighted score for this canvas (0-100). */
  score: number;
  /** `score >= passThreshold`. */
  passed: boolean;
  /** The PNG the judge saw — kept for artefact persistence + the human look. */
  screenshotPng: Buffer;
  /**
   * The document's scroll height at this canvas's viewport, CSS px — what
   * the box would have to be for nothing to be hidden (ggui#1027). `null`
   * when the page could not be measured.
   */
  contentHeight: number | null;
  /** `contentHeight > viewport.height` — a measurement; what it MEANS is {@link canvasFitPolicy}'s. */
  overflow: boolean;
  /** How `score` was reached — always present (ggui#1072). */
  judge: CanvasJudgeRecord;
  /** How the judge composed the mount (ggui#1100): `'fill'` on every fullscreen canvas, absent on the inline card. */
  fit?: 'fill';
  /** ggui#1195 — `true` when the order DECLARED this canvas's box (`config.canvasViewports` carried an entry), whatever its value. */
  declared?: true;
}

/** How a canvas is captured for the judge and what an overflow means there (ggui#1027). */
export type CaptureMode = 'viewport' | 'full-page';
export interface CanvasFitPolicy {
  /** `viewport` = the judge sees the box the user sees; `full-page` = the whole scrolled document. */
  readonly capture: CaptureMode;
  /** The verdict an overflow earns on this canvas. */
  readonly overflow: 'fail' | 'warn' | 'none';
}

/**
 * The inline chat card is a BOX — the bubble bounds the component and it
 * does not scroll — so the judge captures the viewport (a 1289 px hello on
 * a 640 px card was scored 86 from a full-page capture that showed the
 * judge what no user sees) and an overflow is a critical layout issue that
 * fails the canvas. A phone's first screen may scroll, so the overflow is
 * reported as a major issue and the score stands. Pages (`md`/`lg`/`xl`)
 * scroll by design: measured, never judged.
 */
export function canvasFitPolicy(canvas: CanvasClass): CanvasFitPolicy {
  switch (canvas) {
    case 'xs-chat-card':
      return { capture: 'viewport', overflow: 'fail' };
    case 'mobile-fullscreen-small':
      return { capture: 'full-page', overflow: 'warn' };
    default:
      return { capture: 'full-page', overflow: 'none' };
  }
}

/**
 * The mount element of the judge page (ggui#1100). Its class is the scope
 * `fillFitRule` targets — the judge's counterpart of the runtime's mount list.
 */
export const JUDGE_SCOPE_CLASS = 'ggui-judge-scope';

/**
 * How the judge composes a canvas (ggui#1100): the served runtime stretches
 * the mounted root to the frame on every fullscreen surface (`fit: 'fill'`,
 * ggui#1041/#1073/#1096) and leaves the inline card at its natural height —
 * the judge does the same, or it scores a picture the user never sees (a
 * content-sized hello on an empty 768×1024 page; candidate 34's hellos).
 */
export function canvasFit(canvas: CanvasClass): 'fill' | undefined {
  return displayModeForCanvas(canvas) === 'fullscreen' ? 'fill' : undefined;
}

/** ggui#1195 — `true` when a canvas was judged at a box other than its class viewport (the order declared one). */
export function isDeclaredViewport(canvas: CanvasClass, viewport: CanvasViewport): boolean {
  const classBox = CANVAS_VIEWPORTS[canvas];
  return viewport.width !== classBox.width || viewport.height !== classBox.height;
}

/** The deterministic fit issue — one per overflowing canvas, in the judge's issue shape so it rides the same channel. */
export function canvasOverflowIssue(
  canvas: CanvasClass,
  viewport: CanvasViewport,
  contentHeight: number,
  verdict: 'fail' | 'warn',
): EvaluationIssue {
  const hidden = contentHeight - viewport.height;
  // ggui#1195 — when the judge captured at a DECLARED box, the refusal names
  // both boxes: the ceiling the content was measured against and the class
  // box a reader would otherwise assume.
  const classBox = CANVAS_VIEWPORTS[canvas];
  const box = isDeclaredViewport(canvas, viewport)
    ? `declared ${viewport.width}×${viewport.height}; class box ${classBox.width}×${classBox.height}`
    : `${viewport.width}×${viewport.height}`;
  return {
    dimension: 'canvas-overflow',
    severity: verdict === 'fail' ? 'critical' : 'major',
    description:
      `Rendered content is ${contentHeight}px tall on the ${canvas} canvas (${box}) — ` +
      `${hidden}px ${verdict === 'fail' ? 'is cut off: the inline card does not scroll' : 'sits below the first screen'}.`,
    fix:
      'Fit the composition to the canvas: fewer and shorter sections, one compact row of chips, no hero taller than ' +
      'a third of the box, no fixed min-heights or tall paddings — measure against the canvas, not the page.',
  };
}

/**
 * `runVisualEvaluation`'s result. Identical to `EvaluationResult` when
 * `config.canvases` is unset; with canvases set, `canvases` holds the
 * per-class verdicts and the base fields aggregate them (see
 * `VisualEvalConfig.canvases`).
 */
export interface VisualEvaluationResult extends EvaluationResult {
  canvases?: CanvasVisualResult[];
  /** The design tree the judge painted with (ggui#1042) — present on every per-canvas judgement. */
  design?: JudgeDesignIdentity;
  /** The mode `cssTokens` were composed in, when the caller said (ggui#1076). */
  themeMode?: 'light' | 'dark';
}

/** Injection points for `runVisualEvaluation` — screenshot deps plus the judge call (tests). */
export interface VisualEvalDeps extends ScreenshotDeps {
  /** The multimodal judge call (default: `callMultimodalLLM`). */
  judge?: typeof callMultimodalLLM;
}

export interface VisualEvalContext {
  /** Compiled JavaScript code (ESM with imports) */
  compiledCode: string;
  /** Original user prompt */
  originalPrompt: string;
  /** Design system CSS tokens */
  cssTokens?: string;
  /** The app's generation profile (#991) — judged relative to, never against. */
  profile?: GenerationProfileInput;
}

// ---------------------------------------------------------------------------
// HTML blueprint for rendering
// ---------------------------------------------------------------------------

/**
 * Bundle the compiled component with the design system using esbuild.
 * Produces a self-contained IIFE that only needs React + ReactDOM from CDN.
 * Resolves @ggui-ai/design/* imports from the local monorepo packages.
 */
/**
 * The on-disk root of `@ggui-ai/design`, for the esbuild aliases that
 * let JUDGED components resolve the same design source production
 * ships. Exported for the ggui#613 regression pin: the previous inline
 * `'..','..','..','packages','design'` resolved a pre-`oss/`-migration
 * path (`oss/packages/packages/design`) that exists from NEITHER the
 * src nor the dist layout — the visual leg's bundle broke silently at
 * the migration. Three ups from `<pkg>/src/evaluation` (or
 * `<pkg>/dist/evaluation`) is `oss/packages/`; the design package is
 * its direct child.
 */
/**
 * The on-disk root of `@ggui-ai/ui-gen` itself. The bundle's entry lives
 * in a temp dir, so bare imports in the GENERATED component (`@ggui-ai/wire`
 * and every other allowlisted package) resolve nowhere from there — they
 * resolve from this package's `node_modules` instead (`nodePaths`), the
 * same place the harness's own imports come from.
 */
export function resolveUiGenPackageDir(): string {
  const selfDir = dirname(fileURLToPath(import.meta.url));
  return resolve(selfDir, '..', '..');
}

/**
 * Where `@ggui-ai/wire` actually is, from ui-gen's OWN module graph —
 * layout-proof: a workspace checkout links it under `node_modules/`, a
 * `pnpm deploy` tree puts it beside ui-gen under `.pnpm/…/node_modules/`,
 * and a plain install nests it; `import.meta.resolve` answers for all
 * three (directory candidates first, module graph last). Aliased
 * explicitly in the judge's bundle so the generated component's wire
 * import never depends on the directory layout the evaluator runs in.
 */
export function resolveWirePackageDir(): string | null {
  const uiGenDir = resolveUiGenPackageDir();
  const candidates = [
    resolve(uiGenDir, 'node_modules', '@ggui-ai', 'wire'), // workspace / nested install
    resolve(uiGenDir, '..', 'wire'), // pnpm deploy: `.pnpm/<ui-gen>@<ver>/node_modules/@ggui-ai/{ui-gen,wire}`
    resolve(uiGenDir, '..', '..', '@ggui-ai', 'wire'), // hoisted flat install beside the scope dir
  ];
  for (const dir of candidates) {
    if (existsSync(resolve(dir, 'package.json'))) return dir;
  }
  try {
    // Last resort: ask the module graph (Node ≥ 20.6). Not every runner
    // supports it synchronously, hence the guarded position.
    const entry = fileURLToPath(import.meta.resolve('@ggui-ai/wire'));
    let dir = dirname(entry);
    for (let i = 0; i < 6; i++) {
      if (existsSync(resolve(dir, 'package.json'))) return dir;
      dir = dirname(dir);
    }
  } catch {
    // fall through — nodePaths still gets a chance
  }
  return null;
}

/**
 * The `@ggui-ai/design` package root — resolved by MODULE ID, never by counting
 * directories (ggui#1110).
 *
 * The arithmetic this replaced (`…/'..','..','..','design'`) was correct only
 * for the layout it was written against — `node_modules/@ggui-ai/ui-gen/dist/
 * evaluation` → `node_modules/@ggui-ai/` + `design`. Under a deploy-flattened
 * layout it landed one level too high, at `node_modules/design`, a path that is
 * not the design package at all: the judge then walked a directory that does not
 * exist, threw ENOENT inside every evaluation round on that deployment, and a
 * bar refused cards no one could judge. `@ggui-ai/design` exports `./package.json`,
 * so the module resolver answers correctly in every layout — scoped, flattened,
 * hoisted — and the receipt keeps working inside the image.
 */
export function resolveDesignPackageDir(): string {
  try {
    return dirname(createRequire(import.meta.url).resolve('@ggui-ai/design/package.json'));
  } catch {
    // A runner whose module graph cannot see the package (a bundled judge, a
    // test double). The layout guess is the last resort, and a wrong answer is
    // now a NAMED absent receipt rather than a thrown round (`judgeDesignIdentity`).
    const selfDir = dirname(fileURLToPath(import.meta.url));
    return resolve(selfDir, '..', '..', '..', 'design');
  }
}

async function bundleForRendering(
  compiledCode: string,
  sampleProps: Record<string, unknown>,
  designSrc: string = resolve(resolveDesignPackageDir(), 'src'),
): Promise<string> {
  // Write component + entry to temp files for esbuild
  const tmpDir = resolve(tmpdir(), 'ggui-visual-eval-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  const componentFile = resolve(tmpDir, 'component.tsx');
  const entryFile = resolve(tmpDir, 'entry.tsx');

  const designPkgDir = resolve(designSrc, '..');
  const wirePkgDir = resolveWirePackageDir();

  // Write the compiled component as a separate module
  writeFileSync(componentFile, compiledCode);

  // Entry file imports the component and renders it
  // The generated component is rendered the way a host renders it: inside
  // `GguiWireProvider` with a stub config (dispatch/subscribe are no-ops —
  // the judge sees the first paint, not the wire round-trip). Without the
  // provider every `useAction` / `useStream` bearer threw
  // "useWireContext must be used within a WireProvider", React unmounted
  // the root and the judge scored a blank page. An error boundary turns a
  // render throw into visible "Render error" text (which the rubric
  // scores 0) instead of the same blank.
  const entryCode = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import { GguiWireProvider } from '@ggui-ai/wire';
import Component from './component.tsx';

const props = ${JSON.stringify(sampleProps)};
const wireConfig = {
  app: { appId: 'visual-eval', appName: 'Visual evaluation' },
  render: { sessionId: 'visual-eval', isConnected: true },
  auth: { isAuthenticated: false },
  dispatch: () => {},
  subscribe: () => () => {},
};
class RenderErrorBoundary extends React.Component<{ children: React.ReactNode }, { message: string | null }> {
  state = { message: null as string | null };
  static getDerivedStateFromError(err: unknown) { return { message: err instanceof Error ? err.message : String(err) }; }
  render() {
    return this.state.message === null
      ? this.props.children
      : React.createElement('div', { className: 'error' }, 'Render error: ' + this.state.message);
  }
}
const root = createRoot(document.getElementById('root')!);
try {
  root.render(
    React.createElement(GguiWireProvider, { config: wireConfig },
      React.createElement(RenderErrorBoundary, null, React.createElement(Component, props))),
  );
} catch (err) {
  root.render(React.createElement('div', { className: 'error' }, 'Render error: ' + (err as Error).message));
}
`;

  writeFileSync(entryFile, entryCode);

  try {
    const result = await build({
      entryPoints: [entryFile],
      bundle: true,
      write: false,
      format: 'esm',
      platform: 'browser',
      target: 'es2020',
      jsx: 'automatic',
      jsxImportSource: 'react',
      external: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
      alias: {
        // The wire hooks: resolved from ui-gen's own module graph so the
        // alias holds in a workspace checkout AND in a `pnpm deploy` image
        // (where deps are siblings, not children, of this package).
        ...(wirePkgDir !== null ? { '@ggui-ai/wire': wirePkgDir } : {}),
        // D1: generated code imports the single `@ggui-ai/design` barrel.
        // The subpath aliases stay for any first-party / legacy code.
        '@ggui-ai/design': resolve(designPkgDir, 'src', 'index.ts'),
        '@ggui-ai/design/primitives': resolve(designPkgDir, 'src', 'primitives', 'index.ts'),
        '@ggui-ai/design/components': resolve(designPkgDir, 'src', 'components', 'index.ts'),
        '@ggui-ai/design/compositions': resolve(designPkgDir, 'src', 'compositions', 'index.ts'),
        '@ggui-ai/design/interact': resolve(designPkgDir, 'src', 'interact', 'index.ts'),
      },
      // Bare imports in the generated component resolve against ui-gen's
      // own node_modules — the temp entry dir has none. Without this every
      // wire-bearing component (`@ggui-ai/wire`) failed to bundle.
      // Workspace layout (deps under this package's node_modules) and the
      // `pnpm deploy` layout (deps as siblings of this package) — both
      // searched for any other allowlisted bare import.
      nodePaths: [resolve(resolveUiGenPackageDir(), 'node_modules'), resolve(resolveUiGenPackageDir(), '..')],
      logLevel: 'silent',
    });

    return result.outputFiles[0]?.text ?? '';
  } finally {
    try { unlinkSync(entryFile); } catch { /* cleanup */ }
    try { unlinkSync(componentFile); } catch { /* cleanup */ }
  }
}

function buildRenderHTML(
  bundledCode: string,
  cssTokens?: string,
  fit?: 'fill',
): string {
  // Default to the design tokens production's no-theme branch injects
  // (getCssTokens → default theme, light) — ggui#613: under the s4
  // fallback ban the generated component's `var(--ggui-*)` references
  // carry no literal fallbacks, so an un-injected judged render shows
  // unset colors and the multimodal judge grades broken output. An
  // explicit caller value still wins (theme-aware callers pass their
  // own).
  const tokens = cssTokens ?? getCssTokens();
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${tokens}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--ggui-font-family-sans, system-ui, -apple-system, sans-serif);
      background: var(--ggui-color-neutral-50, #ffffff);
      color: var(--ggui-color-neutral-900, #111827);
    }
    .error { color: #dc2626; padding: 16px; font-family: monospace; white-space: pre-wrap; }
    ${fit === 'fill' ? fillFitRule(JUDGE_SCOPE_CLASS) : ''}
  </style>
</head>
<body>
  <div id="root"${fit === 'fill' ? ` class="${JUDGE_SCOPE_CLASS}"` : ''}></div>
  <script type="importmap">
  {
    "imports": {
      "react": "https://esm.sh/react@18",
      "react-dom": "https://esm.sh/react-dom@18",
      "react-dom/client": "https://esm.sh/react-dom@18/client",
      "react/jsx-runtime": "https://esm.sh/react@18/jsx-runtime"
    }
  }
  </script>
  <script type="module">
${bundledCode}
  </script>
</body>
</html>`;
}

// ---------------------------------------------------------------------------
// Screenshot capture (optional puppeteer dependency)
// ---------------------------------------------------------------------------

/** The page surface the capture uses — a structural subset of puppeteer's `Page`. */
export interface ScreenshotPage {
  setContent(html: string, options: { waitUntil: 'load'; timeout: number }): Promise<void>;
  waitForNetworkIdle(options: { idleTime: number; timeout: number }): Promise<void>;
  waitForSelector(selector: string, options: { timeout: number }): Promise<unknown>;
  /** Evaluates a JS expression in the page and returns its serialised value — the fit measurement (ggui#1027). */
  evaluate(expression: string): Promise<unknown>;
  screenshot(options: { type: 'png'; fullPage: boolean }): Promise<Uint8Array>;
}

/** The browser surface the capture uses — a structural subset of puppeteer's `Browser`. */
export interface ScreenshotBrowser {
  newPage(): Promise<ScreenshotPage>;
  close(): Promise<void>;
}

export type ScreenshotLauncher = (options: LaunchOptions) => Promise<ScreenshotBrowser>;

/** The two members of `@sparticuz/chromium` the fallback launch path reads. */
export interface ChromiumProvider {
  readonly args: string[];
  executablePath(): Promise<string>;
}

/**
 * Injection points for the capture — every default is the production
 * path; tests replace them to pin branch selection without launching a
 * browser.
 */
export interface ScreenshotDeps {
  /** Launches the browser (default: `puppeteer-core`'s `launch`). */
  launch?: ScreenshotLauncher;
  /** Environment the executable-path override is read from (default: `process.env`). */
  env?: NodeJS.ProcessEnv;
  /** Loads `@sparticuz/chromium` (default: dynamic import) — only consulted when no override is set. */
  loadChromium?: () => Promise<ChromiumProvider>;
  /** Post-load settle time before the screenshot, ms (default 1000). */
  settleMs?: number;
}

/**
 * Chromium flags the `PUPPETEER_EXECUTABLE_PATH` launch adds: a system
 * Chromium inside a container has no user namespace for the sandbox and
 * `/dev/shm` is too small for a render surface.
 */
export const EXECUTABLE_PATH_LAUNCH_ARGS: readonly string[] = ['--no-sandbox', '--disable-dev-shm-usage'];

const DEFAULT_SCREENSHOT_VIEWPORT = { width: 1280, height: 800 } as const;

async function loadSparticuzChromium(): Promise<ChromiumProvider> {
  const chromium = await import('@sparticuz/chromium');
  return chromium.default;
}

/**
 * Pick the browser binary. `PUPPETEER_EXECUTABLE_PATH` (a system
 * Chromium — the bench runner image, a dev box) wins and skips the
 * `@sparticuz/chromium` load entirely; otherwise the bundled Lambda
 * Chromium supplies both binary and flags, as before.
 */
export async function resolveLaunchOptions(
  viewport: { width: number; height: number },
  deps: Pick<ScreenshotDeps, 'env' | 'loadChromium'> = {},
): Promise<LaunchOptions> {
  const env = deps.env ?? process.env;
  const override = env.PUPPETEER_EXECUTABLE_PATH?.trim();
  if (override) {
    return {
      executablePath: override,
      args: [...EXECUTABLE_PATH_LAUNCH_ARGS],
      defaultViewport: viewport,
      headless: true,
    };
  }
  const chromium = await (deps.loadChromium ?? loadSparticuzChromium)();
  return {
    args: chromium.args,
    defaultViewport: viewport,
    executablePath: await chromium.executablePath(),
    headless: true,
  };
}

async function launchWithPuppeteer(options: LaunchOptions): Promise<ScreenshotBrowser> {
  const puppeteer = await import('puppeteer-core');
  return puppeteer.default.launch(options);
}

/**
 * Take a screenshot of the rendered component.
 * Returns the PNG bytes, or null if no browser could be launched.
 */
/** Screenshot plus the reason when none could be taken — the judge's `unavailableReason`. */
export interface ScreenshotAttempt {
  readonly png: Buffer | null;
  readonly reason?: string;
  /** The document's scroll height at the viewport (ggui#1027); `null` when unmeasurable. */
  readonly contentHeight: number | null;
}

/** The expression the fit measurement evaluates in the page — the taller of the two scroll heights. */
export const CONTENT_HEIGHT_EXPRESSION =
  'Math.max(document.documentElement.scrollHeight, document.body ? document.body.scrollHeight : 0)';

/** Measure the rendered document's height; a failed measurement is reported, never a failed capture. */
async function measureContentHeight(page: ScreenshotPage): Promise<number | null> {
  try {
    const h = await page.evaluate(CONTENT_HEIGHT_EXPRESSION);
    return typeof h === 'number' && Number.isFinite(h) ? Math.round(h) : null;
  } catch (e) {
    console.warn(`[visual-eval] content height unavailable: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

export async function captureScreenshotDetailed(
  html: string,
  viewport: { width: number; height: number } = DEFAULT_SCREENSHOT_VIEWPORT,
  deps: ScreenshotDeps = {},
  capture: CaptureMode = 'full-page',
): Promise<ScreenshotAttempt> {
  try {
    const launchOptions = await resolveLaunchOptions(viewport, deps);
    const browser = await (deps.launch ?? launchWithPuppeteer)(launchOptions);
    try {
      const page = await browser.newPage();
      // puppeteer ≥24.43 narrowed setContent's waitUntil to
      // 'load' | 'domcontentloaded'; waitForNetworkIdle (0 connections
      // for 500ms) reproduces the old 'networkidle0' semantics.
      await page.setContent(html, { waitUntil: 'load', timeout: 15000 });
      await page.waitForNetworkIdle({ idleTime: 500, timeout: 15000 }).catch(() => {});
      await page.waitForSelector('#root > *', { timeout: 10000 }).catch(() => {});
      // Wait a bit for CSS/fonts to settle
      await new Promise((r) => setTimeout(r, deps.settleMs ?? 1000));
      const contentHeight = await measureContentHeight(page);
      const screenshot = await page.screenshot({ type: 'png', fullPage: capture === 'full-page' });
      return { png: Buffer.from(screenshot), contentHeight };
    } finally {
      await browser.close();
    }
  } catch (e) {
    const reason = `screenshot failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[visual-eval] ${reason}`);
    return { png: null, reason, contentHeight: null };
  }
}

export async function captureScreenshot(
  html: string,
  viewport: { width: number; height: number } = DEFAULT_SCREENSHOT_VIEWPORT,
  deps: ScreenshotDeps = {},
): Promise<Buffer | null> {
  return (await captureScreenshotDetailed(html, viewport, deps)).png;
}

// ---------------------------------------------------------------------------
// Multimodal LLM evaluation
// ---------------------------------------------------------------------------

export const VISUAL_EVAL_PROMPT = `You are a visual quality evaluator for ggui — a platform where AI agents generate React UI components on demand.

## Context
The screenshot shows a generated React component built from a design system with CSS variable theming. The component was created by an LLM to fulfill a user's request. Your job is to evaluate whether the generated UI achieves the user's goal AND looks professionally designed.

## Scoring Dimensions (0-100 each)

1. **completeness** (25%): Does the screenshot show ALL features the user requested? Are all sections, controls, data fields, and interactive elements present? Missing features or sections = major deduction. Compare against the original request carefully.

2. **layout** (25%): Is the layout well-composed? Clear sections and grouping? No overlapping elements? Proper spacing between elements? Responsive-looking? Does it look like a professional app UI, not a homework project?

3. **hierarchy** (25%): Clear visual hierarchy? Headings are visually distinct from body text? Primary actions (buttons) are prominent? Information grouped logically with clear section breaks? Color and size used to guide the eye?

4. **aesthetics** (25%): Professional, polished appearance? Consistent color palette? Good use of whitespace — not too sparse, not too cluttered? Cards, shadows, and borders used effectively? Does it look like something a designer would approve? Would you be comfortable showing this to a client?

## Scoring Guide
- 90-100: Production-ready. Would ship to real users. Polished layout, clear hierarchy, professional aesthetics.
- 80-89: Good quality. Minor improvements needed (slightly tight spacing, one section could be better grouped).
- 70-79: Acceptable but generic. Works correctly but lacks design polish or visual refinement.
- 60-69: Below standard. Noticeable problems — cramped layout, poor hierarchy, or missing sections.
- Below 60: Broken or fundamentally incomplete. Error messages visible, blank areas, or critical features missing.

## Important
- Check the screenshot against the "Original Request" — does it actually deliver what was asked for?
- Error messages like "Render error" or blank white space = rendering score 0
- A component that renders but is just a wall of text with no structure should score low on layout and hierarchy

List AT MOST 6 issues, most severe first, one sentence each for "description" and "fix" — a longer list is cut off and lost.

Respond with ONLY a JSON object (no markdown, no explanation):
{
  "completeness": <0-100>,
  "layout": <0-100>,
  "hierarchy": <0-100>,
  "aesthetics": <0-100>,
  "issues": [
    { "dimension": "<dimension>", "severity": "<critical|major|minor>", "description": "<what's wrong>", "fix": "<specific fix>" }
  ],
  "critique": "<2-3 sentences: what's good, what needs improvement, does it achieve the user's goal?>"
}`;

/**
 * Send the screenshot to the configured multimodal provider through
 * the shared `LLMAgent` machinery. Routing through `createVisionAgent`
 * (rather than constructing provider SDK clients inline) is what puts
 * this call inside the same `apiCall()` choke point as every other
 * completion: provider 429s retry with `Retry-After` honoring, the
 * caller's `onRetry` observer sees each retry, and `routeOverride`
 * governs credentials and model routing (including the Anthropic
 * Bedrock path) instead of `process.env`.
 */
/**
 * Output budget for the judge's answer. 1500 cut a board's issue list
 * mid-array (`Expected ',' or ']' after array element`, six kanban cells
 * on 2026-09-11) — deterministic on the content, so a same-prompt retry
 * could never clear it. 4096 fits the bounded list the prompt now asks for
 * with room; the salvage path covers the remainder.
 */
export const VISUAL_JUDGE_MAX_OUTPUT_TOKENS = 4096;

/**
 * The judge instrument's name and content digest, for the record a run
 * stamps beside every visual score. The NAME is for readers; the DIGEST
 * is computed from the prompt text at module load, so a stamped row can
 * never claim a prompt version it did not run — change the prompt and the
 * digest moves with it (the pin ties the name to the bounded-list text).
 */
export const VISUAL_JUDGE_PROMPT_VERSION = 'v2-bounded-issues';
export const VISUAL_JUDGE_PROMPT_DIGEST = createHash('sha256').update(VISUAL_EVAL_PROMPT, 'utf8').digest('hex');

async function callMultimodalLLM(
  config: VisualEvalConfig,
  model: string,
  prompt: string,
  screenshot: Buffer,
  originalPrompt: string,
  profileBlock = '',
) {
  const userPrompt =
    `## Original Request\n${originalPrompt}\n\n` +
    (profileBlock.length > 0 ? `${profileBlock}\n\n` : '') +
    'Evaluate the screenshot of the generated component.';
  const agent = createVisionAgent({
    provider: config.provider === 'claude' ? 'anthropic' : config.provider,
    model,
    routeOverride: config.routeOverride,
    onRetry: config.onRetry,
  });
  return agent.callVision(
    model,
    prompt,
    userPrompt,
    { mediaType: 'image/png', base64: screenshot.toString('base64') },
    VISUAL_JUDGE_MAX_OUTPUT_TOKENS,
  );
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Run visual evaluation on a compiled component.
 *
 * 1. Builds an HTML page with the component + sample props
 * 2. Takes a screenshot via puppeteer (if available)
 * 3. Sends screenshot to multimodal LLM for visual scoring
 *
 * Returns null if puppeteer is not available (graceful fallback).
 */
/**
 * The judge's answer WITH the reason when it could not judge: `result` is
 * null exactly when no screenshot could be taken (no browser, a launch or
 * in-page failure) or the component could not be bundled; `unavailableReason`
 * names why in words and `canvas` the canvas it happened at. A production
 * caller records the reason in its receipt — a `judge_unavailable` that only
 * says "null" cost a log dive on 2026-09-10 (puppeteer-core missing in the
 * deploy image).
 */
export interface VisualEvalDetailed {
  readonly result: VisualEvaluationResult | null;
  readonly unavailableReason?: string;
  readonly canvas?: CanvasClass;
}


/** One judge call parsed, retried ONCE on a malformed answer (#1017); the FIRST reason is kept verbatim. */
type JudgedAnswer =
  | { readonly kind: 'ok'; readonly result: EvaluationResult; readonly inputTokens: number; readonly outputTokens: number }
  | { readonly kind: 'unparsable'; readonly reason: string };

/** How many vision calls this canvas gets (ggui#1072): `judgeK` when the canvas is sampled, else 1. */
function judgeCountFor(config: VisualEvalConfig, canvas: CanvasClass): number {
  const k = Math.max(1, Math.floor(config.judgeK ?? 1));
  if (k === 1) return 1;
  return config.judgeKCanvases === undefined || config.judgeKCanvases.includes(canvas) ? k : 1;
}

/** The median of a non-empty list — the lower middle for an even count, so the decision is always one judge's number. */
function medianOf(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)]!;
}

/** Population σ, rounded to one decimal; 0 for one sample. */
function populationSigma(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
  return Math.round(Math.sqrt(variance) * 10) / 10;
}

async function judgeAndParse(
  judge: typeof callMultimodalLLM,
  config: VisualEvalConfig,
  model: string,
  screenshot: Buffer,
  originalPrompt: string,
  profileBlock: string,
  canvas?: CanvasClass,
): Promise<JudgedAnswer> {
  let firstReason: string | undefined;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const response = await judge(config, model, VISUAL_EVAL_PROMPT, screenshot, originalPrompt, profileBlock);
    try {
      const result = parseVisualResponse(response.text, config.passThreshold);
      return { kind: 'ok', result, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
    } catch (e) {
      // A TRUNCATED answer (cut inside `issues` at the output cap) is deterministic on
      // the content — retrying the same prompt reproduces it. The four dimensions are
      // emitted before `issues`, so the score is recoverable from the closed prefix.
      const salvaged = salvageTruncatedVisualAnswer(response.text, config.passThreshold);
      if (salvaged !== null) {
        console.warn(`[visual-eval] visual_judge_truncated${canvas ? ` canvas=${canvas}` : ''}: answer cut after ${response.text.length} chars — score recovered from the closed prefix, issues list partial`);
        return { kind: 'ok', result: salvaged, inputTokens: response.inputTokens, outputTokens: response.outputTokens };
      }
      const reason = `judge answer unparsable: ${e instanceof Error ? e.message : String(e)}`;
      if (attempt === 1) {
        firstReason = reason;
        console.warn(`[visual-eval] visual_judge_retry${canvas ? ` canvas=${canvas}` : ''}: ${reason}`);
      } else {
        console.warn(`[visual-eval] visual_judge_retry failed again${canvas ? ` canvas=${canvas}` : ''}: ${reason}`);
      }
    }
  }
  return { kind: 'unparsable', reason: firstReason ?? 'judge answer unparsable' };
}

export async function runVisualEvaluation(
  context: VisualEvalContext,
  config: VisualEvalConfig,
  deps: VisualEvalDeps = {},
): Promise<VisualEvaluationResult | null> {
  return (await runVisualEvaluationDetailed(context, config, deps)).result;
}

export async function runVisualEvaluationDetailed(
  context: VisualEvalContext,
  config: VisualEvalConfig,
  deps: VisualEvalDeps = {},
): Promise<VisualEvalDetailed> {
  const startTime = Date.now();
  const judge = deps.judge ?? callMultimodalLLM;
  // ggui#1042: the design tree is an input and a part of the judgement's identity.
  const designSrc = config.designSrcDir ?? resolve(resolveDesignPackageDir(), 'src');
  const design = judgeDesignIdentity(designSrc);
  const stamp = <T extends VisualEvaluationResult>(r: T): T => ({
    ...r,
    ...(design !== null ? { design } : {}),
    ...(config.themeMode !== undefined ? { themeMode: config.themeMode } : {}),
  });

  // Bundle component + design system into a single JS file
  let bundledCode: string;
  try {
    bundledCode = await bundleForRendering(context.compiledCode, config.sampleProps ?? {}, designSrc);
  } catch (e) {
    const unavailableReason = `bundle failed: ${e instanceof Error ? e.message : String(e)}`;
    console.warn(`[visual-eval] ${unavailableReason}`);
    return { result: null, unavailableReason };
  }
  console.log(`[visual-eval] bundled: ${bundledCode.length}B (${Date.now() - startTime}ms)`);

  // Build the HTML page — ONE shell; per-canvas mode re-renders it at each viewport.
  const html = buildRenderHTML(bundledCode, context.cssTokens);
  const model = config.model ?? getDefaultVisualModel(config.provider);

  // ── Per-canvas mode: one screenshot + one judge call per class ──
  if (config.canvases !== undefined && config.canvases.length > 0) {
    const perCanvas: CanvasVisualResult[] = [];
    const perCanvasResults: EvaluationResult[] = [];
    for (const canvas of config.canvases) {
      // ggui#1195 — the declared box when the order carried one, else the class box.
      const declaredBox = config.canvasViewports?.[canvas];
      const viewport = declaredBox ?? CANVAS_VIEWPORTS[canvas];
      const policy = canvasFitPolicy(canvas);
      // ggui#1100: the page is composed per canvas with the runtime's fit — fullscreen canvases fill, the inline card does not.
      const fit = canvasFit(canvas);
      const canvasHtml = fit !== undefined ? buildRenderHTML(bundledCode, context.cssTokens, fit) : html;
      const attempt = await captureScreenshotDetailed(canvasHtml, viewport, deps, policy.capture);
      const screenshot = attempt.png;
      if (!screenshot) {
        const unavailableReason = attempt.reason ?? 'no browser available';
        console.warn(`[visual-eval] ${unavailableReason} at canvas ${canvas} — skipping visual evaluation`);
        return { result: null, unavailableReason, canvas };
      }
      // ggui#1072: k vision calls on the SAME frame; the decision value is the median.
      const k = judgeCountFor(config, canvas);
      const profileBlock = buildStylingProfileJudgeBlock(context.profile);
      const answers = await Promise.all(
        Array.from({ length: k }, () => judgeAndParse(judge, config, model, screenshot, context.originalPrompt, profileBlock, canvas)),
      );
      const parsed = answers.filter((a): a is Extract<JudgedAnswer, { kind: 'ok' }> => a.kind === 'ok');
      if (parsed.length === 0) {
        const first = answers.find((a): a is Extract<JudgedAnswer, { kind: 'unparsable' }> => a.kind === 'unparsable');
        return { result: null, unavailableReason: first?.reason ?? 'judge answer unparsable', canvas };
      }
      const samples = parsed.map((a) => a.result.finalScore);
      const median = medianOf(samples);
      const representative = parsed[samples.indexOf(median)]!;
      const result = representative.result;
      result.finalScore = median;
      result.passed = median >= config.passThreshold;
      result.inputTokens = parsed.reduce((sum, a) => sum + a.inputTokens, 0);
      result.outputTokens = parsed.reduce((sum, a) => sum + a.outputTokens, 0);
      const response = { inputTokens: result.inputTokens, outputTokens: result.outputTokens };
      const judgeRecord: CanvasJudgeRecord = {
        k,
        rule: 'median',
        samples,
        sigma: populationSigma(samples),
        notes: parsed.map((a) => a.result.critique ?? ''),
      };
      // The fit verdict (ggui#1027): deterministic, in the judge's issue channel.
      const contentHeight = attempt.contentHeight;
      const overflow = contentHeight !== null && contentHeight > viewport.height;
      if (contentHeight !== null && contentHeight > viewport.height && policy.overflow !== 'none') {
        result.issues.push(canvasOverflowIssue(canvas, viewport, contentHeight, policy.overflow));
        if (policy.overflow === 'fail') result.passed = false;
      }
      perCanvasResults.push(result);
      perCanvas.push({
        canvas,
        viewport,
        score: result.finalScore,
        passed: result.passed,
        screenshotPng: screenshot,
        contentHeight,
        overflow,
        judge: judgeRecord,
        ...(fit !== undefined ? { fit } : {}),
        ...(declaredBox !== undefined ? { declared: true as const } : {}),
      });
      console.log(
        `[visual-eval] canvas=${canvas} ${viewport.width}×${viewport.height} score=${result.finalScore}${k > 1 ? ` (median of ${judgeRecord.samples.length}/${k}: ${judgeRecord.samples.join(',')} σ=${judgeRecord.sigma})` : ''} ` +
          `${result.passed ? 'pass' : 'FAIL'} | content=${contentHeight ?? '?'}px${overflow ? ` OVERFLOW (${policy.overflow})` : ''} ` +
          `| in=${response.inputTokens} out=${response.outputTokens}`,
      );
    }
    const aggregate = aggregateCanvasResults(perCanvas, perCanvasResults);
    const elapsed = Date.now() - startTime;
    console.log(
      `[visual-eval] score=${aggregate.finalScore} (mean of ${perCanvas.length} canvases; ` +
        `${aggregate.passed ? 'every canvas passed' : `${perCanvas.filter((c) => !c.passed).length} failed`}) (${elapsed}ms)`,
    );
    return { result: stamp(aggregate) };
  }

  // ── Single-shot mode (today's path) ──
  const attempt = await captureScreenshotDetailed(html, config.viewport, deps);
  const screenshot = attempt.png;
  if (!screenshot) {
    const unavailableReason = attempt.reason ?? 'no browser available';
    console.warn(`[visual-eval] ${unavailableReason} — skipping visual evaluation`);
    return { result: null, unavailableReason };
  }
  console.log(`[visual-eval] screenshot: ${screenshot.length}B (${Date.now() - startTime}ms)`);

  // Send to multimodal LLM (one retry on a malformed answer — #1017)
  const answer = await judgeAndParse(
    judge,
    config,
    model,
    screenshot,
    context.originalPrompt,
    buildStylingProfileJudgeBlock(context.profile),
  );
  if (answer.kind === 'unparsable') {
    return { result: null, unavailableReason: answer.reason };
  }
  const result = answer.result;
  result.inputTokens = answer.inputTokens;
  result.outputTokens = answer.outputTokens;
  const response = { inputTokens: answer.inputTokens, outputTokens: answer.outputTokens };

  const elapsed = Date.now() - startTime;
  console.log(`[visual-eval] score=${result.finalScore} (${elapsed}ms) | in=${response.inputTokens} out=${response.outputTokens}`);

  return { result: stamp(result) };
}

/**
 * Fold per-canvas verdicts into the single-shot fields: `finalScore` =
 * rounded mean, `passed` = every canvas passed, `dimensions` = rounded
 * per-dimension means, `issues` = union (description prefixed with the
 * canvas), `critique` = one line per canvas, tokens summed.
 */
function aggregateCanvasResults(
  perCanvas: readonly CanvasVisualResult[],
  results: readonly EvaluationResult[],
): VisualEvaluationResult {
  const n = results.length;
  const mean = (pick: (r: EvaluationResult) => number): number =>
    Math.round(results.reduce((sum, r) => sum + pick(r), 0) / n);
  const dimensions: DimensionScores = {
    completeness: mean((r) => r.dimensions.completeness),
    visualPolish: mean((r) => r.dimensions.visualPolish),
    interactivity: mean((r) => r.dimensions.interactivity),
    accessibility: mean((r) => r.dimensions.accessibility),
    codeQuality: mean((r) => r.dimensions.codeQuality),
  };
  const issues: EvaluationIssue[] = [];
  const critiques: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  results.forEach((r, i) => {
    const canvas = perCanvas[i]!.canvas;
    for (const issue of r.issues) issues.push({ ...issue, description: `[${canvas}] ${issue.description}` });
    if (r.critique) critiques.push(`${canvas}: ${r.critique}`);
    inputTokens += r.inputTokens ?? 0;
    outputTokens += r.outputTokens ?? 0;
  });
  return {
    passed: perCanvas.every((c) => c.passed),
    finalScore: mean((r) => r.finalScore),
    dimensions,
    issues,
    ...(critiques.length > 0 ? { critique: critiques.join('\n') } : {}),
    inputTokens,
    outputTokens,
    canvases: [...perCanvas],
  };
}

/** The per-canvas verdicts without the PNGs — what the harness stamps on `EvalResult.visual`. */
export function summarizeVisualResult(result: VisualEvaluationResult): VisualEvalSummary | undefined {
  if (result.canvases === undefined) return undefined;
  const canvases: CanvasVisualSummary[] = result.canvases.map((c) => ({
    canvas: c.canvas,
    viewport: c.viewport,
    score: c.score,
    passed: c.passed,
    contentHeight: c.contentHeight,
    overflow: c.overflow,
    judge: c.judge,
    ...(c.fit !== undefined ? { fit: c.fit } : {}),
  }));
  // ggui#1195 — the fit stamp: the first canvas whose policy FAILS an
  // overflow (the inline card), judged with a measurable height.
  const fitCanvas = result.canvases.find((c) => canvasFitPolicy(c.canvas).overflow === 'fail' && c.contentHeight !== null);
  const fit: VisualFitStamp | undefined =
    fitCanvas !== undefined && fitCanvas.contentHeight !== null
      ? {
          canvas: fitCanvas.canvas,
          ceiling: { width: fitCanvas.viewport.width, height: fitCanvas.viewport.height },
          // Declared = the order carried a box, even one equal to the class box (the review's point).
          declared: fitCanvas.declared === true,
          overflowPx: Math.max(0, fitCanvas.contentHeight - fitCanvas.viewport.height),
        }
      : undefined;
  return {
    score: result.finalScore,
    passed: result.passed,
    canvases,
    ...(fit !== undefined ? { fit } : {}),
    ...(result.design !== undefined ? { design: result.design } : {}),
    ...(result.themeMode !== undefined ? { themeMode: result.themeMode } : {}),
  };
}

/**
 * Exported for testing — bundles and builds the HTML for rendering;
 * `callMultimodalLLM` so the #504 routing contract (config →
 * `createVisionAgent`) is assertable without a screenshot pipeline.
 */
export { bundleForRendering, buildRenderHTML, callMultimodalLLM };

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/**
 * Recover a judge answer cut off inside its `issues` array: all four
 * dimensions must be present in the prefix (else null); issue objects
 * that closed are kept; `critique` (emitted last) is usually lost and is
 * replaced by a truncation note so the receipt says what happened.
 */
export function salvageTruncatedVisualAnswer(text: string, passThreshold: number): EvaluationResult | null {
  const dim = (name: string): number | null => {
    const m = text.match(new RegExp(`"${name}"\\s*:\\s*(\\d+(?:\\.\\d+)?)`));
    return m ? Number(m[1]) : null;
  };
  const completeness = dim('completeness');
  const layout = dim('layout');
  const hierarchy = dim('hierarchy');
  const aesthetics = dim('aesthetics');
  if (completeness === null || layout === null || hierarchy === null || aesthetics === null) return null;
  const issues: Array<{ dimension: string; severity: string; description: string; fix: string }> = [];
  const issuesAt = text.indexOf('"issues"');
  if (issuesAt >= 0) {
    for (const m of text.slice(issuesAt).matchAll(/\{[^{}]*\}/g)) {
      try {
        const o = JSON.parse(m[0]) as { dimension?: unknown; severity?: unknown; description?: unknown; fix?: unknown };
        if (typeof o.description === 'string') {
          issues.push({
            dimension: typeof o.dimension === 'string' ? o.dimension : 'layout',
            severity: typeof o.severity === 'string' ? o.severity : 'minor',
            description: o.description,
            fix: typeof o.fix === 'string' ? o.fix : '',
          });
        }
      } catch {
        // an unclosed object at the cut — skipped by construction
      }
    }
  }
  const rebuilt = JSON.stringify({
    completeness,
    layout,
    hierarchy,
    aesthetics,
    issues,
    critique: `[truncated judge answer — score recovered from the closed prefix; ${issues.length} issue(s) kept, the rest and the critique were cut]`,
  });
  return parseVisualResponse(rebuilt, passThreshold);
}

function parseVisualResponse(text: string, passThreshold: number): EvaluationResult {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Visual evaluator did not return valid JSON: ' + text.slice(0, 200));
  }

  const raw = JSON.parse(jsonMatch[0]);

  // Visual dimensions (equal weights now)
  const completeness = raw.completeness ?? 0;
  const layout = raw.layout ?? 0;
  const hierarchy = raw.hierarchy ?? 0;
  const aesthetics = raw.aesthetics ?? 0;

  // Weighted average
  const finalScore = Math.round(
    completeness * 0.25 +
    layout * 0.25 +
    hierarchy * 0.25 +
    aesthetics * 0.25,
  );

  // Map to standard dimensions for consistency
  const dimensions: DimensionScores = {
    completeness,
    visualPolish: aesthetics,
    interactivity: 0,            // can't assess interactivity from screenshot
    accessibility: 0,            // can't assess a11y from screenshot
    codeQuality: 0,              // can't assess code from screenshot
  };

  const issues: EvaluationIssue[] = (raw.issues || []).map((i: Record<string, string>) => ({
    dimension: i.dimension || 'visual',
    severity: (i.severity as 'critical' | 'major' | 'minor') || 'minor',
    description: i.description || '',
    fix: i.fix || '',
  }));

  return {
    passed: finalScore >= passThreshold,
    finalScore,
    dimensions,
    issues,
    critique: raw.critique,
  };
}

// ---------------------------------------------------------------------------
// Default models for visual evaluation
// ---------------------------------------------------------------------------

function getDefaultVisualModel(provider: 'claude' | 'google'): string {
  switch (provider) {
    case 'claude': return 'claude-haiku-4-5-20251001';
    case 'google': return 'gemini-3-flash-preview';
  }
}

// ---------------------------------------------------------------------------
// Tier 2 adapter — returns EvalIssue[]
// ---------------------------------------------------------------------------

/** What the harness's eval round consumes from the visual leg. */
export interface VisualEvalOutcome {
  /** Tier-2 issues (empty when no browser is available). */
  issues: EvalIssue[];
  /**
   * Per-canvas summary — present ONLY when `config.canvases` was set and
   * the leg ran; the harness stamps it on `EvalResult.visual`. Absent on
   * the single-shot path (byte-identical to the pre-canvas result).
   */
  summary?: VisualEvalSummary;
}

/**
 * Run visual evaluation and return tier 2 EvalIssues (+ the per-canvas
 * summary when canvases were requested).
 */
export async function runVisualEval(
  context: VisualEvalContext,
  config: VisualEvalConfig,
): Promise<VisualEvalOutcome> {
  const result = await runVisualEvaluation(context, config);
  if (!result) return { issues: [] }; // puppeteer not available

  const issues: EvalIssue[] = (result.issues || []).map(issue => ({
    tier: 2 as const,
    result: (issue.severity === 'critical' ? 'fail' : 'warn') as 'fail' | 'warn',
    category: 'visual' as const,
    subcategory: issue.dimension,
    severity: (issue.severity === 'critical' ? 'critical' : 'major') as 'critical' | 'major',
    description: issue.description,
    fix: issue.fix || '',
  }));
  const summary = summarizeVisualResult(result);
  return summary === undefined ? { issues } : { issues, summary };
}
