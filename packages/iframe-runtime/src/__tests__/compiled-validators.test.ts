import { describe, it, expect } from 'vitest';
import {
  loadCompiledValidators,
  EMPTY_COMPILED_VALIDATOR_SET,
} from '../compiled-validators.js';

describe('loadCompiledValidators', () => {
  it('returns the empty set when the bootstrap carries no compiledValidators', async () => {
    const set = await loadCompiledValidators(undefined);
    expect(set).toBe(EMPTY_COMPILED_VALIDATOR_SET);
    expect(set.props).toBeUndefined();
    expect(set.actions.size).toBe(0);
    expect(set.streams.size).toBe(0);
    expect(set.context.size).toBe(0);
  });

  it('degrades gracefully when a module fails to load (no crash, warn called)', async () => {
    // jsdom has no `URL.createObjectURL`, so every `loadModule` here
    // throws — exercising the per-module try/catch. The boot must not
    // crash; failed modules simply do not land in the set.
    const warnings: string[] = [];
    const set = await loadCompiledValidators(
      {
        props: 'export default function(){return true;}',
        actions: { submit: 'export default function(){return true;}' },
      },
      (message) => warnings.push(message),
    );
    expect(set.props).toBeUndefined();
    expect(set.actions.size).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some((w) => w.includes('props'))).toBe(true);
    expect(warnings.some((w) => w.includes('action.submit'))).toBe(true);
  });
});
