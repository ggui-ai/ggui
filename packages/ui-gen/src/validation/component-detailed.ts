import { VALID_PRIMITIVES } from './primitives.js';
import { isAllowedImport, describeAllowedImports } from './allowed-imports.js';
import { DANGEROUS_PATTERNS as SHARED_DANGEROUS_PATTERNS } from '@ggui-ai/protocol';

/**
 * Validation error types for classification
 */
export type ValidationErrorType = 'import' | 'primitive' | 'security' | 'syntax' | 'size' | 'structure';

/**
 * Validation warning types
 */
export type ValidationWarningType = 'accessibility' | 'best-practice' | 'performance';

/**
 * Detailed validation error with actionable suggestions
 */
export interface ValidationError {
  type: ValidationErrorType;
  message: string;
  line?: number;
  column?: number;
  suggestion: string;
  code?: string;
}

/**
 * Validation warning (non-blocking)
 */
export interface ValidationWarning {
  type: ValidationWarningType;
  message: string;
  line?: number;
  suggestion: string;
}

/**
 * Comprehensive validation result
 */
export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
  warnings: ValidationWarning[];
  suggestions: string[];
  stats: {
    lineCount: number;
    charCount: number;
    importCount: number;
    primitiveCount: number;
  };
}

// Size limits
const MAX_FILE_SIZE = 50 * 1024; // 50KB
const MAX_LINE_COUNT = 500;

// Security patterns — single source of truth in @ggui-ai/protocol.
// Re-exported here so existing consumers don't break.
const DANGEROUS_PATTERNS = SHARED_DANGEROUS_PATTERNS;

/**
 * Extract line number from code for a match
 */
function getLineNumber(code: string, match: RegExpExecArray): number {
  const upToMatch = code.substring(0, match.index);
  return upToMatch.split('\n').length;
}

/**
 * Extract imports from code
 */
function extractImports(code: string): Array<{ source: string; line: number }> {
  const imports: Array<{ source: string; line: number }> = [];
  const importRegex = /import\s+(?:[\w\s{},*]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;

  while ((match = importRegex.exec(code)) !== null) {
    imports.push({
      source: match[1],
      line: getLineNumber(code, match),
    });
  }

  return imports;
}

/**
 * Extract primitives used in code
 */
function extractPrimitivesUsed(code: string): string[] {
  // Look for JSX tags that start with capital letters (React components)
  const jsxTagRegex = /<([A-Z][a-zA-Z0-9]*)/g;
  const used = new Set<string>();
  let match;

  while ((match = jsxTagRegex.exec(code)) !== null) {
    used.add(match[1]);
  }

  return Array.from(used);
}

export interface ValidationOptions {
  /**
   * Skip import allowlist validation.
   * Used when bundle mode is enabled — external imports will be resolved
   * by esbuild at build time, not by the runtime.
   * Security patterns (eval, fetch, etc.) are still enforced.
   */
  skipImportValidation?: boolean;
  /**
   * Skip size limits (line count, file size).
   * Used for user-registered UIs where the developer controls the size.
   * LLM-generated UIs keep the limits to constrain generation.
   */
  skipSizeLimits?: boolean;
  /**
   * Skip dangerous-pattern security scan (eval, fetch, location, etc.).
   * Used for user-registered UIs where the developer controls the code.
   * LLM-generated UIs always get the security scan.
   */
  skipSecurityPatterns?: boolean;
}

/**
 * Validate component code with rich feedback.
 * Returns detailed errors, warnings, and suggestions.
 */
export function validateComponentDetailed(code: string, options: ValidationOptions = {}): ValidationResult {
  const errors: ValidationError[] = [];
  const warnings: ValidationWarning[] = [];
  const suggestions: string[] = [];
  const lines = code.split('\n');
  const lineCount = lines.length;
  const charCount = code.length;

  // Size validation — skipped for user-registered UIs (developer controls size)
  if (!options.skipSizeLimits) {
    if (charCount > MAX_FILE_SIZE) {
      errors.push({
        type: 'size',
        message: `Component is too large: ${(charCount / 1024).toFixed(1)}KB exceeds ${MAX_FILE_SIZE / 1024}KB limit`,
        suggestion: 'Split the component into smaller sub-components or simplify the implementation.',
      });
    }

    if (lineCount > MAX_LINE_COUNT) {
      errors.push({
        type: 'size',
        message: `Component has too many lines: ${lineCount} exceeds ${MAX_LINE_COUNT} line limit`,
        suggestion: 'Split the component into smaller sub-components.',
      });
    }
  }

  // Import validation
  // Skipped in bundle mode — external imports are resolved by esbuild at build time.
  // The ALLOWED_IMPORTS list is for LLM-generated UIs (case 2) where only sandbox-provided
  // packages are available. Developer-registered UIs (case 1) with bundle mode can import anything.
  const imports = extractImports(code);
  if (!options.skipImportValidation) {
  for (const imp of imports) {
    const isAllowed = isAllowedImport(imp.source);
    // `@app/components` is the registered-component mechanism specific
    // to this validator — kept local, not part of the shared
    // design-system import allowlist.
    const isAppComponents =
      imp.source === '@app/components' ||
      imp.source.startsWith('@app/components/');
    if (!isAllowed && !isAppComponents) {
      errors.push({
        type: 'import',
        message: `Invalid import: "${imp.source}" is not allowed`,
        line: imp.line,
        suggestion: `Only import from: ${describeAllowedImports()}. Remove this import and use ggui primitives instead.`,
      });
    }
  }

  // Check for missing required imports
  if (!imports.some((i) => i.source === 'react')) {
    // Check if useState or other hooks are used
    if (/\buseState\b|\buseEffect\b|\buseMemo\b|\buseCallback\b|\buseRef\b/.test(code)) {
      warnings.push({
        type: 'best-practice',
        message: 'React hooks are used but react is not explicitly imported',
        suggestion: "Add: import { useState } from 'react';",
      });
    }
  }

  if (!imports.some((i) => i.source === '@ggui-ai/design')) {
    warnings.push({
      type: 'best-practice',
      message: 'No primitives imported from @ggui-ai/design',
      suggestion:
        "Import primitives: import { Container, Card, Stack, Text, Button } from '@ggui-ai/design';",
    });
  }
  } // end skipImportValidation check

  // Primitive validation
  const primitivesUsed = extractPrimitivesUsed(code);

  // Check if any imports come from @app/components
  const hasAppComponentImport = imports.some((i) => i.source.startsWith('@app/components'));

  // Extract component names imported from @app/components
  const importedComponentNames = new Set<string>();

  if (hasAppComponentImport) {
    // Match named imports: import { Foo, Bar } from '@app/components'
    const namedImportRegex = /import\s*\{([^}]+)\}\s*from\s*['"]@app\/components['"]/g;
    let match;
    while ((match = namedImportRegex.exec(code)) !== null) {
      const names = match[1].split(',').map((n) => n.trim().split(' as ')[0].trim());
      for (const name of names) {
        if (name) importedComponentNames.add(name);
      }
    }
    // Match default imports: import Foo from '@app/components/Foo'
    const defaultImportRegex = /import\s+(\w+)\s+from\s*['"]@app\/components\/[^'"]+['"]/g;
    while ((match = defaultImportRegex.exec(code)) !== null) {
      importedComponentNames.add(match[1]);
    }
  }

  for (const primitive of primitivesUsed) {
    if (!VALID_PRIMITIVES.includes(primitive as (typeof VALID_PRIMITIVES)[number])) {
      // Check if it's imported from @app/components
      if (importedComponentNames.has(primitive)) {
        continue; // Valid imported component
      }

      // Check if it's a user-defined component (starts with capital and not a primitive)
      const isImported = code.includes(`import`) && code.includes(primitive);
      if (!isImported) {
        errors.push({
          type: 'primitive',
          message: `Unknown component: "${primitive}" is not a valid ggui primitive`,
          suggestion: `Use one of the valid primitives: ${VALID_PRIMITIVES.slice(0, 10).join(', ')}... or import from @app/components, or define it within this component.`,
        });
      }
    }
  }

  // Security validation — skipped for user-registered UIs (developer controls code)
  if (!options.skipSecurityPatterns) {
    for (const { pattern, name, suggestion } of DANGEROUS_PATTERNS) {
      const match = pattern.exec(code);
      if (match) {
        errors.push({
          type: 'security',
          message: `Security violation: ${name} is not allowed`,
          line: getLineNumber(code, match),
          suggestion,
          code: match[0],
        });
      }
    }
  }

  // Structure validation
  if (!code.includes('export default')) {
    errors.push({
      type: 'structure',
      message: 'Component must have a default export',
      suggestion: 'Add "export default" before your main component function.',
    });
  }

  // Check for class components
  if (/class\s+\w+\s+extends\s+(React\.)?Component/.test(code)) {
    errors.push({
      type: 'structure',
      message: 'Class components are not allowed',
      suggestion: 'Convert to a functional component using hooks.',
    });
  }

  // Best practice warnings
  if (!code.includes('interface') && !code.includes('type ') && code.includes('Props')) {
    warnings.push({
      type: 'best-practice',
      message: 'Props are used but no TypeScript interface is defined',
      suggestion: 'Define a Props interface: interface Props { onSubmit: (data: FormData) => void; }',
    });
  }

  // Check for e.target.value pattern (common mistake)
  if (/e\.target\.value|event\.target\.value/.test(code)) {
    errors.push({
      type: 'syntax',
      message:
        'Using e.target.value with ggui primitives will fail - onChange receives value directly',
      suggestion:
        'Change from onChange={(e) => setValue(e.target.value)} to onChange={setValue} or onChange={(value) => setValue(value)}',
    });
  }

  // Check for missing key prop in map
  if (code.includes('.map(') && !code.includes('key=')) {
    warnings.push({
      type: 'best-practice',
      message: 'List rendering detected but no key prop found',
      suggestion: 'Add key prop to mapped elements: {items.map(item => <Card key={item.id}>...)}',
    });
  }

  // Accessibility warnings
  if (code.includes('<Image') && !code.includes('alt=')) {
    warnings.push({
      type: 'accessibility',
      message: 'Image without alt attribute',
      suggestion: 'Add alt attribute to Image: <Image src={...} alt="Description" />',
    });
  }

  // Check form inputs have labels
  const hasInputs = /<Input\b/.test(code) || /<TextArea\b/.test(code) || /<Select\b/.test(code);
  if (hasInputs) {
    const hasLabels = /label=/.test(code) || /htmlFor=/.test(code) || /aria-label=/.test(code) || /aria-labelledby=/.test(code);
    if (!hasLabels) {
      warnings.push({
        type: 'accessibility',
        message: 'Form inputs detected without labels',
        suggestion: 'Add label prop to inputs or associate with <Text is="label" htmlFor="id">. Screen readers need labels to identify form fields.',
      });
    }
  }

  // Check forms have role and aria-label
  if ((code.includes('onSubmit') || code.includes('role="form"')) && !code.includes('aria-label')) {
    warnings.push({
      type: 'accessibility',
      message: 'Form without aria-label',
      suggestion: 'Add aria-label to your form container: <Stack role="form" aria-label="Contact form">',
    });
  }

  // Check for icon-only buttons without aria-label
  // Match buttons with single-character content (likely icons) and no aria-label
  const iconButtonPattern = /<Button(?![^>]*aria-label)[^>]*>\s*.\s*<\/Button>/;
  if (iconButtonPattern.test(code)) {
    warnings.push({
      type: 'accessibility',
      message: 'Icon-only button detected without text content',
      suggestion: 'Add aria-label to icon-only buttons: <Button aria-label="Close">×</Button>',
    });
  }

  if (code.includes('<Button') && !/disabled=|loading=/.test(code)) {
    if (code.includes('onSubmit') || code.includes('submit')) {
      warnings.push({
        type: 'best-practice',
        message: 'Submit button without disabled state',
        suggestion: 'Consider adding disabled={isSubmitting || !isValid} to prevent double submission',
      });
    }
  }

  // Generate suggestions based on analysis
  if (errors.length > 0) {
    suggestions.push('Fix all errors before compiling - the component will not work with errors.');
  }

  if (errors.some((e) => e.type === 'import')) {
    suggestions.push(
      'Only react and @ggui-ai/design imports are allowed. All UI should be built with primitives.'
    );
  }

  if (errors.some((e) => e.type === 'security')) {
    suggestions.push('Avoid browser APIs - use props and callbacks for data flow.');
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    suggestions,
    stats: {
      lineCount,
      charCount,
      importCount: imports.length,
      primitiveCount: primitivesUsed.filter((p) =>
        VALID_PRIMITIVES.includes(p as (typeof VALID_PRIMITIVES)[number])
      ).length,
    },
  };
}

/**
 * Simple validation that throws on error (backward compatible).
 * Use validateComponentDetailed for rich feedback.
 */
export function validateComponent(code: string): void {
  const result = validateComponentDetailed(code);

  if (!result.valid) {
    const firstError = result.errors[0];
    const lineInfo = firstError.line ? ` (line ${firstError.line})` : '';
    throw new Error(`Validation failed${lineInfo}: ${firstError.message}\n\nSuggestion: ${firstError.suggestion}`);
  }
}

/**
 * Format validation result as a string for Claude feedback.
 * Provides context-rich error messages for the AI to understand and fix issues.
 */
export function formatValidationResultForClaude(result: ValidationResult): string {
  if (result.valid && result.warnings.length === 0) {
    return 'Validation passed. Component is ready for compilation.';
  }

  const parts: string[] = [];

  if (!result.valid) {
    parts.push('## Validation Errors (must fix)\n');
    for (const error of result.errors) {
      const lineInfo = error.line ? ` (line ${error.line})` : '';
      parts.push(`- **${error.type.toUpperCase()}**${lineInfo}: ${error.message}`);
      parts.push(`  - Fix: ${error.suggestion}`);
      if (error.code) {
        parts.push(`  - Code: \`${error.code}\``);
      }
    }
  }

  if (result.warnings.length > 0) {
    parts.push('\n## Warnings (recommended to fix)\n');
    for (const warning of result.warnings) {
      const lineInfo = warning.line ? ` (line ${warning.line})` : '';
      parts.push(`- **${warning.type}**${lineInfo}: ${warning.message}`);
      parts.push(`  - Suggestion: ${warning.suggestion}`);
    }
  }

  if (result.suggestions.length > 0) {
    parts.push('\n## General Suggestions\n');
    for (const suggestion of result.suggestions) {
      parts.push(`- ${suggestion}`);
    }
  }

  parts.push(
    `\n## Stats: ${result.stats.lineCount} lines, ${result.stats.primitiveCount} primitives used`
  );

  return parts.join('\n');
}
