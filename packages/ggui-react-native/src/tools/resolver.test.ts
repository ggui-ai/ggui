import { describe, it, expect } from 'vitest';
import {
  topologicalSort,
  interpolateString,
  interpolateConfig,
  getNestedValue,
} from './resolver';
import type { DataBindings } from '@ggui-ai/protocol';

describe('topologicalSort', () => {
  it('returns bindings in dependency order', () => {
    const bindings: DataBindings = {
      user: { tool: 'auth', config: { field: 'currentUser' } },
      profile: {
        tool: 'fetch',
        config: { endpoint: '/api/users/{user.id}' },
        dependsOn: ['user'],
      },
    };

    const sorted = topologicalSort(bindings);
    const keys = sorted.map(([k]) => k);

    expect(keys.indexOf('user')).toBeLessThan(keys.indexOf('profile'));
  });

  it('handles independent bindings', () => {
    const bindings: DataBindings = {
      a: { tool: 'fetch', config: { endpoint: '/a' } },
      b: { tool: 'fetch', config: { endpoint: '/b' } },
    };

    const sorted = topologicalSort(bindings);
    expect(sorted).toHaveLength(2);
  });

  it('detects circular dependencies', () => {
    const bindings: DataBindings = {
      a: { tool: 'fetch', config: {}, dependsOn: ['b'] },
      b: { tool: 'fetch', config: {}, dependsOn: ['a'] },
    };

    expect(() => topologicalSort(bindings)).toThrow('Circular dependency');
  });

  it('throws for missing dependency', () => {
    const bindings: DataBindings = {
      a: { tool: 'fetch', config: {}, dependsOn: ['nonexistent'] },
    };

    expect(() => topologicalSort(bindings)).toThrow("doesn't exist");
  });

  it('handles deep dependency chains', () => {
    const bindings: DataBindings = {
      c: { tool: 'fetch', config: {}, dependsOn: ['b'] },
      b: { tool: 'fetch', config: {}, dependsOn: ['a'] },
      a: { tool: 'fetch', config: {} },
    };

    const sorted = topologicalSort(bindings);
    const keys = sorted.map(([k]) => k);

    expect(keys).toEqual(['a', 'b', 'c']);
  });
});

describe('interpolateString', () => {
  it('replaces placeholders with resolved values', () => {
    const result = interpolateString('/api/users/{user.id}', {
      user: { id: '42' },
    });
    expect(result).toBe('/api/users/42');
  });

  it('leaves unresolved placeholders intact', () => {
    const result = interpolateString('Hello {name}', {});
    expect(result).toBe('Hello {name}');
  });

  it('handles multiple placeholders', () => {
    const result = interpolateString('{a}/{b}/{c}', {
      a: 'x',
      b: 'y',
      c: 'z',
    });
    expect(result).toBe('x/y/z');
  });

  it('converts non-string values to strings', () => {
    const result = interpolateString('count: {count}', { count: 42 });
    expect(result).toBe('count: 42');
  });
});

describe('getNestedValue', () => {
  it('retrieves top-level values', () => {
    expect(getNestedValue({ foo: 'bar' }, 'foo')).toBe('bar');
  });

  it('retrieves nested values', () => {
    expect(getNestedValue({ a: { b: { c: 'deep' } } }, 'a.b.c')).toBe('deep');
  });

  it('returns undefined for missing paths', () => {
    expect(getNestedValue({ a: 1 }, 'b')).toBeUndefined();
  });

  it('returns undefined for null intermediate values', () => {
    expect(getNestedValue({ a: null } as unknown as Record<string, unknown>, 'a.b')).toBeUndefined();
  });
});

describe('interpolateConfig', () => {
  it('interpolates strings within objects', () => {
    const config = {
      url: '/api/{resource}',
      headers: { auth: 'Bearer {token}' },
    };
    const result = interpolateConfig(config, { resource: 'users', token: 'abc' });

    expect(result).toEqual({
      url: '/api/users',
      headers: { auth: 'Bearer abc' },
    });
  });

  it('interpolates strings within arrays', () => {
    const config = ['{a}', '{b}'];
    const result = interpolateConfig(config, { a: 'x', b: 'y' });
    expect(result).toEqual(['x', 'y']);
  });

  it('passes through non-string values', () => {
    const config = { count: 42, flag: true, items: null };
    const result = interpolateConfig(config, {});
    expect(result).toEqual(config);
  });
});
