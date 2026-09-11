/**
 * Pin: the visual judge's bundler resolves the generated component's bare
 * imports — `@ggui-ai/wire` above all — from ui-gen's own node_modules.
 * The bundle entry lives in a temp dir; before `nodePaths` every
 * wire-bearing component (every action / stream bearer) failed with
 * `Could not resolve "@ggui-ai/wire"` and the in-loop visual evaluation
 * threw instead of judging. Browser + judge are injected; esbuild is real.
 */
import { describe, expect, it } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { existsSync } from 'node:fs';
import { resolveWirePackageDir, runVisualEvaluation, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

const WIRE_COMPONENT = `
import React from 'react';
import { useAction } from '@ggui-ai/wire';
import { Button, Stack } from '@ggui-ai/design';
export default function C() {
  const save = useAction('save');
  return React.createElement(Stack, { gap: 'md' }, React.createElement(Button, { onClick: () => save({}) }, 'Save'));
}
`;

function deps(): VisualEvalDeps & { bundled: string[] } {
  const bundled: string[] = [];
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async (html: string) => {
        bundled.push(html);
      },
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 0,
      screenshot: async () => new Uint8Array([0, 1]),
    }),
    close: async () => {},
  });
  return {
    bundled,
    launch,
    env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' },
    settleMs: 0,
    judge: async () => ({
      text: JSON.stringify({ completeness: 90, layout: 90, hierarchy: 90, aesthetics: 90, issues: [] }),
      inputTokens: 1,
      outputTokens: 1,
    }),
  };
}

describe('visual judge bundler — @ggui-ai/wire resolves from the temp entry', () => {
  it('aliases @ggui-ai/wire to an existing file resolved from ui-gen\'s own module graph (layout-proof)', () => {
    const dir = resolveWirePackageDir();
    expect(dir).not.toBeNull();
    expect(existsSync(`${dir}/package.json`)).toBe(true);
    expect(String(dir).endsWith('/wire')).toBe(true);
  });
  it('bundles a wire-bearing component and reaches the judge', async () => {
    const d = deps();
    const result = await runVisualEvaluation(
      { compiledCode: WIRE_COMPONENT, originalPrompt: 'a save button' },
      { provider: 'claude', passThreshold: 60 },
      d,
    );
    expect(result).not.toBeNull();
    expect(d.bundled.length).toBeGreaterThan(0);
    expect(d.bundled[0]?.includes('useAction')).toBe(true);
  });
  it('renders inside GguiWireProvider with the stub config and an error boundary — a wire hook never throws for lack of a provider', async () => {
    const d = deps();
    await runVisualEvaluation({ compiledCode: WIRE_COMPONENT, originalPrompt: 'a save button' }, { provider: 'claude', passThreshold: 60 }, d);
    const html = d.bundled[0] ?? '';
    expect(html.includes('visual-eval')).toBe(true); // the stub config's sessionId / appId
    expect(html.includes('RenderErrorBoundary')).toBe(true);
    // the provider itself is in the bundle (resolved through nodePaths)
    expect(html.includes('WireProvider')).toBe(true);
  });
});
