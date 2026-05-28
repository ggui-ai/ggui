/**
 * Mock Tools Self-Test
 *
 * Verifies that the testing utilities work correctly.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  setupMockTools,
  resetMockTools,
  registerMockFetch,
} from '../mock-tools';
import {
  resolveBindingsForTest,
  validateComponentCode,
  validateControllerCode,
  createTestContext,
  validateEsmSyntax,
  extractImports,
  hasImport,
} from '../test-renderer';

describe('setupMockTools', () => {
  beforeEach(() => {
    resetMockTools();
  });

  it('sets up fetch mock and resolves bindings', async () => {
    setupMockTools({
      fetch: { '/api/users': [{ id: 1, name: 'Alice' }] },
    });

    const result = await resolveBindingsForTest({
      users: { tool: 'fetch', config: { endpoint: '/api/users' } },
    });

    expect(result.success).toBe(true);
    expect(result.data.users).toEqual([{ id: 1, name: 'Alice' }]);
  });

  it('sets up auth mock', async () => {
    setupMockTools({
      auth: { id: 'user-1', name: 'Test User', token: 'abc123' },
    });

    const result = await resolveBindingsForTest({
      user: { tool: 'auth', config: { field: 'currentUser' } },
      isAuthed: { tool: 'auth', config: { field: 'isAuthenticated' } },
    });

    expect(result.success).toBe(true);
    expect(result.data.user).toEqual({ id: 'user-1', name: 'Test User', token: 'abc123' });
    expect(result.data.isAuthed).toBe(true);
  });

  it('returns false for isAuthenticated when auth is null', async () => {
    setupMockTools({ auth: null });

    const result = await resolveBindingsForTest({
      isAuthed: { tool: 'auth', config: { field: 'isAuthenticated' } },
    });

    expect(result.data.isAuthed).toBe(false);
  });

  it('sets up storage mock', async () => {
    setupMockTools({
      storage: { theme: 'dark', lang: 'en' },
    });

    const result = await resolveBindingsForTest({
      theme: { tool: 'storage', config: { key: 'theme' } },
    });

    expect(result.success).toBe(true);
    expect(result.data.theme).toBe('dark');
  });

  it('fetch mock supports pattern matching', async () => {
    registerMockFetch({
      '/api/users/{id}': { id: 42, name: 'Bob' },
    });

    const result = await resolveBindingsForTest({
      user: { tool: 'fetch', config: { endpoint: '/api/users/42' } },
    });

    expect(result.success).toBe(true);
    expect(result.data.user).toEqual({ id: 42, name: 'Bob' });
  });

  it('fetch mock throws for unknown endpoints', async () => {
    registerMockFetch({});

    const result = await resolveBindingsForTest({
      data: { tool: 'fetch', config: { endpoint: '/api/unknown' } },
    });

    expect(result.success).toBe(false);
    expect(result.errors.data).toBeTruthy();
  });
});

describe('validateComponentCode', () => {
  it('validates a valid component', () => {
    const code = `import React from 'react';
function MyComponent() { return null; }
export default MyComponent;`;
    const result = validateComponentCode(code);
    expect(result.checks.hasDefaultExport).toBe(true);
    expect(result.checks.hasReactUsage).toBe(true);
  });

  it('detects missing default export', () => {
    const code = `import React from 'react'; function Foo() {}`;
    const result = validateComponentCode(code);
    expect(result.checks.hasDefaultExport).toBe(false);
    expect(result.valid).toBe(false);
  });

  it('detects eval usage', () => {
    const code = `import React from 'react';
function Foo() { eval('bad'); }
export default Foo;`;
    const result = validateComponentCode(code);
    expect(result.checks.noEval).toBe(false);
  });
});

describe('validateControllerCode', () => {
  it('validates a valid controller', () => {
    const code = `import { useTool } from '@ggui-ai/react-native';
import { cloneElement } from 'react';
function Controller({ children }) {
  const { data, loading, error } = useTool({});
  if (loading) return null;
  if (error) return null;
  return cloneElement(children, { data });
}
export default Controller;`;
    const result = validateControllerCode(code);
    expect(result.checks.hasDefaultExport).toBe(true);
    expect(result.checks.hasUseTool).toBe(true);
    expect(result.checks.hasCloneElement).toBe(true);
    expect(result.checks.hasLoadingState).toBe(true);
    expect(result.checks.hasErrorState).toBe(true);
    expect(result.checks.hasChildrenProp).toBe(true);
  });
});

describe('createTestContext', () => {
  it('creates a context with defaults', () => {
    const ctx = createTestContext();
    expect(ctx.appId).toBe('test-app');
    expect(ctx.renderId).toBe('test-render');
    expect(ctx.auth).toEqual({ isAuthenticated: false });
  });

  it('creates a context with overrides', () => {
    const ctx = createTestContext({ appId: 'my-app', auth: { isAuthenticated: true } });
    expect(ctx.appId).toBe('my-app');
    expect(ctx.auth).toEqual({ isAuthenticated: true });
  });
});

describe('validateEsmSyntax', () => {
  it('validates valid JS', () => {
    expect(validateEsmSyntax('var x = 1;').valid).toBe(true);
  });

  it('rejects invalid JS', () => {
    const result = validateEsmSyntax('function {{{ bad');
    expect(result.valid).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

describe('extractImports / hasImport', () => {
  it('extracts static imports', () => {
    const code = `import React from 'react';
import { View } from 'react-native';`;
    expect(extractImports(code)).toEqual(['react', 'react-native']);
  });

  it('checks for specific import', () => {
    const code = `import React from 'react';`;
    expect(hasImport(code, 'react')).toBe(true);
    expect(hasImport(code, 'vue')).toBe(false);
  });
});
