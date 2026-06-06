/**
 * generate-primitives-docs.ts
 *
 * Reads JSDoc from TypeScript interface definitions in the design system
 * and produces LLM documentation for get-primitives.ts.
 *
 * Usage: node --experimental-strip-types packages/design/scripts/generate-primitives-docs.ts
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface PropInfo {
  name: string;
  type: string;
  defaultValue: string | undefined;
  description: string;
}

interface InterfaceInfo {
  name: string;
  componentName: string;
  description: string;
  example: string | undefined;
  props: PropInfo[];
  isComponentProps: boolean; // true if name ends with Props
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const designRoot = path.resolve(import.meta.dirname, '..');
const uiGenRoot = path.resolve(designRoot, '../ui-gen');
// Legacy alias retained for the get-primitives-ts.ts path which still lives in
// cloud/generation-runtime/src/tools/ — see generate-primitives-docs-ts.ts.

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

// ---------------------------------------------------------------------------
// TypeScript AST helpers
// ---------------------------------------------------------------------------

function getJSDocDescription(node: ts.Node): string {
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) return '';
  const doc = jsDocs[0];
  if (!doc.comment) return '';
  if (typeof doc.comment === 'string') return doc.comment;
  // For JSDocComment nodes, concatenate text parts
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

// ---------------------------------------------------------------------------
// Parse interfaces from a single types.ts file
// ---------------------------------------------------------------------------

function parseInterfaces(filePath: string): InterfaceInfo[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true, // setParentNodes
    ts.ScriptKind.TS,
  );

  const interfaces: InterfaceInfo[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isInterfaceDeclaration(node)) return;

    const name = node.name.text;

    // Skip BaseProps (internal, not user-facing)
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

      // Skip style and className (from BaseProps)
      if (propName === 'style' || propName === 'className') continue;

      const propType = typeNodeToString(member.type, sourceFile);
      const propDescription = getJSDocDescription(member);
      const defaultValue = getJSDocTag(member, 'default');

      props.push({
        name: propName,
        type: propType,
        defaultValue,
        description: propDescription,
      });
    }

    interfaces.push({
      name,
      componentName,
      description,
      example,
      props,
      isComponentProps,
    });
  });

  return interfaces;
}

// ---------------------------------------------------------------------------
// Parse export names from index.ts files
// ---------------------------------------------------------------------------

function parseExportNames(indexPath: string): string[] {
  const source = fs.readFileSync(indexPath, 'utf-8');
  const names: string[] = [];
  // Process line by line to distinguish `export { ... }` from `export type { ... }`
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    // Skip type-only exports
    if (trimmed.startsWith('export type')) continue;
    // Skip re-exports like `export * from`
    if (trimmed.startsWith('export *')) continue;

    // Match: export { A, B, C } from '...'
    const match = trimmed.match(/^export\s*\{([^}]+)\}\s*from/);
    if (!match) continue;

    const exportList = match[1];
    for (const item of exportList.split(',')) {
      const name = item.trim().split(/\s+/)[0]; // handle "X as Y" aliases
      if (name && /^[A-Z]/.test(name)) { // only component names (start with uppercase)
        names.push(name);
      }
    }
  }
  return names;
}

// ---------------------------------------------------------------------------
// Markdown escaping for table cells
// ---------------------------------------------------------------------------

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatTypeForTable(type: string): string {
  // Wrap in backticks, escape pipes
  const escaped = escapeTableCell(type);
  return '`' + escaped + '`';
}

// ---------------------------------------------------------------------------
// Generate markdown for a section
// ---------------------------------------------------------------------------

function generateSectionMarkdown(
  sectionName: string,
  importPath: string,
  interfaces: InterfaceInfo[],
): string {
  const lines: string[] = [];
  lines.push(`## ${sectionName}`);
  lines.push('');
  lines.push(`Import: \`import { Component } from '${importPath}'\``);
  lines.push('');

  // Separate component interfaces (ending with Props) from support types
  const componentInterfaces = interfaces.filter((i) => i.isComponentProps);
  const supportTypes = interfaces.filter((i) => !i.isComponentProps);

  // Render component interfaces
  for (const iface of componentInterfaces) {
    lines.push(`### ${iface.componentName}`);
    lines.push('');
    if (iface.description) {
      lines.push(iface.description);
      lines.push('');
    }

    if (iface.props.length > 0) {
      lines.push('**Props:**');
      lines.push('');
      lines.push('| Prop | Type | Default | Description |');
      lines.push('|------|------|---------|-------------|');
      for (const prop of iface.props) {
        const defaultVal = prop.defaultValue ? `\`${escapeTableCell(prop.defaultValue)}\`` : '-';
        const desc = escapeTableCell(prop.description || prop.name);
        lines.push(`| ${prop.name} | ${formatTypeForTable(prop.type)} | ${defaultVal} | ${desc} |`);
      }
      lines.push('');
    }

    if (iface.example) {
      lines.push('**Example:**');
      lines.push('```tsx');
      lines.push(iface.example.trim());
      lines.push('```');
      lines.push('');
    }
  }

  // Render support types
  if (supportTypes.length > 0) {
    lines.push('### Support Types');
    lines.push('');
    for (const iface of supportTypes) {
      lines.push(`**${iface.name}:**`);
      lines.push('');
      if (iface.description) {
        lines.push(iface.description);
        lines.push('');
      }
      if (iface.props.length > 0) {
        lines.push('| Property | Type | Description |');
        lines.push('|----------|------|-------------|');
        for (const prop of iface.props) {
          const desc = escapeTableCell(prop.description || prop.name);
          lines.push(`| ${prop.name} | ${formatTypeForTable(prop.type)} | ${desc} |`);
        }
        lines.push('');
      }
    }
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Static sections appended at the end
// ---------------------------------------------------------------------------

const STATIC_SECTIONS = `## System Conventions

### onChange Behavior (CRITICAL)

All form control onChange handlers receive the VALUE DIRECTLY, not a React event object.

\`\`\`tsx
// CORRECT — onChange receives value directly
<Input value={name} onChange={setName} />
<Input value={email} onChange={(value) => setEmail(value)} />
<Select value={country} onChange={setCountry} options={countries} />
<Checkbox checked={agreed} onChange={setAgreed} />

// WRONG — DO NOT use e.target.value!
<Input value={name} onChange={(e) => setName(e.target.value)} /> // WILL BREAK
\`\`\`

Applies to: Input, TextArea, Select, Checkbox, RadioGroup, Slider, Tabs, Accordion.

### Available Motion & Animation

Render \`<MotionKeyframes />\` once (anywhere in tree) to enable all keyframes.

**Entrance/exit:** fadeIn, fadeOut, slideInUp, slideInDown, scaleIn, scaleOut
**State feedback:** flash (background-color highlight), pulse (opacity breathing), bounce (scale overshoot)
**Easing:** linear, easeIn, easeOut, easeInOut, spring (bouncy)
**Durations:** instant(0ms), fast(100ms), normal(200ms), slow(300ms), slower(500ms)

\`\`\`tsx
// Entrance animation on mount
<div style={{ animation: 'ggui-fadeIn 200ms ease-out' }}>Content</div>

// Stagger list items
{items.map((item, i) => (
  <div key={item.id} style={{ animation: \\\`ggui-slideInUp 300ms ease-out \\\${i * 50}ms both\\\` }}>
    {item.name}
  </div>
))}

// Flash highlight when data changes (e.g., stock price update)
// useAnimationKey returns a key that increments when dep changes → remounts element → replays animation
const priceKey = useAnimationKey(stock.price);
<div key={priceKey} style={{
  animation: animation.flash,
  '--ggui-flash-color': stock.change > 0 ? 'var(--ggui-color-success-100)' : 'var(--ggui-color-error-100)',
} as React.CSSProperties}>
  {stock.price}
</div>

// Respect reduced-motion preference
const { motionEnabled } = useMotion();
<div style={motionEnabled ? { animation: 'ggui-scaleIn 200ms ease-out' } : undefined}>
  Content
</div>
\`\`\`

### Elevation System

6 levels mapping shadow intensity to z-index for layering:
- Level 0: flat (no shadow, z: auto) — inline content
- Level 1: sm shadow (z: auto) — cards, sections
- Level 2: md shadow (z: 1000) — dropdowns, popovers
- Level 3: lg shadow (z: 1200) — sticky banners
- Level 4: xl shadow (z: 1400) — modals, dialogs
- Level 5: 2xl shadow (z: 1800) — tooltips, toasts

### Import Constraints

Only these imports are allowed:
- \`react\`
- \`@ggui-ai/design\` — the whole design system (primitives, components, compositions, and the \`Clickable\` / \`Hoverable\` / \`Pressable\` traits) is one import; there are no subpaths
- \`@ggui-ai/wire\` (wire hooks)

No external libraries (lodash, date-fns, etc.). No fetch(). No eval().`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const sections: string[] = [];

  // Header
  sections.push(`# ggui Primitives & Design System Reference

> You are a world-class UI engineer working with ggui's component library for the first time.
> This reference documents every available component, prop, and convention.
> Components handle theming automatically via built-in variants — pick the right variant and the theme does the rest.
> For custom styling beyond variants, use CSS variables: var(--ggui-*, fallback).`);

  // Generate sections from type files
  for (const { filePath, section, importPath } of sourceFiles) {
    const interfaces = parseInterfaces(filePath);
    sections.push(generateSectionMarkdown(section, importPath, interfaces));
  }

  // Append static conventions
  sections.push(STATIC_SECTIONS);

  const markdown = sections.join('\n\n');

  // Parse primitive exports from index.ts
  const primitivesIndexPath = path.join(designRoot, 'src/primitives/index.ts');
  const primitiveExports = parseExportNames(primitivesIndexPath);

  // Also grab component and composition exports
  const componentsIndexPath = path.join(designRoot, 'src/components/index.ts');
  const compositionsIndexPath = path.join(designRoot, 'src/compositions/index.ts');
  const componentExports = parseExportNames(componentsIndexPath);
  const compositionExports = parseExportNames(compositionsIndexPath);

  // Also parse marketing sub-exports
  const marketingIndexPath = path.join(designRoot, 'src/compositions/marketing/index.ts');
  if (fs.existsSync(marketingIndexPath)) {
    const marketingExports = parseExportNames(marketingIndexPath);
    compositionExports.push(...marketingExports);
  }

  const allExports = [...primitiveExports, ...componentExports, ...compositionExports];

  // Build output TypeScript file
  const output = `/**
 * AUTO-GENERATED from @ggui-ai/design JSDoc.
 * Do not edit manually. Run: pnpm --filter @ggui-ai/design generate:docs
 */
export const PRIMITIVES_DOCUMENTATION = ${JSON.stringify(markdown)};

/**
 * Get primitives documentation for the UI generator.
 * Returns comprehensive TypeScript interfaces, examples, and usage patterns.
 */
export function getPrimitives(): string {
  return PRIMITIVES_DOCUMENTATION;
}

/**
 * List of all valid primitive names for validation.
 */
export const VALID_PRIMITIVES = [
${allExports.map((name) => `  '${name}',`).join('\n')}
] as const;

export type ValidPrimitive = (typeof VALID_PRIMITIVES)[number];

/**
 * Check if a primitive name is valid.
 */
export function isValidPrimitive(name: string): name is ValidPrimitive {
  return VALID_PRIMITIVES.includes(name as ValidPrimitive);
}
`;

  const outputPath = path.join(uiGenRoot, 'src/validation/primitives.ts');
  // eslint-disable-next-line no-console
  if (!fs.existsSync(path.dirname(outputPath))) { console.log("Skipping write: core/ not found (standalone mode)"); return; }
  fs.writeFileSync(outputPath, output, 'utf-8');

  /* eslint-disable no-console */
  console.log(`Generated ${outputPath}`);
  console.log(`  Sections: ${sourceFiles.map((s) => s.section).join(', ')}`);
  console.log(`  VALID_PRIMITIVES: ${allExports.length} exports (${primitiveExports.length} primitives, ${componentExports.length} components, ${compositionExports.length} compositions)`);
  /* eslint-enable no-console */
}

main();
