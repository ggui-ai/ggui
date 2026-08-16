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

describe('loadCompiledValidatorsFromUrl — v2 executable bundle (ggui#522 slice 2)', () => {
  it('one import yields FUNCTIONS directly — no per-validator blob load', async () => {
    const { loadCompiledValidatorsFromUrl } = await import(
      '../compiled-validators.js'
    );
    // The exact module shape bundleValidatorExprsAsExecutableModule
    // emits, delivered as a data: URL (vitest's node runtime imports
    // data: ESM natively — the same single-import path the iframe
    // takes against the https validatorsUrl).
    const bundle = [
      '"use strict";',
      'const v = {};',
      'v.props = (function(){return function(d){return typeof d==="object";}})();',
      'v.actions = {};',
      'v.actions["submit"] = (function(){return function(d){return d!==null;}})();',
      'export default v;',
    ].join('\n');
    const set = await loadCompiledValidatorsFromUrl(
      `data:text/javascript,${encodeURIComponent(bundle)}`,
    );
    expect(set.props).toBeTypeOf('function');
    expect(set.actions.get('submit')).toBeTypeOf('function');
    expect(set.actions.get('submit')!({})).toBe(true);
  });

  it('degrades a stale v1-format bundle (string leaves) to absent validators with warnings', async () => {
    const { loadCompiledValidatorsFromUrl, EMPTY_COMPILED_VALIDATOR_SET: EMPTY } =
      await import('../compiled-validators.js');
    const v1 = `export default ${JSON.stringify({
      props: 'export default function(){return true;}',
      actions: { submit: 'export default function(){return true;}' },
    })};`;
    const warnings: string[] = [];
    const set = await loadCompiledValidatorsFromUrl(
      `data:text/javascript,${encodeURIComponent(v1)}`,
      (message) => warnings.push(message),
    );
    expect(set.props).toBeUndefined();
    expect(set.actions.size).toBe(0);
    expect(warnings.some((w) => w.includes('v1-format'))).toBe(true);
    // Not the shared EMPTY sentinel — a real (empty) set is fine; the
    // load itself did not fail.
    void EMPTY;
  });
});
