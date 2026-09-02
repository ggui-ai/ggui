/**
 * ggui#670 Phase 1 admissibility pin (adversarial-pass fold 3/14): the
 * wire docs generator's `hookFiles` allowlist is the TAUGHT surface —
 * `WIRE_DOCUMENTATION` is interpolated verbatim into the generation
 * system prompt ("## Reference: Wire Hooks"). Phase 1 ships the live
 * `isConnected` mechanism SILENT: no new hook enters the allowlist and
 * the `useRender` teaching text is byte-identical, so the prompt does
 * not move without a bench. Any change here is prompt motion and must
 * ride a pre-registered bench (Phase 2).
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

describe('taught wire surface is frozen for ggui#670 Phase 1', () => {
  it('the docs generator allowlist is exactly the five taught hooks', () => {
    const src = readFileSync(resolve(here, '..', 'scripts', 'generate-wire-docs.ts'), 'utf8');
    const start = src.indexOf('const hookFiles');
    const end = src.indexOf('];', start);
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, end);
    const names = [...block.matchAll(/hookName:\s*'([A-Za-z]+)'/g)].map((m) => m[1]);
    expect(names).toEqual(['useAction', 'useStream', 'useAuth', 'useApp', 'useRender']);
  });

  it('useRender keeps its exact taught docstring and return shape (prompt byte-identical)', () => {
    const src = readFileSync(resolve(here, 'useRender.ts'), 'utf8');
    expect(src).toContain('/** Read-only render context with connection status. */');
    expect(src).toContain('export interface GguiSessionInfo {');
    expect(src).toContain('  sessionId: string;');
    expect(src).toContain('  isConnected: boolean;');
    // No new documented fields on the taught interface.
    const iface = src.slice(src.indexOf('export interface GguiSessionInfo'), src.indexOf('}', src.indexOf('export interface GguiSessionInfo')));
    expect(iface.split('\n').filter((l) => l.includes(':')).length).toBe(2);
  });
});

describe('the rendered prompt surface (WIRE_DOCUMENTATION) is frozen — the wire build regenerates it', () => {
  // `pnpm --filter @ggui-ai/wire build` ends with `generate:docs`, which
  // rewrites ui-gen's get-wire.ts from THIS package's source. The
  // generator prints EVERY WireConfig member and provider prop, so any
  // new documented member is prompt motion even when no hook changes.
  // (ggui#670 Phase 1 caught its own leak this way: an optional
  // `render.connection` field surfaced ~400 chars into the prompt.)
  it('WireConfig.render prints exactly {sessionId, isConnected} and the provider has exactly config + children', async () => {
    // The artifact is ONE JS string literal with `\n` escape sequences —
    // unescape before line-anchored matching.
    const doc = readFileSync(resolve(here, '..', '..', 'ui-gen', 'src', 'tools', 'get-wire.ts'), 'utf8').replace(/\\n/g, '\n');
    expect(doc).toContain('| render | `{     readonly sessionId: string;     readonly isConnected: boolean;   }` | render |');
    // Pin the absence of the FIELD, not the word: "render context with
    // connection status" is the taught useRender docstring.
    expect(doc).not.toContain('ConnectionStore');
    expect(doc).not.toContain('connection?:');
    const provider = doc.slice(doc.indexOf('### GguiWireProvider'), doc.indexOf('## Internal: WireConfig'));
    expect((provider.match(/^\| [a-zA-Z]+ \| `/gm) ?? []).length).toBe(2);
  });
});

describe('the rendered PRIMITIVES references are frozen for ggui#670 G1 (design build regenerates both)', () => {
  // `pnpm --filter @ggui-ai/design build` ends with generate:docs AND
  // generate:docs-ts — two taught artifacts in ui-gen. `Button inert`
  // is hidden with `@internal`; the generators must SKIP it, proven on
  // the rendered artifacts after a full build + regen (rnd's rule):
  // neither reference may mention the prop until Phase 2 un-hides it.
  it('neither primitives reference documents `inert` / `inertHint`', () => {
    for (const rel of ['src/validation/primitives.ts', 'src/tools/get-primitives-ts.ts']) {
      const doc = readFileSync(resolve(here, '..', '..', 'ui-gen', rel), 'utf8');
      expect(doc, rel).not.toMatch(/\binert\??:/);
      expect(doc, rel).not.toMatch(/\binertHint\??:/);
    }
  });
});
