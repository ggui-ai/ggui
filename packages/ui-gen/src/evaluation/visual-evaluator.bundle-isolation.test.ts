// Two bundles never share a working directory. The visual evaluator bundles
// a component by writing it and an entry file to a temp directory, then
// building. The directory was named `ggui-visual-eval-<Date.now()>` with fixed
// file names inside, so two bundles started in the SAME millisecond — parallel
// test workers share TMPDIR, and a process can run concurrent generations —
// wrote into one directory: the first build read the second's component, and
// the first's cleanup deleted the files the second was still building. A lost
// bundle is `unavailable`, and the judge is never called (observed under suite
// load as "k absent ⇒ one call per canvas" reading 0 calls in ~250 ms).
//
// Pinned here with the clock frozen, so both bundles start in the same
// millisecond by construction: each page carries ITS OWN component, and both
// are measured. RED before the per-call directory, GREEN after.

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LaunchOptions } from 'puppeteer-core';
import { runVisualFit, type ScreenshotBrowser, type VisualEvalDeps } from './visual-evaluator.js';

interface Capture { readonly html: string }

function capturingDeps(): VisualEvalDeps & { pages: Capture[] } {
  const pages: Capture[] = [];
  const launch = async (_o: LaunchOptions): Promise<ScreenshotBrowser> => ({
    newPage: async () => ({
      setContent: async (html: string) => {
        pages.push({ html });
      },
      waitForNetworkIdle: async () => {},
      waitForSelector: async () => null,
      evaluate: async () => 300,
      screenshot: async () => new Uint8Array([1, 2, 3]),
    }),
    close: async () => {},
  });
  return { pages, launch, env: { PUPPETEER_EXECUTABLE_PATH: '/fake/chromium' }, settleMs: 0 };
}

const component = (marker: string): string => `export default function C(){ return '${marker}'; }`;

describe('the visual evaluator — every bundle has a directory of its own', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('two bundles started in the same millisecond each render their own component', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1_790_000_000_000);
    const a = capturingDeps();
    const b = capturingDeps();

    const [fitA, fitB] = await Promise.all([
      runVisualFit({ compiledCode: component('MARK_ALPHA'), originalPrompt: 'a' }, { canvases: ['xs-chat-card'] }, a),
      runVisualFit({ compiledCode: component('MARK_BRAVO'), originalPrompt: 'b' }, { canvases: ['xs-chat-card'] }, b),
    ]);

    expect(fitA.status, fitA.status === 'unavailable' ? fitA.reason : '').toBe('measured');
    expect(fitB.status, fitB.status === 'unavailable' ? fitB.reason : '').toBe('measured');
    expect(a.pages).toHaveLength(1);
    expect(b.pages).toHaveLength(1);
    expect(a.pages[0]?.html).toContain('MARK_ALPHA');
    expect(a.pages[0]?.html).not.toContain('MARK_BRAVO');
    expect(b.pages[0]?.html).toContain('MARK_BRAVO');
    expect(b.pages[0]?.html).not.toContain('MARK_ALPHA');
  });
});
