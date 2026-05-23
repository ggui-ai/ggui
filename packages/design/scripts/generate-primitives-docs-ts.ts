/**
 * generate-primitives-docs-ts.ts
 *
 * Experiment #57 — Option A (processed full docs).
 *
 * Emits TypeScript-interface-format primitive docs. Same info as
 * `generate-primitives-docs.ts` but compacted: drops markdown-table
 * overhead, per-value CSS-var mappings, and verbose prose preambles.
 * Keeps every enum value intact (the error class that causes Claude
 * thrashing) plus a short semantic note per prop when non-obvious.
 *
 * Target: ~50% byte reduction vs the markdown-table version, zero
 * information loss on load-bearing signal.
 *
 * Usage: node --experimental-strip-types packages/design/scripts/generate-primitives-docs-ts.ts
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

interface PropInfo {
  name: string;
  type: string;
  optional: boolean;
  defaultValue: string | undefined;
  description: string;
}

interface InterfaceInfo {
  name: string;
  componentName: string;
  description: string;
  example: string | undefined;
  props: PropInfo[];
  isComponentProps: boolean;
}

const designRoot = path.resolve(import.meta.dirname, '..');
// ui-gen is the sole consumer post-2026-05-23 (the second consumer
// `cloud/generation-runtime/src/tools/get-primitives-ts.ts` was retired
// alongside the orphan `@ggui-cloud/generation-runtime` package).
const uiGenRoot = path.resolve(designRoot, '../ui-gen');

const sourceFiles = [
  {
    filePath: path.join(designRoot, 'src/primitives/types.ts'),
    section: 'Primitives',
    importPath: '@ggui-ai/design',
  },
  {
    filePath: path.join(designRoot, 'src/components/types.ts'),
    section: 'Components',
    importPath: '@ggui-ai/design',
  },
  {
    filePath: path.join(designRoot, 'src/compositions/types.ts'),
    section: 'Compositions',
    importPath: '@ggui-ai/design',
  },
];

function getJSDocDescription(node: ts.Node): string {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) return '';
  const doc = jsDocs[0];
  if (!doc.comment) return '';
  if (typeof doc.comment === 'string') return doc.comment;
  return doc.comment.map((c: ts.JSDocComment) => c.text || '').join('');
}

function getJSDocTag(node: ts.Node, tagName: string): string | undefined {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) return undefined;
  for (const doc of jsDocs) {
    if (!doc.tags) continue;
    for (const tag of doc.tags) {
      if (tag.tagName.text === tagName) {
        if (!tag.comment) return '';
        if (typeof tag.comment === 'string') return tag.comment;
        return tag.comment.map((c: ts.JSDocComment) => c.text || '').join('');
      }
    }
  }
  return undefined;
}

function typeNodeToString(typeNode: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  if (!typeNode) return 'unknown';
  return typeNode.getText(sourceFile);
}

function parseInterfaces(filePath: string): InterfaceInfo[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const interfaces: InterfaceInfo[] = [];

  // First pass — collect interfaces so type aliases can reference them.
  const byName = new Map<string, InterfaceInfo>();

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    const name = node.name.text;
    if (name === 'BaseProps') return;

    const description = getJSDocDescription(node);
    const example = getJSDocTag(node, 'example');
    const isComponentProps = name.endsWith('Props');
    const componentName = isComponentProps ? name.replace(/Props$/, '') : name;

    const props: PropInfo[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member)) continue;
      const propName = member.name ? member.name.getText(sourceFile) : '';
      if (!propName) continue;
      if (propName === 'style' || propName === 'className') continue;

      const propType = typeNodeToString(member.type, sourceFile);
      const propDescription = getJSDocDescription(member);
      const defaultValue = getJSDocTag(member, 'default');
      const optional = !!member.questionToken;

      props.push({ name: propName, type: propType, optional, defaultValue, description: propDescription });
    }

    const info = { name, componentName, description, example, props, isComponentProps };
    interfaces.push(info);
    byName.set(name, info);
  });

  // Second pass — resolve type aliases like `RowProps = Omit<StackProps, 'direction'>`.
  // Copy the base interface's props + description, subtract Omit keys, add optional
  // Pick-only props. Keeps the alias's own JSDoc if present.
  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isTypeAliasDeclaration(node)) return;
    const aliasName = node.name.text;
    if (!aliasName.endsWith('Props')) return;
    if (byName.has(aliasName)) return;

    const aliasDesc = getJSDocDescription(node);
    const aliasExample = getJSDocTag(node, 'example');
    const typeText = node.type.getText(sourceFile);

    // Match: Omit<BaseName, 'key1' | 'key2'> or Pick<BaseName, 'key'>
    const omitMatch = typeText.match(/^Omit<\s*(\w+)\s*,\s*([^>]+)\s*>/);
    const pickMatch = typeText.match(/^Pick<\s*(\w+)\s*,\s*([^>]+)\s*>/);
    const baseMatch = typeText.match(/^(\w+)$/);

    let baseName: string | null = null;
    let omitKeys: Set<string> = new Set();
    let pickKeys: Set<string> | null = null;

    if (omitMatch) {
      baseName = omitMatch[1];
      omitKeys = new Set(
        (omitMatch[2] ?? '').split('|').map((s) => s.trim().replace(/['"]/g, '')),
      );
    } else if (pickMatch) {
      baseName = pickMatch[1];
      pickKeys = new Set(
        (pickMatch[2] ?? '').split('|').map((s) => s.trim().replace(/['"]/g, '')),
      );
    } else if (baseMatch) {
      baseName = baseMatch[1];
    } else {
      return; // Unknown shape; skip
    }

    const base = baseName ? byName.get(baseName) : null;
    if (!base) return;

    const inheritedProps = base.props.filter((p) => {
      if (omitKeys.has(p.name)) return false;
      if (pickKeys && !pickKeys.has(p.name)) return false;
      return true;
    });

    const componentName = aliasName.replace(/Props$/, '');
    interfaces.push({
      name: aliasName,
      componentName,
      description: aliasDesc || `Alias — ${baseName} without ${[...omitKeys].join(', ')}`,
      example: aliasExample,
      props: inheritedProps,
      isComponentProps: true,
    });
  });

  return interfaces;
}

function parseExportNames(indexPath: string): string[] {
  const source = fs.readFileSync(indexPath, 'utf-8');
  const names: string[] = [];
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('export type')) continue;
    if (trimmed.startsWith('export *')) continue;
    const match = trimmed.match(/^export\s*\{([^}]+)\}\s*from/);
    if (!match) continue;
    const exportList = match[1];
    for (const item of exportList.split(',')) {
      const name = item.trim().split(/\s+/)[0];
      if (name && /^[A-Z]/.test(name)) names.push(name);
    }
  }
  return names;
}

/**
 * Collapse verbose JSDoc prose into a one-line semantic note.
 * Strips per-value enum breakdowns + CSS-var mappings + markdown bullets.
 * Returns `''` if nothing useful survives.
 */
function condenseDescription(desc: string): string {
  if (!desc) return '';
  // Take only the first sentence / line, drop everything after.
  let firstLine = desc.split(/[.\n]/).find((s) => s.trim().length > 0) ?? '';
  firstLine = firstLine.trim();
  // Cap at 80 chars
  if (firstLine.length > 80) firstLine = firstLine.slice(0, 77) + '...';
  // Drop redundant leading "When true," / "Whether to" phrases that duplicate the prop name
  return firstLine;
}

/**
 * Collapse a TS type string: strip whitespace/newlines inside union types,
 * keep structural integrity.
 */
function compactType(type: string): string {
  return type
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function formatInterface(iface: InterfaceInfo): string {
  const lines: string[] = [];
  const interfaceName = iface.isComponentProps ? `${iface.componentName}Props` : iface.name;

  // One-line description as a leading comment (if any).
  if (iface.description) {
    let short = condenseDescription(iface.description);
    // Strip redundant "ComponentName --" prefix the JSDoc author included.
    const prefixRe = new RegExp(`^${iface.componentName}\\s*(?:--|—|-|:)\\s*`, 'i');
    short = short.replace(prefixRe, '');
    if (short) lines.push(`// ${iface.componentName} — ${short}`);
  }
  lines.push(`interface ${interfaceName} {`);

  for (const prop of iface.props) {
    const optional = prop.optional ? '?' : '';
    const type = compactType(prop.type);
    // Trailing comment: default, then short semantic note when non-redundant.
    const comments: string[] = [];
    if (prop.defaultValue) comments.push(`default ${prop.defaultValue.trim()}`);
    if (prop.description) {
      const short = condenseDescription(prop.description);
      // Skip the description if it literally duplicates the prop name / type
      if (short && short.toLowerCase() !== prop.name.toLowerCase()) {
        comments.push(short);
      }
    }
    const suffix = comments.length > 0 ? `  // ${comments.join('; ')}` : '';
    lines.push(`  ${prop.name}${optional}: ${type};${suffix}`);
  }
  lines.push(`}`);

  // Trim and include example if present (compositions benefit most).
  if (iface.example && iface.example.trim()) {
    lines.push('');
    lines.push('// Example:');
    lines.push(iface.example.trim());
  }

  return lines.join('\n');
}

function generateSection(sectionName: string, importPath: string, interfaces: InterfaceInfo[]): string {
  const lines: string[] = [];
  lines.push(`// ════════════════════════════════════════════════════════════`);
  lines.push(`// ${sectionName}   (import from '${importPath}')`);
  lines.push(`// ════════════════════════════════════════════════════════════`);
  lines.push('');
  for (const iface of interfaces) {
    if (!iface.isComponentProps) continue;
    lines.push(formatInterface(iface));
    lines.push('');
  }
  // Support types — keep compact but present
  const supportTypes = interfaces.filter((i) => !i.isComponentProps);
  if (supportTypes.length > 0) {
    lines.push(`// Support types:`);
    for (const iface of supportTypes) {
      lines.push(formatInterface(iface));
      lines.push('');
    }
  }
  return lines.join('\n');
}

const PREAMBLE = `// ════════════════════════════════════════════════════════════
// GGUI DESIGN SYSTEM — COMPONENT REFERENCE
// ════════════════════════════════════════════════════════════
//
// CRITICAL — Props take enum STRING LITERALS, not CSS variables:
//   <Text size="sm" weight="bold" />                         ✓
//   <Text size="var(--ggui-font-size-sm)" />                 ✗  (breaks)
//   The enum strings map to CSS variables internally.
//
// CRITICAL — onChange receives the VALUE directly, not an event:
//   <Input value={x} onChange={setX} />                      ✓
//   <Input onChange={(e) => setX(e.target.value)} />         ✗
//
// Imports allowed: 'react', '@ggui-ai/design', '@ggui-ai/wire'.
//   The WHOLE design system — primitives, components, compositions,
//   traits — is one import: import { Card, Grid, Modal, Clickable }
//   from '@ggui-ai/design'. No subpaths. No external libs, no
//   fetch(), no eval().
//
// All components accept 'style' + 'className' (omitted below).
// Structural primitives (Box, Stack, Row, Card) also take a trait via
// 'as': 'as={Clickable}' adds onClick + keyboard a11y; likewise
// 'as={Hoverable}' and 'as={Pressable}'. Semantic components
// (Button/Link/Input) are already interactive and take no 'as'.
// ════════════════════════════════════════════════════════════`;

const STATIC_FOOTER = `
// ════════════════════════════════════════════════════════════
// System Conventions
// ════════════════════════════════════════════════════════════
//
// Motion: render <MotionKeyframes /> once to enable keyframes.
//   Entrance/exit: fadeIn, fadeOut, slideInUp, slideInDown, scaleIn, scaleOut
//   State feedback: flash, pulse, bounce
//   Easing: linear, easeIn, easeOut, easeInOut, spring
//   Durations: instant(0ms), fast(100ms), normal(200ms), slow(300ms), slower(500ms)
//
// Elevation levels (shadow → z-index):
//   0: flat          1: sm (cards)     2: md z=1000 (dropdowns, popovers)
//   3: lg z=1200     4: xl z=1400      5: 2xl z=1800 (tooltips, toasts)
//
// useAnimationKey(dep) returns a key that bumps when dep changes —
// apply to <div key={...}> to replay CSS animations on data update.
//
// useMotion() returns { motionEnabled } — respect prefers-reduced-motion.
`;

function main() {
  const sections: string[] = [PREAMBLE, ''];

  for (const { filePath, section, importPath } of sourceFiles) {
    const interfaces = parseInterfaces(filePath);
    sections.push(generateSection(section, importPath, interfaces));
  }

  sections.push(STATIC_FOOTER);

  const markdown = sections.join('\n');

  // Parse exports list for VALID_PRIMITIVES (shared with markdown generator).
  const primitivesIndexPath = path.join(designRoot, 'src/primitives/index.ts');
  const componentsIndexPath = path.join(designRoot, 'src/components/index.ts');
  const compositionsIndexPath = path.join(designRoot, 'src/compositions/index.ts');
  const primitiveExports = parseExportNames(primitivesIndexPath);
  const componentExports = parseExportNames(componentsIndexPath);
  const compositionExports = parseExportNames(compositionsIndexPath);
  const marketingIndexPath = path.join(designRoot, 'src/compositions/marketing/index.ts');
  if (fs.existsSync(marketingIndexPath)) {
    compositionExports.push(...parseExportNames(marketingIndexPath));
  }

  const output = `/**
 * AUTO-GENERATED from @ggui-ai/design JSDoc (TS-interface format).
 * Do not edit manually. Run: pnpm --filter @ggui-ai/design generate:docs-ts
 *
 * Experiment #57 (Option A) — processed/compacted doc for LLM consumption.
 * Companion to get-primitives.ts (markdown-table format). Swap between
 * them via ContextPolicy.primitiveDocFormat.
 */
export const PRIMITIVES_DOCUMENTATION_TS = ${JSON.stringify(markdown)};
`;

  const outputPath = path.join(uiGenRoot, 'src/tools/get-primitives-ts.ts');

  /* eslint-disable no-console */
  if (!fs.existsSync(path.dirname(outputPath))) {
    console.log(`Skipping write: ${path.dirname(outputPath)} not found`);
  } else {
    fs.writeFileSync(outputPath, output, 'utf-8');
    console.log(`Generated ${outputPath}`);
  }
  console.log(`  Bytes: ${markdown.length}`);
  console.log(`  Approx tokens: ${Math.round(markdown.length / 3.7)}`);
  console.log(`  Components: ${primitiveExports.length}p + ${componentExports.length}c + ${compositionExports.length}x`);
  /* eslint-enable no-console */
}

main();
