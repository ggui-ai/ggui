// ggui#1380 C2b — the dist-only fact about the worker, pinned as CONFIG,
// not as a build: BOTH render-check workers are explicit tsup entries and NO
// other module imports either one, which is what keeps each worker's body —
// its entry guard included — in its own dist file, so `import.meta.url` names
// the worker file and the guard fires there. (ggui#1769 turned tsup's
// `splitting` on: a module moves into a shared chunk only when two or more
// entries import it, which a worker imported by nothing never is. Built-dist
// receipt on that commit: the guard in both worker files, and
// warmupRuntimeRenderWorker ok from plain Node on the split dist.) The runtime half of
// the guard is pinned by render-check-host.kill-path.integration.test.ts
// with a real spawn of the source worker; an end-to-end receipt on a real
// build (warmupRuntimeRenderWorker ok from plain Node) is the reviewer's,
// cited in the commit — a per-PR tsup build for one case is not worth its
// standing cost.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const tsupConfig = readFileSync(fileURLToPath(new URL('../../../../tsup.config.ts', import.meta.url)), 'utf8');

describe('the render-check workers ship as their own dist entries (ggui#1380 C2b)', () => {
  it('no module imports a worker, so splitting can never move its body (and guard) into a shared chunk', () => {
    const srcRoot = fileURLToPath(new URL('../../../', import.meta.url));
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (p.endsWith('.ts') && !/\.test\.ts$/.test(p) && !p.endsWith('render-check-worker.ts')) {
          // `from` (named, default, namespace and re-exports), dynamic `import()`, and a bare side-effect import.
          if (/from\s+['"][^'"]*render-check-worker(\.js)?['"]|import\(\s*['"][^'"]*render-check-worker(\.js)?['"]\s*\)|import\s+['"][^'"]*render-check-worker(\.js)?['"]/.test(readFileSync(p, 'utf8'))) importers.push(p);
        }
      }
    };
    walk(srcRoot);
    expect(importers).toEqual([]);
  });

  it('both workers are explicit tsup entries', () => {
    expect(tsupConfig).toContain("'src/harness/check/runtime-render/render-check-worker.ts'");
    expect(tsupConfig).toContain("'src/tools/render-check-worker.ts'");
  });
});
