/**
 * Test-only corpus loader (#426 Spec A). Reads Task 1's fetched cache.
 * TWIN NOTE: this is a deliberate copy of agent-server's loader
 * (oss/packages/agent-server/src/testing/corpus.ts) — no cross-package
 * test coupling, no published surface. Keep the two in sync by hand;
 * they are ~40 lines.
 *
 * Boundary law (spec §6): this file and *.contract.test.ts are the ONLY
 * places in this package allowed to import @silverprotocol/* — and even
 * here, only to validate STIMULUS. Assertions live in ggui's terms.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// src/chat-helpers/__tests__/ → chat-helpers/ → src/ → ggui-react/ →
// packages/ → oss/
const CACHE = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  '..',
  '..',
  'e2e',
  'fixtures',
  'silverprotocol',
  '.cache',
);

export function loadLeg(scenario: string, framework: string) {
  const read = (kind: string): unknown =>
    JSON.parse(
      readFileSync(join(CACHE, scenario, `${framework}.${kind}.json`), 'utf8'),
    );
  return {
    native: read('native') as unknown[],
    agjson: read('agjson') as unknown[],
    provenance: read('provenance') as Record<string, unknown>,
  };
}

/**
 * Stable-set INPUT derived from the golden (never an assertion target
 * on ggui's output): how many tool completions in this scenario carry
 * the `_meta.ui` bootstrap. Event-type + structural reads only —
 * FIXTURES.md's stable set.
 *
 * Grounded shape note: in the pinned corpus (cohort 0.4.1) the fold
 * carries `_meta` directly ON the `tool.done` event — not under a
 * `result` property — so this reads `ev._meta.ui`.
 */
export function goldenUiToolDones(agjson: unknown[]): number {
  return agjson.filter((e) => {
    const ev = e as { type?: string; _meta?: { ui?: unknown } };
    return ev.type === 'tool.done' && ev._meta?.ui !== undefined;
  }).length;
}
