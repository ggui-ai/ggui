// packages/ui-gen/src/coding-agent/boilerplate.ts
//
// Deterministic boilerplate generator. OUR code, not LLM output.
// Reads types.d.ts + file list from planner and generates scaffolds.
//
// Key principles:
//   1. Pre-import EVERYTHING — imports are free (tree-shaken at bundle time)
//   2. Absolute paths — all local imports use /virtual/ prefix, no ambiguity
//   3. Path comment — every file starts with // Path: /virtual/<filename>

import type { PlannerOutput, FileTask } from './planner';
import type { CommitInput } from './types';

// =============================================================================
// Constants
// =============================================================================

/** Virtual root for absolute imports between generated files */
export const VIRTUAL_ROOT = '/virtual';

/** All primitives from @ggui-ai/design */
// D1: the whole design system imports through one specifier
// (`@ggui-ai/design`) — primitives and components in one list.
const ALL_DESIGN = [
  'Container', 'Card', 'Stack', 'Row', 'Grid', 'Box', 'Divider', 'Spacer',
  'Text', 'Heading',
  'Button', 'Input', 'TextArea', 'Select', 'Checkbox', 'Toggle', 'RadioGroup', 'Slider',
  'Badge', 'Spinner', 'Skeleton', 'Avatar', 'Alert', 'Progress',
  'Image', 'Icon',
  'Link', 'Tooltip',
  'Table',
  'Tabs', 'Toast', 'Accordion',
  'SearchField', 'FormField', 'MenuItem', 'Tag',
  'Dropdown', 'Autocomplete', 'Breadcrumb', 'Pagination', 'EmptyState', 'Stat',
].join(', ');

/** React hooks */
const ALL_HOOKS = 'useState, useEffect, useMemo, useCallback, useRef';

// =============================================================================
// Main Generator
// =============================================================================

export function generateBoilerplates(
  plannerOutput: PlannerOutput,
  commitInput?: CommitInput,
): Map<string, string> {
  const result = new Map<string, string>();
  const types = parseTypesFile(plannerOutput.typesFile);
  const fileList = plannerOutput.files;
  const subComponents = fileList.filter((f) => f.role === 'sub-component');

  for (const task of fileList) {
    const boilerplate = generateFileBoilerplate(task, types, fileList, subComponents, commitInput);
    result.set(task.filename, boilerplate);
  }

  return result;
}

// =============================================================================
// Per-File Generators
// =============================================================================

function generateFileBoilerplate(
  task: FileTask,
  types: ParsedTypes,
  allFiles: FileTask[],
  subComponents: FileTask[],
  commitInput?: CommitInput,
): string {
  switch (task.role) {
    case 'constants':
      return generateConstants(task);
    case 'hooks':
      return generateHooks(task, types, allFiles, commitInput);
    case 'sub-component':
      return generateSubComponent(task, types);
    case 'main-component':
      return generateComponentIndex(task, types, subComponents);
    default:
      return `// Path: ${VIRTUAL_ROOT}/${task.filename}\n// TODO: implement\n`;
  }
}

function generateConstants(task: FileTask): string {
  return [
    `// Path: ${VIRTUAL_ROOT}/${task.filename}`,
    '// constants.ts — static data, mappings, configurations',
    '// No React, no design system imports. Pure data only.',
    '',
    '// TODO: implement constants',
    '',
  ].join('\n');
}

function generateHooks(
  task: FileTask,
  types: ParsedTypes,
  allFiles: FileTask[],
  commitInput?: CommitInput,
): string {
  const lines: string[] = [
    `// Path: ${VIRTUAL_ROOT}/${task.filename}`,
    '// hooks.ts — state, handlers, data transformations',
    `import { ${ALL_HOOKS} } from 'react';`,
    `import type { Props, HookReturn } from '${VIRTUAL_ROOT}/types';`,
  ];

  const hasConstants = allFiles.some((f) => f.role === 'constants');
  if (hasConstants) {
    lines.push(`import * as constants from '${VIRTUAL_ROOT}/constants';`);
  }

  lines.push('');

  if (commitInput?.actionSpec && Object.keys(commitInput.actionSpec).length > 0) {
    lines.push('// ── Action Handlers (from actionSpec) ──────────────────');
    for (const [key, value] of Object.entries(commitInput.actionSpec)) {
      const desc = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`//   props.${key}: ${desc}`);
    }
    lines.push('');
  }

  if (commitInput?.streamSpec && Object.keys(commitInput.streamSpec).length > 0) {
    lines.push('// ── Stream Data (from streamSpec) ───────────────────────');
    for (const [key, value] of Object.entries(commitInput.streamSpec)) {
      const desc = typeof value === 'string' ? value : JSON.stringify(value);
      lines.push(`//   props.${key}: ${desc}`);
    }
    lines.push('');
  }

  lines.push(`export function useComponent(props: Props): HookReturn {`);

  if (types.propNames.length > 0) {
    lines.push(`  const { ${types.propNames.join(', ')} } = props;`);
  }

  lines.push('');
  lines.push('  // TODO: implement hook logic');
  lines.push('');

  if (types.hookReturnNames.length > 0) {
    lines.push('  return {');
    for (const name of types.hookReturnNames) {
      lines.push(`    ${name}: undefined!, // TODO: implement`);
    }
    lines.push('  };');
  } else {
    lines.push('  return {};');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

function generateSubComponent(task: FileTask, types: ParsedTypes): string {
  // Extract leaf name: 'components/ForecastStrip.tsx' → 'ForecastStrip'
  const name = task.filename.replace(/\.tsx?$/, '').split('/').pop()!;
  const propsName = types.componentProps[name] ?? `${name}Props`;

  return [
    `// Path: ${VIRTUAL_ROOT}/${task.filename}`,
    `// ${task.filename} — reusable sub-component`,
    `import React from 'react';`,
    `import { ${ALL_DESIGN} } from '@ggui-ai/design';`,
    `import type { ${propsName} } from '${VIRTUAL_ROOT}/types';`,
    '',
    `export function ${name}(props: ${propsName}) {`,
    `  return (<></>); // TODO: implement ${name}`,
    '}',
    '',
  ].join('\n');
}

function generateComponentIndex(
  task: FileTask,
  types: ParsedTypes,
  subComponents: FileTask[],
): string {
  const lines: string[] = [
    `// Path: ${VIRTUAL_ROOT}/${task.filename}`,
    '// components/index.tsx — main component composing sub-components',
    `import React from 'react';`,
    `import { ${ALL_DESIGN} } from '@ggui-ai/design';`,
    `import type { Props, HookReturn } from '${VIRTUAL_ROOT}/types';`,
  ];

  // Pre-import sub-components with absolute paths
  for (const sc of subComponents) {
    // Extract just the component name (e.g., 'components/CurrentWeather.tsx' → 'CurrentWeather')
    const name = sc.filename.replace(/\.tsx?$/, '').split('/').pop()!;
    lines.push(`import { ${name} } from '${VIRTUAL_ROOT}/${sc.filename}';`);
  }

  lines.push('');
  lines.push('export function MainView(props: Props & HookReturn) {');

  const allFields = [...new Set([...types.propNames, ...types.hookReturnNames])];
  if (allFields.length > 0) {
    lines.push(`  const { ${allFields.join(', ')} } = props;`);
  }

  lines.push('');
  lines.push('  return (');
  lines.push(`    <Container>`);
  lines.push(`      {/* TODO: implement main component layout */}`);
  lines.push('    </Container>');
  lines.push('  );');
  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// =============================================================================
// entrypoint.tsx Generator (deterministic, 0 tokens)
// =============================================================================

export function generateEntrypoint(
  types: ParsedTypes,
  allFiles: FileTask[],
): string {
  const hasHooks = allFiles.some((f) => f.role === 'hooks');
  // Find the ui file (components/index.tsx)
  // Always import from components/index.tsx — the main component
  const uiPath = `${VIRTUAL_ROOT}/components/index`;

  const lines: string[] = [
    `// Path: ${VIRTUAL_ROOT}/entrypoint.tsx`,
    '// entrypoint.tsx — wires hooks + component, export default',
    `import React from 'react';`,
    `import type { Props } from '${VIRTUAL_ROOT}/types';`,
  ];

  if (hasHooks) {
    lines.push(`import { useComponent } from '${VIRTUAL_ROOT}/hooks';`);
  }
  lines.push(`import { MainView } from '${uiPath}';`);

  lines.push('');
  lines.push('export default function Entrypoint(props: Props) {');

  if (hasHooks) {
    lines.push('  const state = useComponent(props);');
    lines.push('  return <MainView {...props} {...state} />;');
  } else {
    lines.push('  return <MainView {...props} />;');
  }

  lines.push('}');
  lines.push('');
  return lines.join('\n');
}

// =============================================================================
// types.d.ts Parser
// =============================================================================

export interface ParsedTypes {
  propNames: string[];
  hookReturnNames: string[];
  hasConstantsType: boolean;
  componentProps: Record<string, string>;
}

export function parseTypesFile(typesFile: string): ParsedTypes {
  return {
    propNames: extractInterfaceFields(typesFile, 'Props'),
    hookReturnNames: extractInterfaceFields(typesFile, 'HookReturn'),
    hasConstantsType:
      typesFile.includes('interface Constants') ||
      typesFile.includes('type Constants'),
    componentProps: extractComponentProps(typesFile),
  };
}

function extractInterfaceFields(source: string, interfaceName: string): string[] {
  const regex = new RegExp(`interface\\s+${interfaceName}\\s*\\{([^}]*)\\}`, 's');
  const match = source.match(regex);
  if (!match) return [];

  const fields: string[] = [];
  for (const line of match[1].split('\n')) {
    const fieldMatch = line.match(/^\s*(\w+)\s*[?:]/);
    if (fieldMatch) fields.push(fieldMatch[1]);
  }
  return fields;
}

function extractComponentProps(source: string): Record<string, string> {
  const result: Record<string, string> = {};
  const regex = /interface\s+(\w+Props)\s*\{/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const propsName = match[1];
    result[propsName.replace(/Props$/, '')] = propsName;
  }
  return result;
}
