/**
 * Retired-reserved JSON-RPC numbers (SPEC §7.9). A canonical code with no
 * first-party producer is a promise with no party: the constant leaves the
 * block, the NUMBER stays fenced so no future canonical code reuses it,
 * and this pin keeps both true — nothing in the published packages may
 * declare or emit a retired number again. Read from source, the way the
 * refusal-registry pins do (tracked `.ts`, one `git grep`).
 */
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { MCP_ERROR_CODES, PLATFORM_ERROR_CODES } from '../mcp';

/** `-32013 RATE_LIMIT_EXCEEDED` — retired 2026-09-06 (ggui#890): the render caps are refusals; the hosted 429 carries no JSON-RPC body. */
const RETIRED: ReadonlyArray<{ readonly number: number; readonly name: string; readonly issue: string }> = [
  { number: -32001, name: 'UNAUTHORIZED (moved to -32007)', issue: 'ggui#853' },
  { number: -32004, name: 'PRODUCTION_FAILED', issue: 'phantom, never emitted' },
  { number: -32013, name: 'RATE_LIMIT_EXCEEDED', issue: 'ggui#890' },
];

const PACKAGES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');

describe('retired-reserved JSON-RPC numbers (SPEC §7.9)', () => {
  it('no canonical or platform constant declares a retired number', () => {
    const declared = new Set<number>([...Object.values(MCP_ERROR_CODES), ...Object.values(PLATFORM_ERROR_CODES)]);
    for (const r of RETIRED) expect(declared.has(r.number), `${r.number} ${r.name}`).toBe(false);
    expect(Object.keys(PLATFORM_ERROR_CODES)).not.toContain('RATE_LIMIT_EXCEEDED');
  });

  it('no tracked source under oss/packages emits a retired number as a literal (comments and the ledger excepted)', () => {
    const patterns = RETIRED.flatMap((r) => ['-e', `${r.number}`]);
    const run = spawnSync('git', ['grep', '-n', '-F', ...patterns, '--', '*.ts'], { cwd: PACKAGES_DIR, encoding: 'utf8' });
    expect(run.status === 0 || run.status === 1, run.stderr).toBe(true);
    const offenders = run.stdout
      .split('\n')
      .filter((line) => line !== '')
      .filter((line) => !/\.test\.ts:|\/version\.ts:|\/dist\//.test(line))
      .filter((line) => !/^\S+:\d+:\s*(\/\/|\*|\/\*)/.test(line));
    expect(offenders).toEqual([]);
  });
});
