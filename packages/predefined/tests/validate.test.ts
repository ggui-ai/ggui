/**
 * Reference-design integrity tests for `@ggui-ai/predefined`.
 *
 * This package ships data — JSON specs + reference TSX — that
 * `@ggui-cloud/generation-runtime`'s PredefinedRegistry loads at runtime.
 * If a spec is malformed, references a missing token, or its `name` doesn't
 * match the React export, the registry will silently mis-key the component
 * (or the generated UI will fail to import). These tests are the gate that
 * keeps the package shippable.
 *
 * Six invariants are enforced per component:
 *   1. spec.json conforms to the JSON Schema in `schema/`.
 *   2. spec.name matches the React `export default` name in component.tsx.
 *   3. Every visual.tokens path resolves in tokens/base.tokens.json.
 *   4. Every dependencies[] entry exists as another component on disk.
 *   5. component.tsx compiles via esbuild (TSX → ESM).
 *   6. component.tsx only imports from the runtime-resolvable allow-list
 *      (`react`, `@ggui-ai/design/primitives`, `@predefined/*`). External
 *      bare specifiers (e.g. `lucide-react`) survive past esbuild.transform
 *      and break in the browser because there's no importmap or bundler.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import Ajv, { type ValidateFunction } from 'ajv';
import { transform } from 'esbuild';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = join(__dirname, '..');
const LEVELS = ['blueprints', 'components', 'composites'] as const;

interface ComponentSpec {
  id?: string;
  name: string;
  level: 'primitive' | 'component' | 'composite' | 'blueprint';
  category: string;
  description: string;
  visual: {
    description: string;
    layout: string;
    tokens: string[];
  };
  interface: {
    props: { name: string; type: string; required: boolean; description: string }[];
    callbacks: string[];
    slots: string[];
  };
  examples: { prompt: string; match: number }[];
  dependencies?: string[];
  tags?: string[];
  stream?: Record<string, unknown>;
}

interface DiscoveredComponent {
  dir: string;
  level: (typeof LEVELS)[number];
  name: string;
  specPath: string;
  tsxPath: string;
  spec: ComponentSpec;
}

function discover(): DiscoveredComponent[] {
  const out: DiscoveredComponent[] = [];
  for (const level of LEVELS) {
    const levelDir = join(PKG_ROOT, level);
    let entries: string[];
    try {
      entries = readdirSync(levelDir);
    } catch {
      continue;
    }
    for (const name of entries) {
      const dir = join(levelDir, name);
      if (!statSync(dir).isDirectory()) continue;
      const specPath = join(dir, 'spec.json');
      const tsxPath = join(dir, 'component.tsx');
      const spec: ComponentSpec = JSON.parse(readFileSync(specPath, 'utf-8'));
      out.push({ dir: name, level, name, specPath, tsxPath, spec });
    }
  }
  return out;
}

/**
 * Resolve a dot-separated DTCG token path against the loaded tokens object.
 * Returns true if the path lands on a `$value` leaf (the DTCG terminal).
 */
function tokenExists(tokens: Record<string, unknown>, path: string): boolean {
  const parts = path.split('.');
  let cursor: unknown = tokens;
  for (const part of parts) {
    if (cursor === null || typeof cursor !== 'object') return false;
    cursor = (cursor as Record<string, unknown>)[part];
    if (cursor === undefined) return false;
  }
  if (cursor === null || typeof cursor !== 'object') return false;
  return '$value' in (cursor as Record<string, unknown>);
}

/**
 * Pull the `export default function X(` or `export default X` identifier
 * out of a TSX source — the runtime registry uses this name when emitting
 * import paths for the LLM, so mismatch breaks generated code.
 */
function extractDefaultExportName(tsx: string): string | null {
  const fn = tsx.match(/export\s+default\s+function\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
  if (fn) return fn[1];
  const named = tsx.match(/export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*[;\n]/);
  if (named) return named[1];
  return null;
}

let components: DiscoveredComponent[];
let validateSpec: ValidateFunction;
let tokens: Record<string, unknown>;

beforeAll(() => {
  components = discover();

  const schema = JSON.parse(
    readFileSync(join(PKG_ROOT, 'schema', 'component-spec.schema.json'), 'utf-8'),
  );
  const ajv = new Ajv({ allErrors: true, strict: false });
  validateSpec = ajv.compile(schema);

  tokens = JSON.parse(readFileSync(join(PKG_ROOT, 'tokens', 'base.tokens.json'), 'utf-8'));
});

describe('@ggui-ai/predefined integrity', () => {
  it('discovers at least one component', () => {
    expect(components.length).toBeGreaterThan(0);
  });

  describe('spec.json conforms to JSON Schema', () => {
    it.each([] as DiscoveredComponent[])('placeholder', () => {});

    // Generate one test per component at module-load time
    const all = discover();
    for (const c of all) {
      it(`${c.level}/${c.dir}`, () => {
        const ok = validateSpec(c.spec);
        if (!ok) {
          const errors = (validateSpec.errors ?? [])
            .map((e) => `${e.instancePath || '/'} ${e.message}`)
            .join('\n  ');
          throw new Error(`Schema violations in ${c.specPath}:\n  ${errors}`);
        }
        expect(ok).toBe(true);
      });
    }
  });

  describe('spec.name matches component.tsx default export', () => {
    const all = discover();
    for (const c of all) {
      it(`${c.level}/${c.dir}`, () => {
        const tsx = readFileSync(c.tsxPath, 'utf-8');
        const exportName = extractDefaultExportName(tsx);
        expect(exportName, `no default export found in ${c.tsxPath}`).toBeTruthy();
        expect(c.spec.name, `spec.name in ${c.specPath} must equal default export`).toBe(
          exportName,
        );
      });
    }
  });

  describe('visual.tokens references resolve in tokens/base.tokens.json', () => {
    const all = discover();
    for (const c of all) {
      it(`${c.level}/${c.dir}`, () => {
        const missing: string[] = [];
        for (const path of c.spec.visual.tokens) {
          if (!tokenExists(tokens, path)) missing.push(path);
        }
        if (missing.length > 0) {
          throw new Error(
            `Unresolved token paths in ${c.specPath}:\n  ${missing.join('\n  ')}`,
          );
        }
      });
    }
  });

  describe('dependencies[] reference existing components', () => {
    const all = discover();
    const allNames = new Set(all.map((c) => c.spec.name));
    for (const c of all) {
      it(`${c.level}/${c.dir}`, () => {
        const deps = c.spec.dependencies ?? [];
        const missing = deps.filter((d) => !allNames.has(d));
        if (missing.length > 0) {
          throw new Error(
            `Unknown dependencies in ${c.specPath}: ${missing.join(', ')}`,
          );
        }
      });
    }
  });

  describe('component.tsx compiles via esbuild', () => {
    const all = discover();
    for (const c of all) {
      it(`${c.level}/${c.dir}`, async () => {
        const tsx = readFileSync(c.tsxPath, 'utf-8');
        await transform(tsx, {
          loader: 'tsx',
          target: 'es2020',
          format: 'esm',
          jsx: 'automatic',
          jsxImportSource: 'react',
        });
      });
    }
  });

  describe('component.tsx imports stay on the runtime allow-list', () => {
    // Specifiers the registry's resolve-predefined.ts hoists or that the
    // renderer resolves natively. Anything else survives esbuild.transform
    // as a bare specifier and fails in the browser (no importmap, no bundler).
    const ALLOWED = new Set(['react', '@ggui-ai/design/primitives']);
    const ALLOWED_PREFIX = ['@predefined/'];

    const all = discover();
    for (const c of all) {
      it(`${c.level}/${c.dir}`, () => {
        const tsx = readFileSync(c.tsxPath, 'utf-8');
        const importRe = /^\s*import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/gm;
        const violations: string[] = [];
        let match;
        while ((match = importRe.exec(tsx)) !== null) {
          const specifier = match[1];
          if (ALLOWED.has(specifier)) continue;
          if (ALLOWED_PREFIX.some((p) => specifier.startsWith(p))) continue;
          violations.push(specifier);
        }
        if (violations.length > 0) {
          throw new Error(
            `Disallowed imports in ${c.tsxPath}: ${violations.join(', ')}\n` +
              `  Allow-list: react, @ggui-ai/design/primitives, @predefined/*\n` +
              `  Anything else survives esbuild.transform as a bare specifier ` +
              `and fails in the browser at runtime.`,
          );
        }
      });
    }
  });
});
