/**
 * Test Renderer Utilities (React Native SDK)
 *
 * Ported from @ggui-ai/react testing utilities.
 * Provides utilities for validating generated components and resolving bindings
 * in Node.js without requiring React rendering.
 */

import type { DataBindings, EndUserIdentity, JsonObject } from '@ggui-ai/protocol';
import { resolveBindings as resolveBindingsInternal } from '../tools/resolver';
import type { ToolContext } from '../tools/types';

export interface TestResolveResult {
  data: Record<string, unknown>;
  errors: Record<string, Error | null>;
  success: boolean;
}

export async function resolveBindingsForTest(
  bindings: DataBindings,
  context: Partial<ToolContext> = {},
): Promise<TestResolveResult> {
  const fullContext: ToolContext = {
    resolved: {},
    appId: context.appId ?? 'test-app',
    sessionId: context.sessionId ?? 'test-render',
    auth: context.auth ?? { isAuthenticated: false },
    ...context,
  };

  const result = await resolveBindingsInternal(bindings, fullContext);
  const success = Object.values(result.errors).every((e) => e === null);

  return {
    data: result.data,
    errors: result.errors,
    success,
  };
}

export interface ValidationResult {
  valid: boolean;
  checks: Record<string, boolean>;
  errors: string[];
}

export function validateComponentCode(code: string): ValidationResult {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  checks.hasDefaultExport =
    /export\s+default/.test(code) ||
    /exports\s*\.\s*default/.test(code) ||
    /export\s*\{[^}]*\s+as\s+default\s*[,}]/.test(code);
  if (!checks.hasDefaultExport) {
    errors.push('Component code must have a default export');
  }

  checks.hasReactUsage =
    /import.*react/i.test(code) ||
    /require\s*\(\s*["']react["']\s*\)/.test(code) ||
    /jsx-runtime/.test(code) ||
    /jsxs?\(/.test(code);
  if (!checks.hasReactUsage) {
    errors.push('Component code should use React');
  }

  checks.hasFunctionComponent =
    /function\s+\w+\s*\(/.test(code) || /\w+\s*=\s*(?:function|\([^)]*\)\s*=>)/.test(code);

  checks.isMinified = code.split('\n').length < 20;

  checks.noEval = !/\beval\s*\(/.test(code);
  checks.noInnerHTML = !/dangerouslySetInnerHTML/.test(code) || /sanitize/i.test(code);

  if (!checks.noEval) {
    errors.push('Component code should not use eval()');
  }

  return { valid: errors.length === 0, checks, errors };
}

export function validateControllerCode(code: string): ValidationResult {
  const errors: string[] = [];
  const checks: Record<string, boolean> = {};

  checks.hasDefaultExport =
    /export\s+default/.test(code) ||
    /exports\s*\.\s*default/.test(code) ||
    /export\s*\{[^}]*\s+as\s+default\s*[,}]/.test(code);
  if (!checks.hasDefaultExport) {
    errors.push('Controller code must have a default export');
  }

  checks.hasUseTool = /useTool/.test(code);
  checks.hasCloneElement = /cloneElement/.test(code);
  checks.hasLoadingState = /loading|isLoading/i.test(code);
  checks.hasErrorState = /error/i.test(code);
  checks.hasChildrenProp = /children/.test(code);

  return { valid: errors.length === 0, checks, errors };
}

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

export function createTestContext(options: TestContextOptions = {}): ToolContext {
  return {
    resolved: options.resolved ?? {},
    appId: options.appId ?? 'test-app',
    sessionId: options.sessionId ?? 'test-render',
    auth: options.auth ?? { isAuthenticated: false },
    apiBaseUrl: options.apiBaseUrl,
  };
}

export function validateEsmSyntax(code: string): { valid: boolean; error?: string } {
  try {
    new Function(code);
    return { valid: true };
  } catch (err) {
    return {
      valid: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export function extractImports(code: string): string[] {
  const imports: string[] = [];

  const staticImportRegex = /import\s+(?:[^'"]+\s+from\s+)?['"]([^'"]+)['"]/g;
  let match;
  while ((match = staticImportRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  const dynamicImportRegex = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = dynamicImportRegex.exec(code)) !== null) {
    imports.push(match[1]);
  }

  return [...new Set(imports)];
}

export function hasImport(code: string, moduleName: string): boolean {
  return extractImports(code).some(
    (imp) => imp === moduleName || imp.startsWith(`${moduleName}/`),
  );
}
