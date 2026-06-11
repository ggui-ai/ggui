/**
 * Regression lock for retired wire-tool names.
 *
 * The R4 rename ledger in `@ggui-ai/protocol` (`src/version.ts`,
 * draft-2026-05-26 entry) records `ggui_runtime_refresh_bootstrap` →
 * `ggui_runtime_refresh_ws_token`. The 2026-06-11 audit (MS-1) found
 * the live WS error message and five docstrings still instructing
 * callers to invoke the OLD name — wire-visible text naming a tool
 * that no longer exists anywhere.
 *
 * This test greps the package source so any reintroduction (in code,
 * wire messages, or docstrings) fails loudly. New renames append to
 * {@link RETIRED_TOOL_NAMES}, mirroring the protocol version ledger.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const RETIRED_TOOL_NAMES = ['ggui_runtime_refresh_bootstrap'] as const;

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
/** This file legitimately names the retired tools — skip itself. */
const SELF = fileURLToPath(import.meta.url);

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
      continue;
    }
    if (full === SELF) continue;
    if (full.endsWith('.ts') || full.endsWith('.tsx')) out.push(full);
  }
  return out;
}

describe('retired wire-tool names stay retired', () => {
  it('no source file references a retired tool name', () => {
    const offenders: string[] = [];
    for (const file of listSourceFiles(SRC_DIR)) {
      const text = readFileSync(file, 'utf8');
      for (const name of RETIRED_TOOL_NAMES) {
        if (text.includes(name)) {
          offenders.push(`${path.relative(SRC_DIR, file)} references ${name}`);
        }
      }
    }
    expect(
      offenders,
      'Retired tool names must not reappear in source, wire messages, or docstrings — see the rename ledger in @ggui-ai/protocol src/version.ts',
    ).toEqual([]);
  });
});
