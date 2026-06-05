// packages/ui-gen/src/boilerplate/render.ts
//
// Loads base.tsx.tmpl + layout files from disk, caches them in memory,
// and replaces {{MARKER}} placeholders with generated content.
//
// Package-private — consumers use `generateBoilerplate()` from
// `@ggui-ai/ui-gen/boilerplate`; this file is not re-exported.

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// `@ggui-ai/ui-gen` ships both `src/` and `dist/` (see package.json `files`).
// Templates always live at `<pkg-root>/src/boilerplate/templates/` (kept in
// the published tarball via `files: ['src', 'dist', ...]`). GguiSession.ts gets
// inlined into multiple dist entrypoints by tsup (`boilerplate.js`,
// `harness/runtime.js`, `harness/index.js`, …), so `__dirname` varies. We
// enumerate every reasonable location:
//
//   - From tsx (`src/boilerplate/render.ts`): `./templates`
//   - Bundled into `dist/boilerplate.js`:    `../src/boilerplate/templates`
//   - Bundled into `dist/harness/runtime.js`: `../../src/boilerplate/templates`
//   - Bundled into `dist/harness/coding/X.js`: `../../../src/boilerplate/templates`
//
// Step 3 (2026-04-27): the harness cluster ported in from cloud added the
// `dist/harness/` and `dist/harness/coding/` entrypoints — needed deeper
// upward walks than the pre-step-3 single-level `dist/`.
const TEMPLATE_DIRS = [
  resolve(__dirname, 'templates'),
  resolve(__dirname, '..', 'src', 'boilerplate', 'templates'),
  resolve(__dirname, '..', '..', 'src', 'boilerplate', 'templates'),
  resolve(__dirname, '..', '..', '..', 'src', 'boilerplate', 'templates'),
  resolve(__dirname, '..', '..', '..', '..', 'src', 'boilerplate', 'templates'),
];

let baseCache: string | null = null;
const layoutCache = new Map<string, string>();

function loadBase(): string {
  if (baseCache) return baseCache;

  for (const dir of TEMPLATE_DIRS) {
    try {
      baseCache = readFileSync(resolve(dir, 'base.tsx.tmpl'), 'utf-8');
      return baseCache;
    } catch { continue; }
  }

  throw new Error('No base.tsx.tmpl found');
}

function loadLayout(shellType: string, screen: string): string {
  const key = `${shellType}-${screen}`;
  if (layoutCache.has(key)) return layoutCache.get(key)!;

  // Try exact match, then fallback to universal, then fullscreen-universal
  const candidates = [
    `${shellType}-${screen}.tsx.tmpl`,
    `${shellType}-universal.tsx.tmpl`,
    `fullscreen-universal.tsx.tmpl`, // final fallback
  ];

  for (const filename of candidates) {
    for (const dir of TEMPLATE_DIRS) {
      try {
        const content = readFileSync(resolve(dir, 'layouts', filename), 'utf-8');
        layoutCache.set(key, content);
        return content;
      } catch { continue; }
    }
  }

  throw new Error(`No layout found for ${key}`);
}

export interface BoilerplateMarkers {
  REACT_IMPORT: string;
  ALL_DESIGN: string;
  WIRE_IMPORT: string;
  PROPS_INTERFACE: string;
  ACTION_TYPES: string;
  STREAM_TYPES: string;
  WIRED_TOOL_TYPES: string;
  CLIENT_TOOL_TYPES: string;
  /** `useGguiContext` destructure lines, one per declared `contextSpec`
   * slot. Emitted at the top of the user component body. The runtime
   * owns useState + Provider per slot; the LLM only reads `<slotKey>`
   * and writes via `set<SlotKey>`. Empty when contextSpec is absent or
   * empty. */
  CONTEXT_HOOKS: string;
  WIRE_HOOKS: string;
  AXIS_SECTIONS: string;
}

export function renderBoilerplate(
  shellType: string,
  screen: string,
  markers: BoilerplateMarkers,
): string {
  let template = loadBase();
  const layout = loadLayout(shellType, screen);
  template = template.replace('{{LAYOUT}}', layout);

  for (const [key, value] of Object.entries(markers)) {
    template = template.replaceAll(`{{${key}}}`, value);
  }

  return template;
}
