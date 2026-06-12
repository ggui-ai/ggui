// packages/ui-gen/src/adapters/tool-bridge.test.ts
//
// Unit tests for the tool-bridge narrowing seam: validated narrowing of
// SDK-decoded tool-call arguments (`{ [key: string]: unknown }`) to the
// protocol's `JsonObject`.

import { describe, it, expect } from 'vitest';
import { toolArgsToJsonObject } from './tool-bridge';

describe('toolArgsToJsonObject', () => {
  it('passes through plain JSON data unchanged', () => {
    const args = {
      code: 'const x = 1;',
      retries: 3,
      strict: true,
      label: null,
      tags: ['a', 'b'],
      nested: { deep: { value: 42 }, list: [{ k: 'v' }] },
    };
    expect(toolArgsToJsonObject(args)).toEqual(args);
  });

  it('returns an empty object for empty arguments', () => {
    expect(toolArgsToJsonObject({})).toEqual({});
  });

  it('keeps undefined entries (JSON.stringify omits them)', () => {
    const out = toolArgsToJsonObject({ present: 1, missing: undefined });
    expect(out.present).toBe(1);
    expect('missing' in out).toBe(true);
    expect(out.missing).toBeUndefined();
  });

  it('throws with the offending path for non-JSON leaf values', () => {
    expect(() => toolArgsToJsonObject({ fn: () => 1 })).toThrow(/'fn' \(function\)/);
    expect(() =>
      toolArgsToJsonObject({ outer: { items: [1, 2n] } }),
    ).toThrow(/'outer\.items\[1\]' \(bigint\)/);
  });
});
