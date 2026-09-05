// Published source must be plain text: no control bytes other than tab / LF / CR.
//
// Bought on the #837 vocabulary sweep (2026-09-05): four files under
// oss/packages/*/src carried a raw NUL byte inside a string literal (a join
// separator). `file` calls such a file "data", grep treats it as binary and
// reports nothing, and every text-based sweep is blind to it — the gate in
// scripts/check-oss-vocabulary.mjs (a JavaScript RegExp) saw what grep could
// not. The idiom is fine written as the six-character escape backslash-u-0000,
// which yields the same character at runtime; the raw byte is not.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PACKAGES_DIR = join(REPO_ROOT, "oss", "packages");
const SOURCE_FILE = /\.(ts|tsx|mts|cts|js|mjs|cjs|json|md)$/;
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

/** Offsets of control bytes other than tab / LF / CR — empty for plain text. */
export function controlByteOffsets(buffer) {
  const offsets = [];
  for (let i = 0; i < buffer.length; i++) {
    const byte = buffer[i];
    if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) offsets.push(i);
  }
  return offsets;
}

test("controlByteOffsets: tab / LF / CR are text; NUL and other C0 bytes are not", () => {
  assert.deepEqual(controlByteOffsets(Buffer.from("a\tb\nc\r\n")), []);
  assert.deepEqual(controlByteOffsets(Buffer.from([0x61, 0x00, 0x62, 0x1b])), [1, 3]);
});

test("no published source file under oss/packages/*/src carries a control byte", () => {
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
      const offsets = controlByteOffsets(readFileSync(file));
      if (offsets.length > 0) {
        offenders.push(`${relative(REPO_ROOT, file)} (${offsets.length} control byte(s), first at offset ${offsets[0]})`);
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `control bytes in published source — write the character as the escape \\u0000 instead:\n  ${offenders.join("\n  ")}`,
  );
});
