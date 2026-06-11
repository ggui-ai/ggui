#!/usr/bin/env node
/**
 * Generate self-contained inline ESM modules for iframe sandboxes.
 *
 * Reads the compiled design package output (dist/tokens/, dist/primitives/)
 * and bundles each into a single ESM file with React imports rewritten to
 * esm.sh URLs. The output is consumed by:
 *   - packages/ggui-react (DynamicComponent.tsx blob URLs)
 *   - cloud/amplify/functions/render (importmap endpoints)
 *
 * Run: node packages/design/scripts/generate-inline-modules.mjs
 * Or:  pnpm --filter @ggui-ai/design build:inline
 */

import { build } from 'esbuild';
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DESIGN_ROOT = resolve(__dirname, '..');
const DIST_DIR = resolve(DESIGN_ROOT, 'dist');
const INLINE_DIR = resolve(DIST_DIR, 'inline');

const REACT_ESM_URL = 'https://esm.sh/react@18.2.0';

// Ensure output dir exists
mkdirSync(INLINE_DIR, { recursive: true });

/**
 * Bundle a design package entry point into a single self-contained ESM module.
 * React is marked external and then rewritten to esm.sh URL.
 */
async function bundleModule(entryPoint, outputName) {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    write: false,
    // Mark react as external — we rewrite imports to esm.sh
    external: ['react'],
    // Tree-shake unused exports
    treeShaking: true,
    // Minify whitespace but keep readability
    minifyWhitespace: false,
    minifySyntax: false,
    minifyIdentifiers: false,
  });

  let code = result.outputFiles[0].text;

  // Rewrite React imports to esm.sh URLs
  // Handles: from "react", from 'react', from "react/jsx-runtime"
  code = code.replace(
    /from\s*["']react(\/[^"']*)?["']/g,
    (match, subpath) => `from "${REACT_ESM_URL}${subpath || ''}"`
  );
  // Also handle: import "react" (side-effect imports)
  code = code.replace(
    /import\s*["']react(\/[^"']*)?["']/g,
    (match, subpath) => `import "${REACT_ESM_URL}${subpath || ''}"`
  );

  const outPath = resolve(INLINE_DIR, outputName);
  writeFileSync(outPath, code, 'utf-8');

  return { code, path: outPath, size: code.length };
}

/**
 * Validate that the bundled module exports match the source package exports.
 * Returns an array of missing export names.
 */
function validateExports(bundledCode, sourceExports) {
  const missing = [];
  for (const name of sourceExports) {
    // Check for: export { name }, export const name, export function name
    const patterns = [
      new RegExp(`export\\s*\\{[^}]*\\b${name}\\b[^}]*\\}`),
      new RegExp(`export\\s+(const|let|var|function|class)\\s+${name}\\b`),
    ];
    if (!patterns.some(p => p.test(bundledCode))) {
      missing.push(name);
    }
  }
  return missing;
}

// ── Token exports we expect ──
const TOKEN_EXPORTS = [
  // colors.ts
  'primary', 'gray', 'success', 'warning', 'error', 'info', 'semantic', 'colors',
  // spacing.ts
  'spacing', 'spacingValues', 'maxWidth', 'radius', 'shadow', 'zIndex',
  // typography.ts
  'fontFamily', 'fontSize', 'fontSizeValues', 'fontWeight', 'lineHeight',
  'letterSpacing', 'headingStyles', 'textStyles', 'typography',
  // transitions.ts
  'duration', 'easing', 'transition',
  // motion.ts
  'keyframes', 'animation', 'reducedMotionCSS', 'motionSafe',
  // accessibility.ts
  'focusRing', 'reducedMotion', 'highContrast', 'accessibility',
  // elevation.ts
  'elevation',
  // chart.ts
  'chartColors',
  // index.ts
  'tokens',
];

// ── Primitive exports we expect ──
const PRIMITIVE_EXPORTS = [
  // layout
  'Container', 'Card', 'Box', 'Stack', 'Row', 'Divider', 'Spacer',
  // typography
  'Text', 'Heading',
  // form
  'Button', 'Input', 'TextArea', 'Select', 'Checkbox', 'Toggle', 'RadioGroup', 'Slider',
  // feedback
  'Badge', 'Spinner', 'Avatar', 'Alert', 'Progress',
  // media
  'Image', 'Icon',
  // navigation
  'Link', 'Tooltip',
  // data
  'Table',
  // disclosure
  'Tabs', 'Accordion',
  // overlay
  'Toast',
  // motion
  'MotionKeyframes', 'useMotion',
];

// ── Component exports we expect ──
const COMPONENT_EXPORTS = [
  'SearchField', 'FormField', 'MenuItem', 'Tag',
  'Dropdown', 'Autocomplete', 'Breadcrumb', 'Pagination',
];

// ── Composition exports we expect ──
const COMPOSITION_EXPORTS = [
  'Header', 'Sidebar', 'CardGrid', 'CommentThread',
  'DataTable', 'ChatWindow', 'NavigationBar', 'FileUploader',
  'UserProfileCard', 'NotificationCenter', 'Modal', 'CommandPalette',
  'Footer', 'Hero', 'IncidentTimeline',
];

// ── Interact exports we expect ──
const INTERACT_EXPORTS = [
  'Clickable', 'Hoverable', 'Pressable',
];

// ── Main ──
async function main() {
  console.log('[inline-modules] Bundling design system for iframe sandboxes...');

  // Check dist exists
  if (!existsSync(resolve(DIST_DIR, 'tokens', 'index.js'))) {
    console.error('[inline-modules] ERROR: dist/tokens/index.js not found. Run `pnpm --filter @ggui-ai/design build` first.');
    process.exit(1);
  }

  // Bundle tokens
  const tokens = await bundleModule(
    resolve(DIST_DIR, 'tokens', 'index.js'),
    'tokens.mjs',
  );
  console.log(`[inline-modules] tokens.mjs: ${(tokens.size / 1024).toFixed(1)} KB`);

  // Bundle primitives
  const primitives = await bundleModule(
    resolve(DIST_DIR, 'primitives', 'index.js'),
    'primitives.mjs',
  );
  console.log(`[inline-modules] primitives.mjs: ${(primitives.size / 1024).toFixed(1)} KB`);

  // Bundle components
  const components = await bundleModule(
    resolve(DIST_DIR, 'components', 'index.js'),
    'components.mjs',
  );
  console.log(`[inline-modules] components.mjs: ${(components.size / 1024).toFixed(1)} KB`);

  // Bundle compositions
  const compositions = await bundleModule(
    resolve(DIST_DIR, 'compositions', 'index.js'),
    'compositions.mjs',
  );
  console.log(`[inline-modules] compositions.mjs: ${(compositions.size / 1024).toFixed(1)} KB`);

  // Bundle interact
  const interact = await bundleModule(
    resolve(DIST_DIR, 'interact', 'index.js'),
    'interact.mjs',
  );
  console.log(`[inline-modules] interact.mjs: ${(interact.size / 1024).toFixed(1)} KB`);

  // Validate exports
  const missingTokens = validateExports(tokens.code, TOKEN_EXPORTS);
  const missingPrimitives = validateExports(primitives.code, PRIMITIVE_EXPORTS);
  const missingComponents = validateExports(components.code, COMPONENT_EXPORTS);
  const missingCompositions = validateExports(compositions.code, COMPOSITION_EXPORTS);

  if (missingTokens.length > 0) {
    console.error(`[inline-modules] ERROR: Missing token exports: ${missingTokens.join(', ')}`);
    console.error('[inline-modules] Update TOKEN_EXPORTS in this script or fix the source.');
    process.exit(1);
  }

  if (missingPrimitives.length > 0) {
    console.error(`[inline-modules] ERROR: Missing primitive exports: ${missingPrimitives.join(', ')}`);
    console.error('[inline-modules] Update PRIMITIVE_EXPORTS in this script or fix the source.');
    process.exit(1);
  }

  if (missingComponents.length > 0) {
    console.error(`[inline-modules] ERROR: Missing component exports: ${missingComponents.join(', ')}`);
    console.error('[inline-modules] Update COMPONENT_EXPORTS in this script or fix the source.');
    process.exit(1);
  }

  if (missingCompositions.length > 0) {
    console.error(`[inline-modules] ERROR: Missing composition exports: ${missingCompositions.join(', ')}`);
    console.error('[inline-modules] Update COMPOSITION_EXPORTS in this script or fix the source.');
    process.exit(1);
  }

  const missingInteract = validateExports(interact.code, INTERACT_EXPORTS);
  if (missingInteract.length > 0) {
    console.error(`[inline-modules] ERROR: Missing interact exports: ${missingInteract.join(', ')}`);
    console.error('[inline-modules] Update INTERACT_EXPORTS in this script or fix the source.');
    process.exit(1);
  }

  // Generate JS module with embedded strings (works in both Node.js and bundlers)
  const indexContent = `// AUTO-GENERATED — do not edit manually.
// Run: pnpm --filter @ggui-ai/design build:inline
// Source: packages/design/scripts/generate-inline-modules.mjs

/** Self-contained ESM module string for @ggui-ai/design/tokens */
export declare const INLINE_TOKENS_MODULE: string;

/** Self-contained ESM module string for @ggui-ai/design/primitives */
export declare const INLINE_PRIMITIVES_MODULE: string;

/** Self-contained ESM module string for @ggui-ai/design/components */
export declare const INLINE_COMPONENTS_MODULE: string;

/** Self-contained ESM module string for @ggui-ai/design/compositions */
export declare const INLINE_COMPOSITIONS_MODULE: string;

/** Self-contained ESM module string for @ggui-ai/design/interact */
export declare const INLINE_INTERACT_MODULE: string;
`;

  // Escape backticks and ${} in the module code so it can be embedded in template literals
  const escapeForTemplate = (code) =>
    code.replace(/\\/g, '\\\\').replace(/`/g, '\\`').replace(/\$\{/g, '\\${');

  const jsContent = `// AUTO-GENERATED — do not edit manually.
// Run: pnpm --filter @ggui-ai/design build:inline
// Source: packages/design/scripts/generate-inline-modules.mjs

/** Self-contained ESM module string for @ggui-ai/design/tokens */
export const INLINE_TOKENS_MODULE = \`${escapeForTemplate(tokens.code)}\`;

/** Self-contained ESM module string for @ggui-ai/design/primitives */
export const INLINE_PRIMITIVES_MODULE = \`${escapeForTemplate(primitives.code)}\`;

/** Self-contained ESM module string for @ggui-ai/design/components */
export const INLINE_COMPONENTS_MODULE = \`${escapeForTemplate(components.code)}\`;

/** Self-contained ESM module string for @ggui-ai/design/compositions */
export const INLINE_COMPOSITIONS_MODULE = \`${escapeForTemplate(compositions.code)}\`;

/** Self-contained ESM module string for @ggui-ai/design/interact */
export const INLINE_INTERACT_MODULE = \`${escapeForTemplate(interact.code)}\`;
`;

  writeFileSync(resolve(INLINE_DIR, 'index.d.ts'), indexContent);
  writeFileSync(resolve(INLINE_DIR, 'index.js'), jsContent);

  console.log('[inline-modules] Generated:');
  console.log(`  ${INLINE_DIR}/tokens.mjs`);
  console.log(`  ${INLINE_DIR}/primitives.mjs`);
  console.log(`  ${INLINE_DIR}/components.mjs`);
  console.log(`  ${INLINE_DIR}/compositions.mjs`);
  console.log(`  ${INLINE_DIR}/index.js (+ .d.ts)`);
  console.log('[inline-modules] Done. All exports validated.');
}

main().catch(err => {
  console.error('[inline-modules] Fatal:', err);
  process.exit(1);
});
