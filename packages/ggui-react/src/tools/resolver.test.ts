/**
 * Tests for the binding resolver
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  topologicalSort,
  interpolateString,
  interpolateConfig,
  getNestedValue,
  resolveBindings,
} from './resolver';
import { toolRegistry } from './registry';
import type { DataBindings } from '@ggui-ai/protocol';

describe('topologicalSort', () => {
  it('should sort independent bindings in insertion order', () => {
    const bindings: DataBindings = {
      a: { tool: 'fetch', config: { endpoint: '/a' } },
      b: { tool: 'fetch', config: { endpoint: '/b' } },
      c: { tool: 'fetch', config: { endpoint: '/c' } },
    };

    const sorted = topologicalSort(bindings);
    expect(sorted.map(([key]) => key)).toEqual(['a', 'b', 'c']);
  });

  it('should sort dependent bindings after their dependencies', () => {
    const bindings: DataBindings = {
      profile: {
        tool: 'fetch',
        config: { endpoint: '/profile/{user.id}' },
        dependsOn: ['user'],
      },
      user: { tool: 'auth', config: { field: 'currentUser' } },
    };

    const sorted = topologicalSort(bindings);
    expect(sorted.map(([key]) => key)).toEqual(['user', 'profile']);
  });

  it('should handle complex dependency chains', () => {
    const bindings: DataBindings = {
      d: {
        tool: 'fetch',
        config: { endpoint: '/d' },
        dependsOn: ['c'],
      },
      c: {
        tool: 'fetch',
        config: { endpoint: '/c' },
        dependsOn: ['b'],
      },
      b: {
        tool: 'fetch',
        config: { endpoint: '/b' },
        dependsOn: ['a'],
      },
      a: { tool: 'auth', config: { field: 'currentUser' } },
    };

    const sorted = topologicalSort(bindings);
    expect(sorted.map(([key]) => key)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('should detect circular dependencies', () => {
    const bindings: DataBindings = {
      a: {
        tool: 'fetch',
        config: { endpoint: '/a' },
        dependsOn: ['b'],
      },
      b: {
        tool: 'fetch',
        config: { endpoint: '/b' },
        dependsOn: ['a'],
      },
    };

    expect(() => topologicalSort(bindings)).toThrow(/circular dependency/i);
  });

  it('should throw if dependency does not exist', () => {
    const bindings: DataBindings = {
      a: {
        tool: 'fetch',
        config: { endpoint: '/a' },
        dependsOn: ['nonexistent'],
      },
    };

    expect(() => topologicalSort(bindings)).toThrow(/doesn't exist/i);
  });
});

describe('interpolateString', () => {
  it('should interpolate simple values', () => {
    const result = interpolateString('/api/users/{userId}', { userId: '123' });
    expect(result).toBe('/api/users/123');
  });

  it('should interpolate nested values', () => {
    const result = interpolateString('/api/users/{user.id}', {
      user: { id: 456 },
    });
    expect(result).toBe('/api/users/456');
  });

  it('should interpolate deeply nested values', () => {
    const result = interpolateString('/api/{a.b.c.d}', {
      a: { b: { c: { d: 'value' } } },
    });
    expect(result).toBe('/api/value');
  });

  it('should keep placeholder if value not found', () => {
    const result = interpolateString('/api/{missing}', {});
    expect(result).toBe('/api/{missing}');
  });

  it('should interpolate multiple placeholders', () => {
    const result = interpolateString('/api/{a}/{b}/{c}', {
      a: '1',
      b: '2',
      c: '3',
    });
    expect(result).toBe('/api/1/2/3');
  });

  it('should handle prev from chain', () => {
    const result = interpolateString('/api/users/{prev.id}', {
      prev: { id: 789 },
    });
    expect(result).toBe('/api/users/789');
  });
});

describe('getNestedValue', () => {
  it('should get top-level values', () => {
    expect(getNestedValue({ foo: 'bar' }, 'foo')).toBe('bar');
  });

  it('should get nested values', () => {
    expect(getNestedValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('should return undefined for missing paths', () => {
    expect(getNestedValue({}, 'a.b.c')).toBeUndefined();
  });

  it('should return undefined for null in path', () => {
    expect(getNestedValue({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('interpolateConfig', () => {
  it('should interpolate strings in config', () => {
    const config = {
      endpoint: '/api/{user.id}',
      headers: {
        Authorization: 'Bearer {token}',
      },
    };

    const resolved = { user: { id: 123 }, token: 'abc' };
    const result = interpolateConfig(config, resolved);

    expect(result).toEqual({
      endpoint: '/api/123',
      headers: {
        Authorization: 'Bearer abc',
      },
    });
  });

  it('should interpolate arrays', () => {
    const config = ['/api/{a}', '/api/{b}'];
    const resolved = { a: '1', b: '2' };
    const result = interpolateConfig(config, resolved);

    expect(result).toEqual(['/api/1', '/api/2']);
  });

  it('should preserve non-string values', () => {
    const config = {
      count: 42,
      flag: true,
      nested: { value: '{name}' },
    };

    const result = interpolateConfig(config, { name: 'test' });

    expect(result).toEqual({
      count: 42,
      flag: true,
      nested: { value: 'test' },
    });
  });
});

describe('resolveBindings', () => {
  beforeEach(() => {
    toolRegistry.clear();

    // Register mock tools
    toolRegistry.register({
      name: 'auth',
      execute: async (config: { field: string }) => {
        if (config.field === 'currentUser') {
          return { id: 'user123', name: 'Test User' };
        }
        return null;
      },
    });

    toolRegistry.register({
      name: 'fetch',
      execute: async (config: { endpoint: string }) => {
        // Mock different endpoints
        if (config.endpoint.includes('user123')) {
          return { profile: 'test profile' };
        }
        return { data: 'mock' };
      },
    });
  });

  it('should resolve simple bindings', async () => {
    const bindings: DataBindings = {
      user: { tool: 'auth', config: { field: 'currentUser' } },
    };

    const result = await resolveBindings(bindings, {
      resolved: {},
      appId: 'test',
      renderId: 'test',
    });

    expect(result.data.user).toEqual({ id: 'user123', name: 'Test User' });
    expect(result.errors.user).toBeNull();
  });

  it('should resolve dependent bindings with interpolation', async () => {
    const bindings: DataBindings = {
      user: { tool: 'auth', config: { field: 'currentUser' } },
      profile: {
        tool: 'fetch',
        config: { endpoint: '/api/users/{user.id}/profile' },
        dependsOn: ['user'],
      },
    };

    const result = await resolveBindings(bindings, {
      resolved: {},
      appId: 'test',
      renderId: 'test',
    });

    expect(result.data.user).toEqual({ id: 'user123', name: 'Test User' });
    expect(result.data.profile).toEqual({ profile: 'test profile' });
  });

  it('should capture errors but continue resolving', async () => {
    toolRegistry.register({
      name: 'storage',
      execute: async () => {
        throw new Error('Storage not available');
      },
    });

    const bindings: DataBindings = {
      prefs: { tool: 'storage', config: { key: 'prefs' } },
      user: { tool: 'auth', config: { field: 'currentUser' } },
    };

    const result = await resolveBindings(bindings, {
      resolved: {},
      appId: 'test',
      renderId: 'test',
    });

    expect(result.errors.prefs).toBeInstanceOf(Error);
    expect(result.data.user).toEqual({ id: 'user123', name: 'Test User' });
  });
});
