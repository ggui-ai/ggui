// ggui#1380 C2b — the dist-only fact about the worker, pinned as CONFIG,
// not as a build: tsup keeps `splitting: false` and lists BOTH render-check
// workers as explicit entries, which is what makes `import.meta.url` name the
// worker file in dist so the entry guard fires there. The runtime half of
// the guard is pinned by render-check-host.kill-path.integration.test.ts
// with a real spawn of the source worker; an end-to-end receipt on a real
// build (warmupRuntimeRenderWorker ok from plain Node) is the reviewer's,
// cited in the commit — a per-PR tsup build for one case is not worth its
// standing cost.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tsupConfig = readFileSync(fileURLToPath(new URL('../../../../tsup.config.ts', import.meta.url)), 'utf8');

describe('the render-check workers ship as their own dist entries (ggui#1380 C2b)', () => {
  it('tsup does not split chunks — a worker file is one file, so import.meta.url names it', () => {
    expect(tsupConfig).toMatch(/splitting:\s*false/);
  });

  it('both workers are explicit tsup entries', () => {
    expect(tsupConfig).toContain("'src/harness/check/runtime-render/render-check-worker.ts'");
    expect(tsupConfig).toContain("'src/tools/render-check-worker.ts'");
  });
});
