/**
 * generate-wire-docs.ts
 *
 * Reads JSDoc from TypeScript hook source files in @ggui-ai/wire
 * and produces LLM documentation for ui-gen/src/tools/get-wire.ts.
 *
 * Usage: node --experimental-strip-types packages/wire/scripts/generate-wire-docs.ts
 */

import * as ts from 'typescript';
import * as fs from 'node:fs';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface ParamInfo {
  name: string;
  type: string;
  description: string;
}

interface PropertyInfo {
  name: string;
  type: string;
  description: string;
}

interface HookInfo {
  name: string;
  description: string;
  typeParams: string;
  params: ParamInfo[];
  returnType: string;
  returnProperties: PropertyInfo[];
  example: string | undefined;
}

interface InterfaceInfo {
  name: string;
  description: string;
  properties: PropertyInfo[];
}

interface ProviderInfo {
  name: string;
  description: string;
  propsInterface: string;
  propsProperties: PropertyInfo[];
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const wireRoot = path.resolve(import.meta.dirname, '..');
// Post-OSS-split (2026-04-17): `WIRE_DOCUMENTATION` lives in @ggui-ai/ui-gen,
// not the retired `core/` package. Path is intentionally
// relative to the wire package root so the script remains usable from
// the same monorepo regardless of where it's invoked from.
const uiGenRoot = path.resolve(wireRoot, '../ui-gen');

const hookFiles = [
  { filePath: path.join(wireRoot, 'src/useAction.ts'), hookName: 'useAction' },
  { filePath: path.join(wireRoot, 'src/useStream.ts'), hookName: 'useStream' },
  // useWiredTool retired 2026-05-11 alongside the EE+ wire-shape v2.
  // agentTools is a catalog the AGENT invokes, not a component-side
  // hook surface; user gestures use `useAction(name)` and the optional
  // `nextStep` field on the action entry names the tool the agent
  // SHOULD invoke on its next turn (no `useAgentTool` replacement).
  { filePath: path.join(wireRoot, 'src/useAuth.ts'), hookName: 'useAuth' },
  { filePath: path.join(wireRoot, 'src/useApp.ts'), hookName: 'useApp' },
  { filePath: path.join(wireRoot, 'src/useRender.ts'), hookName: 'useRender' },
];

const providerFile = path.join(wireRoot, 'src/WireProvider.tsx');
const contextFile = path.join(wireRoot, 'src/context.ts');

// ---------------------------------------------------------------------------
// TypeScript AST helpers
// ---------------------------------------------------------------------------

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

function getJSDocParams(node: ts.Node): Map<string, string> {
  const params = new Map<string, string>();
  const jsDocs = (node as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) return params;
  for (const doc of jsDocs) {
    if (!doc.tags) continue;
    for (const tag of doc.tags) {
      if (tag.tagName.text === 'param' && ts.isJSDocParameterTag(tag)) {
        const paramName = tag.name.getText();
        let paramDesc = '';
        if (tag.comment) {
          paramDesc = typeof tag.comment === 'string'
            ? tag.comment
            : tag.comment.map((c: ts.JSDocComment) => c.text || '').join('');
        }
        // Strip leading "- " from descriptions
        params.set(paramName, paramDesc.replace(/^-\s*/, ''));
      }
    }
  }
  return params;
}

function typeNodeToString(typeNode: ts.TypeNode | undefined, sourceFile: ts.SourceFile): string {
  if (!typeNode) return 'unknown';
  return typeNode.getText(sourceFile);
}

// ---------------------------------------------------------------------------
// Parse interface declarations from a source file
// ---------------------------------------------------------------------------

function parseInterfaces(filePath: string): InterfaceInfo[] {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );

  const interfaces: InterfaceInfo[] = [];

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isInterfaceDeclaration(node)) return;
    if (!node.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword)) return;

    const name = node.name.text;
    const description = getJSDocDescription(node);

    const properties: PropertyInfo[] = [];
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) && !ts.isMethodSignature(member)) continue;
      const propName = member.name ? member.name.getText(sourceFile) : '';
      if (!propName) continue;

      const propDesc = getJSDocDescription(member);

      let propType: string;
      if (ts.isMethodSignature(member)) {
        // Method signature: reconstruct the type
        const params = member.parameters
          .map(p => `${p.name.getText(sourceFile)}: ${typeNodeToString(p.type, sourceFile)}`)
          .join(', ');
        const ret = typeNodeToString(member.type, sourceFile);
        propType = `(${params}) => ${ret}`;
      } else {
        propType = typeNodeToString(member.type, sourceFile);
      }

      properties.push({
        name: propName,
        type: propType,
        description: propDesc,
      });
    }

    interfaces.push({ name, description, properties });
  });

  return interfaces;
}

// ---------------------------------------------------------------------------
// Parse a hook function from a source file
// ---------------------------------------------------------------------------

function parseHook(filePath: string): HookInfo | null {
  const source = fs.readFileSync(filePath, 'utf-8');
  const ext = path.extname(filePath);
  const scriptKind = ext === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );

  let hookInfo: HookInfo | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node)) return;
    if (!node.name) return;
    const name = node.name.text;
    if (!name.startsWith('use') && name !== 'GguiWireProvider') return;

    const description = getJSDocDescription(node);
    const example = getJSDocTag(node, 'example');
    const jsDocParams = getJSDocParams(node);

    // Type parameters
    let typeParams = '';
    if (node.typeParameters && node.typeParameters.length > 0) {
      const tpStrings = node.typeParameters.map(tp => {
        let s = tp.name.text;
        if (tp.default) {
          s += ` = ${typeNodeToString(tp.default, sourceFile)}`;
        }
        return s;
      });
      typeParams = `<${tpStrings.join(', ')}>`;
    }

    // Parameters
    const params: ParamInfo[] = [];
    for (const param of node.parameters) {
      const paramName = param.name.getText(sourceFile);
      const paramType = typeNodeToString(param.type, sourceFile);
      const paramDesc = jsDocParams.get(paramName) ?? '';
      params.push({ name: paramName, type: paramType, description: paramDesc });
    }

    // Return type
    const returnType = typeNodeToString(node.type, sourceFile);

    // Return properties — parse from the return type interface if it's a known type
    const returnProperties: PropertyInfo[] = [];

    hookInfo = {
      name,
      description,
      typeParams,
      params,
      returnType,
      returnProperties,
      example,
    };
  });

  return hookInfo;
}

// ---------------------------------------------------------------------------
// Parse provider component
// ---------------------------------------------------------------------------

function parseProvider(filePath: string): ProviderInfo | null {
  const source = fs.readFileSync(filePath, 'utf-8');
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TSX,
  );

  let providerInfo: ProviderInfo | null = null;

  ts.forEachChild(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node)) return;
    if (!node.name || node.name.text !== 'GguiWireProvider') return;

    const description = getJSDocDescription(node) || 'React context provider that injects WireConfig for all wire hooks.';

    providerInfo = {
      name: 'GguiWireProvider',
      description,
      propsInterface: 'GguiWireProviderProps',
      propsProperties: [],
    };
  });

  // Parse the props interface from the same file
  const interfaces = parseInterfaces(filePath);
  const propsIface = interfaces.find(i => i.name === 'GguiWireProviderProps');
  if (providerInfo && propsIface) {
    (providerInfo as ProviderInfo).propsProperties = propsIface.properties;
  }

  return providerInfo;
}

// ---------------------------------------------------------------------------
// Markdown escaping for table cells
// ---------------------------------------------------------------------------

function escapeTableCell(text: string): string {
  return text.replace(/\|/g, '\\|').replace(/\n/g, ' ');
}

function formatTypeForTable(type: string): string {
  return '`' + escapeTableCell(type) + '`';
}

// ---------------------------------------------------------------------------
// Examples — hardcoded because JSDoc @example tags are not always present
// ---------------------------------------------------------------------------

const HOOK_EXAMPLES: Record<string, string> = {
  useAction: `const submitForm = useAction<{name: string; email: string}>('formSubmit');

// In JSX:
<Button onClick={() => submitForm({ name, email })}>Submit</Button>`,

  useStream: `const progress = useStream<{ percent: number; message: string }>('progress');

// In JSX:
{progress.latest && (
  <Progress value={progress.latest.percent} />
)}
<Text>{progress.all.length} updates received</Text>`,

  // useWiredTool retired 2026-05-11 — no example shown because the
  // hook no longer exists. agentTools entries are agent-invoked
  // catalog declarations; the component fires a user gesture via
  // `useAction(name)` and the runtime forwards `nextStep` as the
  // agent's next-tool hint.

  useAuth: `const auth = useAuth();

// In JSX:
{auth.isAuthenticated
  ? <Text>Welcome, user {auth.userId}</Text>
  : <Text>Please sign in</Text>
}`,

  useApp: `const app = useApp();

// In JSX:
<Heading>{app.appName}</Heading>
{app.appDescription && <Text>{app.appDescription}</Text>}`,

  useRender: `const render = useRender();

// In JSX:
<Badge variant={render.isConnected ? 'success' : 'error'}>
  {render.isConnected ? 'Connected' : 'Disconnected'}
</Badge>`,
};

// ---------------------------------------------------------------------------
// Generate markdown for a single hook
// ---------------------------------------------------------------------------

function generateHookMarkdown(
  hook: HookInfo,
  returnInterface: InterfaceInfo | undefined,
): string {
  const lines: string[] = [];

  lines.push(`### ${hook.name}`);
  lines.push('');
  if (hook.description) {
    lines.push(hook.description);
    lines.push('');
  }

  // Signature
  const paramStr = hook.params.map(p => `${p.name}: ${p.type}`).join(', ');
  lines.push(`**Signature:** \`${hook.name}${hook.typeParams}(${paramStr}): ${hook.returnType}\``);
  lines.push('');

  // Parameters
  if (hook.params.length > 0) {
    lines.push('**Parameters:**');
    lines.push('');
    lines.push('| Param | Type | Description |');
    lines.push('|-------|------|-------------|');
    for (const p of hook.params) {
      lines.push(`| ${p.name} | ${formatTypeForTable(p.type)} | ${escapeTableCell(p.description || p.name)} |`);
    }
    lines.push('');
  }

  // Return type shape (if there's a matching interface)
  if (returnInterface && returnInterface.properties.length > 0) {
    lines.push(`**Returns:** \`${hook.returnType}\``);
    lines.push('');
    lines.push('| Property | Type | Description |');
    lines.push('|----------|------|-------------|');
    for (const prop of returnInterface.properties) {
      lines.push(`| ${prop.name} | ${formatTypeForTable(prop.type)} | ${escapeTableCell(prop.description || prop.name)} |`);
    }
    lines.push('');
  } else if (hook.returnType && hook.returnType !== 'void') {
    lines.push(`**Returns:** \`${hook.returnType}\``);
    lines.push('');
  }

  // Example
  const example = hook.example ?? HOOK_EXAMPLES[hook.name];
  if (example) {
    lines.push('**Example:**');
    lines.push('```tsx');
    lines.push(example.trim());
    lines.push('```');
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generate markdown for the provider
// ---------------------------------------------------------------------------

function generateProviderMarkdown(provider: ProviderInfo): string {
  const lines: string[] = [];

  lines.push(`### ${provider.name}`);
  lines.push('');
  lines.push(provider.description);
  lines.push('');

  if (provider.propsProperties.length > 0) {
    lines.push('**Props:**');
    lines.push('');
    lines.push('| Prop | Type | Description |');
    lines.push('|------|------|-------------|');
    for (const prop of provider.propsProperties) {
      lines.push(`| ${prop.name} | ${formatTypeForTable(prop.type)} | ${escapeTableCell(prop.description || prop.name)} |`);
    }
    lines.push('');
  }

  lines.push('**Example:**');
  lines.push('```tsx');
  lines.push(`<GguiWireProvider config={wireConfig}>
  <YourComponent />
</GguiWireProvider>`);
  lines.push('```');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Generate markdown for the WireConfig interface
// ---------------------------------------------------------------------------

function generateWireConfigMarkdown(iface: InterfaceInfo): string {
  const lines: string[] = [];

  lines.push(`### ${iface.name}`);
  lines.push('');
  if (iface.description) {
    lines.push(iface.description);
    lines.push('');
  }

  if (iface.properties.length > 0) {
    lines.push('| Property | Type | Description |');
    lines.push('|----------|------|-------------|');
    for (const prop of iface.properties) {
      lines.push(`| ${prop.name} | ${formatTypeForTable(prop.type)} | ${escapeTableCell(prop.description || prop.name)} |`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  // Parse all interfaces from hook files (for return type resolution)
  const allInterfaces = new Map<string, InterfaceInfo>();

  for (const { filePath } of hookFiles) {
    const ifaces = parseInterfaces(filePath);
    for (const iface of ifaces) {
      allInterfaces.set(iface.name, iface);
    }
  }

  // Parse context interfaces
  const contextInterfaces = parseInterfaces(contextFile);
  for (const iface of contextInterfaces) {
    allInterfaces.set(iface.name, iface);
  }

  // Parse hooks
  const hooks: HookInfo[] = [];
  for (const { filePath } of hookFiles) {
    const hook = parseHook(filePath);
    if (hook) {
      hooks.push(hook);
    }
  }

  // Parse provider
  const provider = parseProvider(providerFile);

  // ── Build markdown ──────────────────────────────────────
  const sections: string[] = [];

  sections.push(`# ggui Wire Hooks Reference

> Wire hooks connect generated UI components to agent communication.
> They are pre-imported in the boilerplate — use them directly.
> All hooks must be called inside a GguiWireProvider (handled automatically by the renderer).

Import: \`import { useAction, useStream } from '@ggui-ai/wire'\``);

  // ── Communication hooks (the 2 core primitives) ──
  sections.push('## Communication Hooks');
  sections.push('');
  sections.push('These are the wire primitives for component-agent communication. `useWiredTool` retired 2026-05-11 — agentTools is a catalog the AGENT invokes, not a component hook surface; user gestures use `useAction(name)` and the optional `nextStep` field on the action entry names the tool the agent SHOULD invoke next.');

  const commHookNames = ['useAction', 'useStream'];
  for (const hookName of commHookNames) {
    const hook = hooks.find(h => h.name === hookName);
    if (!hook) continue;

    // Find matching return interface
    let returnIface: InterfaceInfo | undefined;
    if (hook.returnType.startsWith('StreamResult')) {
      returnIface = allInterfaces.get('StreamResult');
    } else if (hook.returnType.startsWith('WiredToolResult')) {
      returnIface = allInterfaces.get('WiredToolResult');
    } else if (hook.returnType === 'AuthInfo') {
      returnIface = allInterfaces.get('AuthInfo');
    } else if (hook.returnType === 'AppInfo') {
      returnIface = allInterfaces.get('AppInfo');
    } else if (hook.returnType === 'RenderInfo') {
      returnIface = allInterfaces.get('RenderInfo');
    }

    sections.push(generateHookMarkdown(hook, returnIface));
  }

  // ── Context hooks ──
  sections.push('## Context Hooks');
  sections.push('');
  sections.push('Read-only access to render, app, and auth context.');

  const contextHookNames = ['useAuth', 'useApp', 'useRender'];
  for (const hookName of contextHookNames) {
    const hook = hooks.find(h => h.name === hookName);
    if (!hook) continue;

    let returnIface: InterfaceInfo | undefined;
    if (hook.returnType === 'AuthInfo') {
      returnIface = allInterfaces.get('AuthInfo');
    } else if (hook.returnType === 'AppInfo') {
      returnIface = allInterfaces.get('AppInfo');
    } else if (hook.returnType === 'RenderInfo') {
      returnIface = allInterfaces.get('RenderInfo');
    }

    sections.push(generateHookMarkdown(hook, returnIface));
  }

  // ── Provider ──
  sections.push('## Provider');
  sections.push('');
  sections.push('The provider is set up automatically by the renderer. Generated components do not need to wrap themselves in a provider.');

  if (provider) {
    sections.push(generateProviderMarkdown(provider));
  }

  // ── WireConfig ──
  const wireConfig = allInterfaces.get('WireConfig');
  if (wireConfig) {
    sections.push('## Internal: WireConfig');
    sections.push('');
    sections.push('This is the configuration object passed to GguiWireProvider. Generated components do not interact with this directly — it is provided by the renderer.');
    sections.push(generateWireConfigMarkdown(wireConfig));
  }

  const markdown = sections.join('\n\n');

  // Build output TypeScript file
  const output = `/**
 * AUTO-GENERATED from @ggui-ai/wire JSDoc.
 * Do not edit manually. Run: pnpm --filter @ggui-ai/wire generate:docs
 */
export const WIRE_DOCUMENTATION = ${JSON.stringify(markdown)};
`;

  const outputPath = path.join(uiGenRoot, "src/tools/get-wire.ts");
  // eslint-disable-next-line no-console
  if (!fs.existsSync(path.dirname(outputPath))) { console.log("Skipping write: ui-gen/src/tools/ not found (standalone mode)"); return; }
  fs.writeFileSync(outputPath, output, 'utf-8');

  /* eslint-disable no-console */
  console.log(`Generated ${outputPath}`);
  console.log(`  Hooks: ${hooks.map(h => h.name).join(', ')}`);
  console.log(`  Provider: ${provider?.name ?? 'none'}`);
  console.log(`  Interfaces: ${Array.from(allInterfaces.keys()).join(', ')}`);
  /* eslint-enable no-console */
}

main();
