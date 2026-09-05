/**
 * `@ggui-ai/protocol/wire` — the browser entry (ggui#819).
 *
 * A bundler cannot drop a module whose top level constructs zod schemas,
 * so the iframe pays for every module its entry reaches. This pin walks
 * the runtime import graph from `src/wire.ts` (relative `import` /
 * `export … from`, type-only statements excluded) and asserts the
 * server-side modules — every tool's input/output schema, the ops tools,
 * the LLM route tables, the contract schema — are unreachable from it.
 * Measured before the split: `schemas/mcp.js` 21.4 KB, `ops-blueprint.js`
 * 6.5 KB, `types/llm.js` 5.5 KB, `data-contract.js` 6.2 KB and
 * `stdlib-gadgets.js` 4.1 KB of raw bundle for one constant and one
 * interface-context schema the browser actually used.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SRC = dirname(fileURLToPath(import.meta.url));

/** Modules the browser never validates against — MUST stay out of the wire graph. */
const SERVER_ONLY = [
  'schemas/mcp.ts',
  'schemas/ops-blueprint.ts',
  'schemas/render-input-envelope.ts',
  'schemas/handshake-suggestion.ts',
  'schemas/blueprint.ts',
  'types/llm.ts',
  'types/llm-route.ts',
];
// NOT server-only, on purpose: `schemas/data-contract.ts` is reached because
// the stdlib gadget hooks validate a descriptor draft in the browser
// (`@ggui-ai/gadgets` `createGguiGadget` → `strictGadgetDescriptorSchema`);
// and `gadgets/stdlib-gadgets.ts` is reached through
// `validation/hygiene-rules.ts`, which derives the permission grammar the
// browser enforces (`KNOWN_PERMISSION_NAMES`, `UnknownPermissionNameError`)
// from the stdlib catalog — the catalog IS the browser's data there.

function resolveRelative(fromFile: string, spec: string): string | null {
  const base = resolve(dirname(fromFile), spec.replace(/\.js$/, ''));
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Runtime import graph — `import type` / `export type` statements are erased and skipped. */
function reachable(entry: string): Set<string> {
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const src = readFileSync(file, 'utf8');
    const re = /^(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"](\.[^'"]+)['"]/gm;
    for (const m of src.matchAll(re)) {
      if (m[2] !== undefined) continue;
      const target = resolveRelative(file, m[3]);
      if (target !== null) queue.push(target);
    }
  }
  return seen;
}

describe('@ggui-ai/protocol/wire — the browser entry reaches only what a browser validates (ggui#819)', () => {
  it('exists as src/wire.ts', () => {
    expect(existsSync(join(SRC, 'wire.ts'))).toBe(true);
  });

  it('never reaches a server-only module at runtime', () => {
    const reached = [...reachable(join(SRC, 'wire.ts'))].map((f) => f.slice(SRC.length + 1));
    const leaked = SERVER_ONLY.filter((m) => reached.includes(m));
    expect(leaked, `reached ${reached.length} modules`).toEqual([]);
  });

  it('carries the runtime values the browser packages import from the barrel today', async () => {
    const wire = await import('./wire');
    for (const name of [
      'validateActionEnvelope',
      'validateActionData',
      'validateContextData',
      'validatePropsData',
      'validateStreamData',
      'DEFAULT_CONTEXT_DEBOUNCE_MS',
      'projectHostContext',
      'hostContextProjectionsEqual',
      'RESERVED_CHANNEL_PREFIX',
      'isKnownReservedChannel',
      'defaultInterfaceContext',
      'detectInterfaceContext',
      'PUBLIC_ENV_APP_KEY_RE',
      'RUNTIME_TELEMETRY_MAX_EVENTS',
      'makeActionEnvelope',
      'invokeEventSchema',
      'KNOWN_PERMISSION_NAMES',
      'UnknownPermissionNameError',
      'BRIDGE_EVENTS',
    ]) {
      expect((wire as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});
