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

import { build } from 'esbuild';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import type { EvaluationResult, EvaluationIssue, DimensionScores } from './types';
import type { EvalIssue } from './types-public.js';

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
}

export interface VisualEvalContext {
  /** Compiled JavaScript code (ESM with imports) */
  compiledCode: string;
  /** Original user prompt */
  originalPrompt: string;
  /** Design system CSS tokens */
  cssTokens?: string;
}

// ---------------------------------------------------------------------------
// HTML blueprint for rendering
// ---------------------------------------------------------------------------

/**
 * Bundle the compiled component with the design system using esbuild.
 * Produces a self-contained IIFE that only needs React + ReactDOM from CDN.
 * Resolves @ggui-ai/design/* imports from the local monorepo packages.
 */
async function bundleForRendering(
  compiledCode: string,
  sampleProps: Record<string, unknown>,
): Promise<string> {
  // Write component + entry to temp files for esbuild
  const tmpDir = resolve(tmpdir(), 'ggui-visual-eval-' + Date.now());
  mkdirSync(tmpDir, { recursive: true });
  const componentFile = resolve(tmpDir, 'component.tsx');
  const entryFile = resolve(tmpDir, 'entry.tsx');

  // Find the design package root — navigate from this file to packages/design/
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const designPkgDir = resolve(__dirname, '..', '..', '..', 'packages', 'design');

  // Write the compiled component as a separate module
  writeFileSync(componentFile, compiledCode);

  // Entry file imports the component and renders it
  const entryCode = `
import React from 'react';
import { createRoot } from 'react-dom/client';
import Component from './component.tsx';

const props = ${JSON.stringify(sampleProps)};
const root = createRoot(document.getElementById('root')!);
try {
  root.render(React.createElement(Component, props));
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
        // D1: generated code imports the single `@ggui-ai/design` barrel.
        // The subpath aliases stay for any first-party / legacy code.
        '@ggui-ai/design': resolve(designPkgDir, 'src', 'index.ts'),
        '@ggui-ai/design/primitives': resolve(designPkgDir, 'src', 'primitives', 'index.ts'),
        '@ggui-ai/design/components': resolve(designPkgDir, 'src', 'components', 'index.ts'),
        '@ggui-ai/design/compositions': resolve(designPkgDir, 'src', 'compositions', 'index.ts'),
        '@ggui-ai/design/interact': resolve(designPkgDir, 'src', 'interact', 'index.ts'),
      },
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
): string {
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    ${cssTokens ?? ''}
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: var(--ggui-font-family-sans, system-ui, -apple-system, sans-serif);
      background: var(--ggui-color-neutral-50, #ffffff);
      color: var(--ggui-color-neutral-900, #111827);
    }
    .error { color: #dc2626; padding: 16px; font-family: monospace; white-space: pre-wrap; }
  </style>
</head>
<body>
  <div id="root"></div>
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

/**
 * Take a screenshot of the rendered component.
 * Returns base64-encoded PNG or null if puppeteer is not available.
 */
async function captureScreenshot(
  html: string,
  viewport: { width: number; height: number } = { width: 1280, height: 800 },
): Promise<Buffer | null> {
  try {
    // puppeteer-core + @sparticuz/chromium — works on both local dev & Lambda
    const puppeteer = await import('puppeteer-core');
    const chromium = await import('@sparticuz/chromium');

    const launchOptions = {
      args: chromium.default.args,
      defaultViewport: viewport,
      executablePath: await chromium.default.executablePath(),
      headless: true,
    };

    const browser = await puppeteer.default.launch(launchOptions);
    try {
      const page = await browser.newPage();
      await page.setContent(html, { waitUntil: 'networkidle0', timeout: 15000 });
      await page.waitForSelector('#root > *', { timeout: 10000 }).catch(() => {});
      // Wait a bit for CSS/fonts to settle
      await new Promise(r => setTimeout(r, 1000));
      const screenshot = await page.screenshot({ type: 'png', fullPage: true }) as Buffer;
      return screenshot;
    } finally {
      await browser.close();
    }
  } catch (e) {
    console.warn(`[visual-eval] screenshot failed: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Multimodal LLM evaluation
// ---------------------------------------------------------------------------

const VISUAL_EVAL_PROMPT = `You are a visual quality evaluator for ggui — a platform where AI agents generate React UI components on demand.

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

interface VisualProviderResponse {
  text: string;
  inputTokens: number;
  outputTokens: number;
}

async function callMultimodalLLM(
  provider: 'claude' | 'google',
  model: string,
  prompt: string,
  screenshot: Buffer,
  originalPrompt: string,
): Promise<VisualProviderResponse> {
  const userPrompt = `## Original Request\n${originalPrompt}\n\nEvaluate the screenshot of the generated component.`;

  if (provider === 'claude') {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    const client = new Anthropic({
      apiKey: process.env.ANTHROPIC_API_KEY,
      baseURL: 'https://api.anthropic.com',
    });
    const response = await client.messages.create({
      model: model.startsWith('anthropic/') ? model.slice(10) : model,
      max_tokens: 1500,
      system: prompt,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: {
              type: 'base64',
              media_type: 'image/png',
              data: screenshot.toString('base64'),
            },
          },
          { type: 'text', text: userPrompt },
        ],
      }],
    });
    return {
      text: response.content.filter(b => b.type === 'text').map(b => b.text).join(''),
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    };
  }

  // Google Gemini
  const { GoogleGenAI } = await import('@google/genai');
  const client = new GoogleGenAI({
    apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY,
  });
  const response = await client.models.generateContent({
    model: model.startsWith('gemini/') ? model.slice(7) : model,
    contents: [{
      role: 'user',
      parts: [
        { inlineData: { mimeType: 'image/png', data: screenshot.toString('base64') } },
        { text: userPrompt },
      ],
    }],
    config: { systemInstruction: prompt },
  });
  const usage = response.usageMetadata;
  return {
    text: response.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '',
    inputTokens: usage?.promptTokenCount ?? 0,
    outputTokens: usage?.candidatesTokenCount ?? 0,
  };
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
export async function runVisualEvaluation(
  context: VisualEvalContext,
  config: VisualEvalConfig,
): Promise<EvaluationResult | null> {
  const startTime = Date.now();

  // Bundle component + design system into a single JS file
  const bundledCode = await bundleForRendering(
    context.compiledCode,
    config.sampleProps ?? {},
  );
  console.log(`[visual-eval] bundled: ${bundledCode.length}B (${Date.now() - startTime}ms)`);

  // Build the HTML page
  const html = buildRenderHTML(bundledCode, context.cssTokens);

  // Take screenshot
  const screenshot = await captureScreenshot(html, config.viewport);
  if (!screenshot) {
    console.warn('[visual-eval] no browser available — skipping visual evaluation');
    return null;
  }
  console.log(`[visual-eval] screenshot: ${screenshot.length}B (${Date.now() - startTime}ms)`);

  // Send to multimodal LLM
  const model = config.model ?? getDefaultVisualModel(config.provider);
  const response = await callMultimodalLLM(
    config.provider,
    model,
    VISUAL_EVAL_PROMPT,
    screenshot,
    context.originalPrompt,
  );

  // Parse response
  const result = parseVisualResponse(response.text, config.passThreshold);
  result.inputTokens = response.inputTokens;
  result.outputTokens = response.outputTokens;

  const elapsed = Date.now() - startTime;
  console.log(`[visual-eval] score=${result.finalScore} (${elapsed}ms) | in=${response.inputTokens} out=${response.outputTokens}`);

  return result;
}

/**
 * Exported for testing — bundles and builds the HTML for rendering.
 */
export { bundleForRendering, buildRenderHTML };

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

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

/**
 * Run visual evaluation and return tier 2 EvalIssues.
 */
export async function runVisualEval(
  context: VisualEvalContext,
  config: VisualEvalConfig,
): Promise<EvalIssue[]> {
  const result = await runVisualEvaluation(context, config);
  if (!result) return []; // puppeteer not available

  return (result.issues || []).map(issue => ({
    tier: 2 as const,
    result: (issue.severity === 'critical' ? 'fail' : 'warn') as 'fail' | 'warn',
    category: 'visual' as const,
    subcategory: issue.dimension,
    severity: (issue.severity === 'critical' ? 'critical' : 'major') as 'critical' | 'major',
    description: issue.description,
    fix: issue.fix || '',
  }));
}
