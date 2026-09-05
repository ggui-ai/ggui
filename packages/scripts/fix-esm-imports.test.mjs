// Pins for ggui#846: fix-esm-imports rewrites DECLARATIONS as well as runtime
// modules. Until 2026-09-05 the walker took only `.js`, so every published
// `dist/*.d.ts` kept tsc's extensionless `from './x'` — invisible under
// `moduleResolution: bundler`, fatal (TS2835 / TS2305) for a NodeNext consumer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const SCRIPT = fileURLToPath(new URL("./fix-esm-imports.mjs", import.meta.url));

/** A tsc-shaped dist: runtime modules + declarations, a directory import, and one already-extensioned path. */
function fixtureDist() {
  const d = mkdtempSync(join(tmpdir(), "fix-esm-"));
  mkdirSync(join(d, "sub"));
  writeFileSync(join(d, "a.js"), "export const a = 1;\n");
  writeFileSync(
    join(d, "a.d.ts"),
    "export declare const a: number;\nexport type T = { a: number };\n"
  );
  writeFileSync(join(d, "sub", "index.js"), "export const s = 2;\n");
  writeFileSync(
    join(d, "sub", "index.d.ts"),
    "export declare const s: number;\nexport declare const p: import('..').T;\nexport declare const q: import('.').s;\n"
  );
  writeFileSync(
    join(d, "index.js"),
    "export * from './a';\nexport { s } from './sub';\nexport { a as b } from './a.js';\n"
  );
  writeFileSync(
    join(d, "index.d.ts"),
    "export * from './a';\nexport type { T } from './a';\nexport { s } from './sub';\nexport declare const u: import('./a').T;\nexport { a as b } from './a.js';\n"
  );
  return d;
}

function run(dir) {
  return spawnSync(process.execPath, [SCRIPT, dir], { encoding: "utf8" });
}

/** Every relative specifier in a file — `from '…'` and `import('…')` forms. */
function relativeSpecifiers(text) {
  return [...text.matchAll(/(?:from\s+|import\()\s*['"](\.\.?\/[^'"]+)['"]/g)].map((m) => m[1]);
}

function walk(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

test("every relative specifier in every .js AND .d.ts under dist ends in .js after the pass (ggui#846)", () => {
  const d = fixtureDist();
  try {
    const r = run(d);
    assert.equal(r.status, 0, r.stderr);
    for (const file of walk(d).filter((f) => f.endsWith(".js") || f.endsWith(".d.ts"))) {
      for (const spec of relativeSpecifiers(readFileSync(file, "utf8"))) {
        assert.match(
          spec,
          /\.js$/,
          `${file.slice(d.length + 1)} still says "${spec}" — a NodeNext consumer cannot resolve it`
        );
      }
    }
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("directory imports resolve to /index.js, already-extensioned paths are left alone, in declarations too", () => {
  const d = fixtureDist();
  try {
    run(d);
    const dts = readFileSync(join(d, "index.d.ts"), "utf8");
    assert.match(dts, /export \* from '\.\/a\.js';/);
    assert.match(dts, /export type \{ T \} from '\.\/a\.js';/);
    assert.match(dts, /export \{ s \} from '\.\/sub\/index\.js';/);
    assert.match(dts, /import\('\.\/a\.js'\)\.T/);
    const sub = readFileSync(join(d, "sub", "index.d.ts"), "utf8");
    assert.match(
      sub,
      /import\('\.\.\/index\.js'\)\.T/,
      "a bare '..' becomes '../index.js' — tsc emits it for types referenced from the barrel (ggui#846)"
    );
    assert.match(sub, /import\('\.\/index\.js'\)\.s/, "a bare '.' becomes './index.js'");
    assert.equal((dts.match(/'\.\/a\.js\.js'/g) ?? []).length, 0, "an extension is never doubled");
    const js = readFileSync(join(d, "index.js"), "utf8");
    assert.match(js, /export \* from '\.\/a\.js';/);
    assert.match(js, /export \{ s \} from '\.\/sub\/index\.js';/);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});

test("the pass is idempotent — a second run changes nothing", () => {
  const d = fixtureDist();
  try {
    run(d);
    const before = walk(d)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n---\n");
    const r2 = run(d);
    assert.equal(r2.status, 0);
    const after = walk(d)
      .map((f) => readFileSync(f, "utf8"))
      .join("\n---\n");
    assert.equal(after, before);
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
});
