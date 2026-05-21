/**
 * Testing Utilities for @ggui-ai/react
 *
 * This module provides utilities for testing the complete flow from
 * MCP requests through UI generation to data binding resolution.
 *
 * These utilities run in Node.js without requiring a browser or React DOM.
 *
 * @example
 * ```ts
 * import {
 *   setupMockTools,
 *   resetMockTools,
 *   resolveBindingsForTest,
 *   validateComponentCode,
 *   validateControllerCode,
 * } from '@ggui-ai/react/testing';
 *
 * describe('Flow test', () => {
 *   beforeEach(() => {
 *     resetMockTools();
 *     setupMockTools({
 *       auth: { id: 'user-123', name: 'Test User' },
 *       fetch: { '/api/users': [{ id: 1, name: 'Alice' }] },
 *     });
 *   });
 *
 *   it('resolves bindings', async () => {
 *     const bindings = {
 *       users: { tool: 'fetch', config: { endpoint: '/api/users' } }
 *     };
 *     const result = await resolveBindingsForTest(bindings);
 *     expect(result.data.users).toEqual([{ id: 1, name: 'Alice' }]);
 *   });
 * });
 * ```
 */

// Mock tools
export {
  setupMockTools,
  resetMockTools,
  registerMockFetch,
  registerMockAuth,
  registerMockStorage,
  registerMockTransform,
  registerMockChain,
  registerMockMerge,
  type MockToolsOptions,
} from './mock-tools';

// Test renderer utilities
export {
  resolveBindingsForTest,
  validateComponentCode,
  validateControllerCode,
  createTestContext,
  validateEsmSyntax,
  extractImports,
  hasImport,
  type TestResolveResult,
  type ValidationResult,
  type TestContextOptions,
} from './test-renderer';
