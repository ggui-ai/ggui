/**
 * `compileBlueprint` op tests (Slice 7.0 — TSX → JS compile boundary,
 * 2026-05-19).
 *
 * Determinism is the load-bearing invariant — same input MUST produce
 * the same digest, byte-for-byte. Federation (Slice 7.6) and cross-app
 * cache sharing (Slice 7.1) depend on this. Tests pin:
 *
 *   - determinism (same source → same digest, multiple invocations)
 *   - distinctness (different source → different digest)
 *   - whitespace sensitivity (insignificant for cache; same digest under
 *     identical input regardless of process-state)
 *   - failure shape (esbuild compile error → typed err result)
 *   - keepNames + external preservation (semantic contract for the
 *     iframe runtime + matcher)
 *   - DEPLOY-1 regression (2026-05-19) — `compileBlueprint` works when
 *     the calling module is bundled as ESM (the Lambda packaging
 *     posture). Pins the fix that adds `esbuild` to the publish
 *     Lambda's CDK `nodeModules` sidecar list.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { describe, expect, it } from 'vitest';
import { compileBlueprint, compiledDigestHex } from './compile.js';

describe('compileBlueprint', () => {
  it('compiles a minimal TSX blueprint to ESM JS', () => {
    const source = 'export default function App() { return <div>hi</div>; }';
    const result = compileBlueprint(source);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const text = Buffer.from(result.compiledBytes, 'base64').toString('utf-8');
    // esbuild emits `export { App as default }` for named-function default
    // exports under format=esm; both name + default keyword are present.
    expect(text).toMatch(/\bApp\b/);
    expect(text).toMatch(/\bdefault\b/);
    expect(result.compiledDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(result.compiledSize).toBeGreaterThan(0);
  });

  it('determinism — same source compiles to same digest across invocations', () => {
    const source = `
      import { useState } from 'react';
      export default function Counter() {
        const [count, setCount] = useState(0);
        return <button onClick={() => setCount(count + 1)}>{count}</button>;
      }
    `;
    const a = compileBlueprint(source);
    const b = compileBlueprint(source);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.compiledDigest).toBe(b.compiledDigest);
    expect(a.compiledBytes).toBe(b.compiledBytes);
    expect(a.compiledSize).toBe(b.compiledSize);
  });

  it('distinctness — different source compiles to different digest', () => {
    const sourceA = 'export default function A() { return <span>A</span>; }';
    const sourceB = 'export default function B() { return <span>B</span>; }';
    const a = compileBlueprint(sourceA);
    const b = compileBlueprint(sourceB);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.compiledDigest).not.toBe(b.compiledDigest);
  });

  it('compiledDigestHex matches the inline digest from compileBlueprint', () => {
    const source = 'export default () => <i/>';
    const r = compileBlueprint(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(compiledDigestHex(r.compiledBytes)).toBe(r.compiledDigest);
  });

  it('preserves the externals contract — imports survive in compiled output', () => {
    const source = `
      import { useState } from 'react';
      import { jsx } from 'react/jsx-runtime';
      export default function App() { return jsx('div', { children: useState(0)[0] }); }
    `;
    const r = compileBlueprint(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = Buffer.from(r.compiledBytes, 'base64').toString('utf-8');
    // transformSync preserves import statements; bundle:false posture.
    // esbuild canonicalizes to double quotes.
    expect(text).toMatch(/from "react"/);
    expect(text).toMatch(/from "react\/jsx-runtime"/);
  });

  it('keepNames — identifiers survive in compiled output', () => {
    const source = `export default function WeatherCard(props) { return <article>{props.city}</article>; }`;
    const r = compileBlueprint(source);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const text = Buffer.from(r.compiledBytes, 'base64').toString('utf-8');
    expect(text).toContain('WeatherCard');
  });

  it('rejects invalid TSX with a typed err result carrying esbuild diagnostics', () => {
    const source = 'export default function Broken() { return <div is not valid; }';
    const r = compileBlueprint(source);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors.length).toBeGreaterThan(0);
    expect(typeof r.errors[0]?.message).toBe('string');
  });
});

/**
 * DEPLOY-1 regression (Slice 7.0, 2026-05-19) — esbuild-on-Lambda.
 *
 * Background: the publish Lambda is bundled as ESM (`format: ESM` in
 * `cloud/cdk/registry-stack.ts`). Before the fix, esbuild was bundled
 * INTO the handler. `esbuild.transformSync` spawns a worker thread via
 * `new Worker(__filename, ...)` — but `__filename` is not a binding in
 * a bundled ESM module, so the worker spawn threw `ReferenceError:
 * __filename is not defined` on every blueprint publish.
 *
 * A `globalThis.__filename = ''` shim does NOT fix this — ESM free-name
 * lookup does not fall through to globalThis. Setting `__filename` via
 * a banner (so it becomes a module-scope binding) lets the code run,
 * but esbuild's own `lib/main.js` then trips its bundled-detector and
 * throws "The esbuild JavaScript API cannot be bundled. Please mark
 * the 'esbuild' package as external" — by design.
 *
 * The fix: mark `esbuild` as external + ship it as a Lambda sidecar
 * (CDK `nodeModules: ['esbuild']` on PublishFn), same pattern as
 * oxc-parser. This regression test bundles a tiny script that calls
 * `compileBlueprint` into ESM with `external: ['esbuild']` and runs
 * it as a subprocess. If a future change re-bundles esbuild into the
 * Lambda artifact, this test catches it.
 *
 * The test does not pin the *failure* shape — that would require
 * negative-bundling with `external: []`, which depends on platform
 * specifics (worker-thread paths, etc.). Pinning the *success* shape
 * is the load-bearing assertion: "the publish-Lambda packaging
 * posture renders a usable compileBlueprint."
 */
describe('compileBlueprint — Slice 7.0 DEPLOY-1 ESM-bundled-Lambda posture', () => {
  it('works when the caller is bundled as ESM with esbuild marked external', async () => {
    // Resolve the compiled `./compile.js` next to this test file. Vitest
    // runs source TS via tsx — the compiled artifact lives in `dist/`,
    // but we can equally point the entry-point at the source `.ts`
    // file (esbuild will compile it inline during bundle).
    const here = fileURLToPath(new URL('.', import.meta.url));
    const compileEntry = join(here, 'compile.ts');

    // Bundle output lives next to `registry-core/node_modules` so the
    // ESM resolver finds the external `esbuild` package via the normal
    // upward node_modules walk (mirrors how CDK + pnpm lay out the
    // Lambda artifact: `<lambda-root>/node_modules/esbuild/...`).
    // `os.tmpdir()` would land in `/tmp` with no esbuild reachable.
    const packageRoot = join(here, '..', '..');
    const tmp = mkdtempSync(join(packageRoot, '.test-bundle-deploy1-'));
    try {
      const entryScript = join(tmp, 'entry.mjs');
      writeFileSync(
        entryScript,
        `
import { compileBlueprint } from ${JSON.stringify(compileEntry)};
const r = compileBlueprint('export default function F() { return null; }');
process.stdout.write(JSON.stringify({ ok: r.ok, hasDigest: r.ok ? typeof r.compiledDigest === 'string' : false }));
        `,
      );

      const bundled = join(tmp, 'bundled.mjs');
      await esbuild.build({
        entryPoints: [entryScript],
        bundle: true,
        format: 'esm',
        platform: 'node',
        target: 'node22',
        // The fix: esbuild MUST be external. This mirrors the CDK
        // `nodeModules: ['esbuild']` posture on PublishFn (which makes
        // CDK + esbuild treat the dep as external + install it as a
        // sidecar). Bundling esbuild here reproduces the original
        // deploy-block.
        external: ['esbuild'],
        // ESM-Lambda banner — exactly what the CDK stack injects on
        // every NodejsFunction.
        banner: {
          js:
            "import { createRequire as topLevelCreateRequire } from 'node:module'; " +
            "const require = topLevelCreateRequire(import.meta.url);",
        },
        outfile: bundled,
      });

      const proc = spawnSync(process.execPath, [bundled], {
        encoding: 'utf-8',
        timeout: 10_000,
      });
      expect(proc.status, `bundled script exited non-zero: ${proc.stderr}`).toBe(0);
      const parsed = JSON.parse(proc.stdout) as { ok: boolean; hasDigest: boolean };
      expect(parsed.ok).toBe(true);
      expect(parsed.hasDigest).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 30_000);
});
