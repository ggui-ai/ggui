/**
 * Test Renderer Utilities
 *
 * Provides utilities for validating generated components and resolving bindings
 * in Node.js without requiring React rendering.
 */

import type { DataBindings, EndUserIdentity, JsonObject } from '@ggui-ai/protocol';
import { resolveBindings as resolveBindingsInternal } from '../tools/resolver';
import type { ToolContext } from '../tools/types';

/**
 * Result from resolving bindings in tests
 */
export interface TestResolveResult {
  /** Resolved data keyed by binding name */
  data: Record<string, unknown>;
  /** Errors keyed by binding name */
  errors: Record<string, Error | null>;
  /** Whether all bindings resolved successfully */
  success: boolean;
}

/**
 * Resolve bindings in Node.js (no React required)
 *
 * This is a test utility that resolves data bindings synchronously
 * without React hooks.
 *
 * @example
 * ```ts
 * const bindings = {
 *   user: { tool: 'auth', config: { field: 'currentUser' } },
 *   profile: {
 *     tool: 'fetch',
 *     config: { endpoint: '/api/users/{user.id}/profile' },
 *     dependsOn: ['user']
 *   }
 * };
 *
 * const result = await resolveBindingsForTest(bindings);
 * expect(result.data.user).toEqual({ id: 123, name: 'Alice' });
 * expect(result.data.profile).toEqual({ bio: 'Hello' });
 * ```
 */
export async function resolveBindingsForTest(
  bindings: DataBindings,
  context: Partial<ToolContext> = {}
): Promise<TestResolveResult> {
  const fullContext: ToolContext = {
    resolved: {},
    appId: context.appId ?? 'test-app',
    sessionId: context.sessionId ?? 'test-session',
    auth: context.auth ?? { isAuthenticated: false },
    ...context,
  };

  const result = await resolveBindingsInternal(bindings, fullContext);

  // Determine if all resolved successfully
  const success = Object.values(result.errors).every((e) => e === null);

  return {
    data: result.data,
    errors: result.errors,
    success,
  };
}

/**
 * Validation result for component code
 */
export interface ValidationResult {
  /** Whether the code is valid */
  valid: boolean;
  /** Validation checks that passed/failed */
  checks: Record<string, boolean>;
  /** Error messages for failed checks */
  errors: string[];
}

/**
 * Validate generated component code structure
 *
 * Checks that the generated code has the expected structure without
 * actually executing it.
 *
 * @example
 * ```ts
 * const result = validateComponentCode(compiledCode);
 * expect(result.valid).toBe(true);
 * expect(result.checks.hasDefaultExport).toBe(true);
 * ```
 */
export function validateComponentCode(code: string): ValidationResult {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  // Check for default export (handles minified patterns like `export{l as default}`)
  checks.hasDefaultExport =
    /export\s+default/.test(code) ||
    /exports\s*\.\s*default/.test(code) ||
    /export\s*\{[^}]*\s+as\s+default\s*[,}]/.test(code);
  if (!checks.hasDefaultExport) {
    errors.push('Component code must have a default export');
  }

  // Check for React usage (import or jsx runtime)
  checks.hasReactUsage =
    /import.*react/i.test(code) ||
    /require\s*\(\s*["']react["']\s*\)/.test(code) ||
    /jsx-runtime/.test(code) ||
    /jsxs?\(/.test(code);
  if (!checks.hasReactUsage) {
    errors.push('Component code should use React');
  }

  // Check for function component pattern
  checks.hasFunctionComponent =
    /function\s+\w+\s*\(/.test(code) || /\w+\s*=\s*(?:function|\([^)]*\)\s*=>)/.test(code);

  // Check it's minified (production-ready)
  checks.isMinified = code.split('\n').length < 20;

  // Check for common security issues
  checks.noEval = !/\beval\s*\(/.test(code);
  checks.noInnerHTML = !/dangerouslySetInnerHTML/.test(code) || /sanitize/i.test(code);

  if (!checks.noEval) {
    errors.push('Component code should not use eval()');
  }

  return {
    valid: errors.length === 0,
    checks,
    errors,
  };
}

/**
 * Validate generated controller code structure
 *
 * Checks that the controller has the expected patterns for data binding.
 *
 * @example
 * ```ts
 * const result = validateControllerCode(controllerCode);
 * expect(result.checks.hasUseTool).toBe(true);
 * expect(result.checks.hasLoadingState).toBe(true);
 * ```
 */
export function validateControllerCode(code: string): ValidationResult {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  // Check for default export (handles minified patterns like `export{l as default}`)
  checks.hasDefaultExport =
    /export\s+default/.test(code) ||
    /exports\s*\.\s*default/.test(code) ||
    /export\s*\{[^}]*\s+as\s+default\s*[,}]/.test(code);
  if (!checks.hasDefaultExport) {
    errors.push('Controller code must have a default export');
  }

  // Check for useTool hook usage
  checks.hasUseTool = /useTool/.test(code);

  // Check for cloneElement (injecting props)
  checks.hasCloneElement = /cloneElement/.test(code);

  // Check for loading state handling
  checks.hasLoadingState = /loading|isLoading/i.test(code);

  // Check for error state handling
  checks.hasErrorState = /error/i.test(code);

  // Check for children prop
  checks.hasChildrenProp = /children/.test(code);

  return {
    valid: errors.length === 0,
    checks,
    errors,
  };
}

/**
 * Options for creating a test context
 */
export interface TestContextOptions {
  appId?: string;
  sessionId?: string;
  auth?: {
    currentUser?: EndUserIdentity;
    userId?: string;
    token?: string;
    isAuthenticated: boolean;
  };
  apiBaseUrl?: string;
  resolved?: JsonObject;
}

/**
 * Create a test context for tool execution
 */
export function createTestContext(options: TestContextOptions = {}): ToolContext {
  return {
    resolved: options.resolved ?? {},
    appId: options.appId ?? 'test-app',
    sessionId: options.sessionId ?? 'test-session',
    auth: options.auth ?? { isAuthenticated: false },
    apiBaseUrl: options.apiBaseUrl,
  };
}

/**
 * Parse and validate ESM module code
 *
 * Checks that the code can be parsed as valid JavaScript/ESM.
 * Does not execute the code.
 */
export function validateEsmSyntax(code: string): { valid: boolean; error?: string } {
  try {
    // Use Function constructor to parse without executing
    // This validates JavaScript syntax
    new Function(code);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Extract imports from ESM code
 *
 * Returns a list of imported module specifiers.
 */
export function extractImports(code: string): string[] {
  const imports: string[] = [];

  // Match static imports: import ... from 'module'
  const staticImportRegex = /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = staticImportRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  // Match dynamic imports: import('module')
  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  return [...new Set(imports)];
}

/**
 * Check if code imports from a specific module
 */
export function hasImport(code: string, moduleName: string): boolean {
  return extractImports(code).some(
    (imp) => imp === moduleName || imp.startsWith(`${moduleName}/`)
  );
}
