// Published source imports zod as a namespace — `import * as z from "zod"` —
// never through zod's aliased `z` export or its default export.
//
// zod's entry is `import * as z from "./v4/classic/external.js"; export { z, z
// as default }`: a namespace OBJECT re-exported under a name. esbuild shakes
// member accesses off a namespace the importing module owns (`import * as z`),
// but not off a re-exported namespace object — so one `import { z } from "zod"`
// anywhere in a bundle keeps all of zod, its 64 locale tables included.
// Measured on the iframe runtime's served bundle (ggui#2032): the same
// `z.object(...)` call sites bundled to 453,767 B of zod with 63 locale files
// through `import { z }`, and to 89,740 B with one locale through
// `import * as z`. Every published package can be bundled by esbuild — the
// iframe runtime, a self-hoster's Vite dev server, a Lambda — so the form is
// gated here, over every package's source, tests included (a test's import
// form is copied into source).
//
// Type-only imports (`import type { z }`, `import { type z }`) are erased at
// compile time and stay free. Named members (`import { ZodError } from "zod"`)
// shake and stay free.
//
// Two entries are closed outright: `zod/v4/core` (it re-exports the locale
// tables as a namespace, so any value import of it is one access away from all
// 64) and `zod/v4/locales` / `zod/v4/locales/<x>` (the tables themselves).
// Members come through the `zod` namespace.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "oss", "packages");
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs)$/;
const SKIP_DIR = new Set(["node_modules", "dist"]);

function* walk(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!SKIP_DIR.has(entry.name)) yield* walk(path);
    } else if (SOURCE_FILE.test(entry.name)) {
      yield path;
    }
  }
}

// A zod specifier: "zod", "zod/v4", "zod/mini", "zod/v4-mini", "zod/v4/mini" …
// — every entry exports the aliased `z` and a default.
const ZOD_SPECIFIER = String.raw`(?<q>['"])(?<spec>zod(?:\/[\w.-]+)*)\k<q>\s*;?`;
// Entries closed to every value import: the core entry and the locale tables.
const CLOSED_ENTRY = /^zod\/v4\/(core|locales)(\/|$)/;
// `import * as name from "zod/…"` — fine for the public entries, an offence
// for a closed one.
const STAR_IMPORT = new RegExp(String.raw`(?<![\w$.])import\s+(?!type\s)\*\s*as\s+[\w$]+\s*from\s*` + ZOD_SPECIFIER, "g");
// A value import (not `import type`) with a brace list, or with a default
// binding, from a zod specifier. Multi-line brace lists are matched whole.
const VALUE_IMPORT = new RegExp(
  String.raw`(?<![\w$.])import\s+(?!type\s)(?:(?<def>[A-Za-z_$][\w$]*)\s*,?\s*)?(?:\{(?<names>[^}]*)\})?\s*from\s*` + ZOD_SPECIFIER,
  "g",
);

/**
 * The offending import statements in one source text: each `import { z }`
 * (also `z as other`, `z` among other names) or default import from a zod
 * entry. `import * as z`, `import type { z }`, `import { type z }` and named
 * members are not offences and are not returned.
 */
export function zodAliasImports(source) {
  const offences = [];
  for (const match of source.matchAll(VALUE_IMPORT)) {
    const { def, names } = match.groups;
    const bindsZ =
      names !== undefined &&
      names
        .split(",")
        .map((n) => n.trim())
        .some((n) => /^z(?:\s+as\s+[\w$]+)?$/.test(n));
    const closedEntry = CLOSED_ENTRY.test(match.groups.spec);
    if (def !== undefined || bindsZ || closedEntry) {
      offences.push({ line: source.slice(0, match.index).split("\n").length, statement: match[0].replace(/\s+/g, " ") });
    }
  }
  for (const match of source.matchAll(STAR_IMPORT)) {
    if (CLOSED_ENTRY.test(match.groups.spec)) {
      offences.push({ line: source.slice(0, match.index).split("\n").length, statement: match[0].replace(/\s+/g, " ") });
    }
  }
  return offences.sort((a, b) => a.line - b.line);
}

test("zodAliasImports: the aliased `z`, the default export and the core/locale entries are offences; the namespace, type-only and named-member forms on the public entries are not", () => {
  const offend = (src) => zodAliasImports(src).map((o) => o.statement);
  assert.deepEqual(offend(`import { z } from 'zod';`), [`import { z } from 'zod';`]);
  assert.deepEqual(offend(`import { z } from "zod/v4";`), [`import { z } from "zod/v4";`]);
  assert.deepEqual(offend(`import { z, type ZodRawShape } from 'zod';`), [`import { z, type ZodRawShape } from 'zod';`]);
  assert.deepEqual(offend(`import { ZodError, z } from 'zod';`), [`import { ZodError, z } from 'zod';`]);
  assert.deepEqual(offend(`import { z as zod } from 'zod/mini';`), [`import { z as zod } from 'zod/mini';`]);
  assert.deepEqual(offend(`import zod from 'zod';`), [`import zod from 'zod';`]);
  assert.deepEqual(offend(`import {\n  z,\n  ZodError,\n} from 'zod';`), [`import { z, ZodError, } from 'zod';`]);
  assert.deepEqual(offend(`import * as z from 'zod';`), []);
  assert.deepEqual(offend(`import * as z4mini from 'zod/v4-mini';`), []);
  assert.deepEqual(offend(`import type { z } from 'zod';`), []);
  assert.deepEqual(offend(`import { type z } from 'zod';`), []);
  assert.deepEqual(offend(`import { ZodError } from 'zod';\nimport type { ZodRawShape } from 'zod';`), []);
  assert.deepEqual(offend(`import { z } from 'zod-to-json-schema';`), []);
  assert.deepEqual(offend(`import { z } from './zod-helpers';`), []);
  assert.deepEqual(offend(`import * as core from 'zod/v4/core';`), [`import * as core from 'zod/v4/core';`]);
  assert.deepEqual(offend(`import { util } from 'zod/v4/core';`), [`import { util } from 'zod/v4/core';`]);
  assert.deepEqual(offend(`import { en } from 'zod/v4/locales';`), [`import { en } from 'zod/v4/locales';`]);
  assert.deepEqual(offend(`import en from 'zod/v4/locales/en.js';`), [`import en from 'zod/v4/locales/en.js';`]);
  assert.deepEqual(offend(`import type { $ZodType } from 'zod/v4/core';`), []);
  assert.deepEqual(offend(`import * as z4 from 'zod/v4';`), []);
  assert.deepEqual(zodAliasImports(`// a\nimport { ZodError } from 'zod';\nimport { z } from 'zod';`).map((o) => o.line), [3]);
});

test("no published source file under oss/packages/*/src imports zod's aliased `z`, its default export, or its core/locale entries", () => {
  const offenders = [];
  for (const pkg of readdirSync(PACKAGES_DIR)) {
    const src = join(PACKAGES_DIR, pkg, "src");
    let isDir = false;
    try {
      isDir = statSync(src).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) continue;
    for (const file of walk(src)) {
      for (const { line, statement } of zodAliasImports(readFileSync(file, "utf8"))) {
        offenders.push(`${relative(REPO_ROOT, file)}:${line}  ${statement}`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `zod imported through its aliased \`z\` or default export — write \`import * as z from "zod"\` (ggui#2032; esbuild keeps every locale table behind the alias):\n  ${offenders.join("\n  ")}`,
  );
});
