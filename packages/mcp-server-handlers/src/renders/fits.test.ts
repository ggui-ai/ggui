import { describe, it, expect } from 'vitest';
import type { DataContract, JsonSchema } from '@ggui-ai/protocol';
import { directionDigest, fits, jsonSchemaTypesCompatible, type FitVerdict } from './fits.js';

// ggui#1427 — the three code checks that run before the judge (#1329's design,
// amended c.5846640850): data-shape, surface, direction. Each runs only when
// BOTH sides declare its fact; an undeclared side reads `not-evaluated`, never
// a miss. First miss wins, in that order.

const props = (entries: Record<string, { type?: JsonSchema['type']; required?: boolean }>): DataContract => ({
  propsSpec: {
    properties: Object.fromEntries(
      Object.entries(entries).map(([name, e]) => {
        const schema: JsonSchema = e.type === undefined ? {} : { type: e.type };
        return [name, { schema, ...(e.required === true ? { required: true } : {}) }];
      }),
    ),
  },
});

describe('directionDigest', () => {
  it('hashes the direction text trimmed, whitespace-collapsed and lowercased — a stray edit to spacing or case never flips a card', () => {
    expect(directionDigest('  Warm,   editorial\n tone ')).toBe(directionDigest('warm, editorial tone'));
    expect(directionDigest('warm, editorial tone')).toMatch(/^[0-9a-f]{64}$/);
    expect(directionDigest('warm, editorial tone')).not.toBe(directionDigest('cold, editorial tone'));
  });
});

describe('jsonSchemaTypesCompatible (data-shape)', () => {
  it('integer satisfies a number spec; the reverse does not', () => {
    expect(jsonSchemaTypesCompatible('number', 'integer')).toBe(true);
    expect(jsonSchemaTypesCompatible('integer', 'number')).toBe(false);
  });
  it('equal types are compatible; different types are not; type arrays are compatible when they intersect', () => {
    expect(jsonSchemaTypesCompatible('string', 'string')).toBe(true);
    expect(jsonSchemaTypesCompatible('string', 'boolean')).toBe(false);
    expect(jsonSchemaTypesCompatible(['string', 'null'], 'string')).toBe(true);
    expect(jsonSchemaTypesCompatible(['string', 'null'], ['boolean', 'null'])).toBe(true);
    expect(jsonSchemaTypesCompatible(['string', 'number'], ['boolean'])).toBe(false);
    expect(jsonSchemaTypesCompatible(['number'], ['integer'])).toBe(true);
  });
  it('an absent type on either side is compatible', () => {
    expect(jsonSchemaTypesCompatible(undefined, 'string')).toBe(true);
    expect(jsonSchemaTypesCompatible('string', undefined)).toBe(true);
  });
});

describe('fits', () => {
  const digest = directionDigest('warm tone');
  const request = {
    contract: props({ rating: { type: 'integer' } }),
    canvas: 'md',
    aestheticPreset: { id: 'editorial' },
    directionDigest: digest,
  };

  it('every declared fact matches → fits, each check a hit, no miss named', () => {
    const v: FitVerdict = fits(
      {
        contract: props({ rating: { type: 'number', required: true } }),
        judgedCanvases: ['md', 'lg'],
        aestheticPreset: { id: 'editorial', version: '3' },
        directionDigest: directionDigest('  WARM tone '),
      },
      request,
    );
    expect(v).toEqual({ fits: true, checks: { 'data-shape': 'hit', surface: 'hit', direction: 'hit' } });
  });

  it('first miss wins, in the order data-shape → surface → direction; every check is still reported', () => {
    const v = fits(
      { contract: props({ rating: { type: 'string', required: true } }), judgedCanvases: ['xs-chat-card'], aestheticPreset: { id: 'brutalist' } },
      request,
    );
    expect(v.fits).toBe(false);
    expect(v.miss).toBe('data-shape');
    expect(v.checks).toEqual({ 'data-shape': 'miss', surface: 'miss', direction: 'miss' });
    const w = fits({ contract: props({}), judgedCanvases: ['xs-chat-card'], aestheticPreset: { id: 'brutalist' } }, request);
    expect(w.miss).toBe('surface');
  });

  it('an undeclared side is not-evaluated, never a miss — on both sides, per check', () => {
    // Nothing declared beyond the contracts: only data-shape runs.
    const v = fits({ contract: props({ rating: { type: 'number', required: true } }) }, { contract: request.contract });
    expect(v).toEqual({ fits: true, checks: { 'data-shape': 'hit', surface: 'not-evaluated', direction: 'not-evaluated' } });
    // The candidate declares canvases; the request declares no canvas.
    expect(fits({ contract: props({}), judgedCanvases: ['md'] }, { contract: props({}) }).checks.surface).toBe('not-evaluated');
    // The request declares a canvas; the candidate has no judged canvases.
    expect(fits({ contract: props({}) }, { contract: props({}), canvas: 'md' }).checks.surface).toBe('not-evaluated');
    // A contract-less request (the semantic path without a draft) leaves data-shape not-evaluated.
    expect(fits({ contract: props({ rating: { type: 'number', required: true } }) }, {}).checks['data-shape']).toBe('not-evaluated');
  });

  it('data-shape: a prop the candidate REQUIRES that the request does not declare, or declares with an incompatible type, is a miss', () => {
    const cand = { contract: props({ rating: { type: 'number', required: true }, note: { type: 'string' } }) };
    expect(fits(cand, { contract: props({}) }).checks['data-shape']).toBe('miss');
    expect(fits(cand, { contract: props({ rating: { type: 'string' } }) }).checks['data-shape']).toBe('miss');
    expect(fits(cand, { contract: props({ rating: { type: 'integer' } }) }).checks['data-shape']).toBe('hit');
    // An optional candidate prop the request omits, or types differently, is a coverage matter — never a fit miss.
    expect(fits(cand, { contract: props({ rating: { type: 'number' }, note: { type: 'boolean' } }) }).checks['data-shape']).toBe('hit');
    // An OPTIONAL request prop the candidate lacks is a coverage gap (reported elsewhere), not a fit miss.
    expect(fits(cand, { contract: props({ rating: { type: 'number' }, extra: { type: 'string' } }) }).checks['data-shape']).toBe('hit');
    // A required prop with no declared type accepts any declared type.
    expect(fits({ contract: props({ rating: { required: true } }) }, { contract: props({ rating: { type: 'string' } }) }).checks['data-shape']).toBe('hit');
  });

  it('data-shape: a prop the REQUEST marks required that the candidate does not declare at all is a miss — the render refuses an undeclared key every time, so the candidate cannot serve it', () => {
    const list = { contract: props({ items: { type: 'array' } }) };
    expect(fits(list, { contract: props({ contacts: { type: 'array', required: true } }) }).checks['data-shape']).toBe('miss');
    expect(
      fits(
        { contract: props({ quote: { type: 'string' }, author: { type: 'string' } }) },
        { contract: props({ bookTitle: { type: 'string', required: true }, author: { type: 'string' } }) },
      ).checks['data-shape'],
    ).toBe('miss');
    // A request-REQUIRED prop the candidate declares with an INCOMPATIBLE type is a miss too: it is always sent, and the
    // served contract's type check refuses it every time, exactly as it refuses an undeclared key (ggui#1427, the CTO's read).
    expect(fits({ contract: props({ rating: { type: 'string' } }) }, { contract: props({ rating: { type: 'number', required: true } }) }).checks['data-shape']).toBe('miss');
    // Compatibility, not string equality: an integer the request requires fits a candidate's number, and an absent type fits anything.
    expect(fits({ contract: props({ rating: { type: 'number' } }) }, { contract: props({ rating: { type: 'integer', required: true } }) }).checks['data-shape']).toBe('hit');
    expect(fits({ contract: props({ rating: {} }) }, { contract: props({ rating: { type: 'number', required: true } }) }).checks['data-shape']).toBe('hit');
    // An OPTIONAL request prop declared with another type stays a coverage matter: it is refused only when sent, never a fit miss here.
    expect(fits({ contract: props({ rating: { type: 'string' } }) }, { contract: props({ rating: { type: 'number' } }) }).checks['data-shape']).toBe('hit');
    // An OPTIONAL request prop the candidate lacks stays a coverage gap (informational), not a miss.
    expect(fits(list, { contract: props({ contacts: { type: 'array' } }) }).checks['data-shape']).toBe('hit');
    // The candidate may declare more than the request; an empty request declaration is covered by any candidate.
    expect(fits({ contract: props({ rating: { type: 'number' }, note: { type: 'string' } }) }, { contract: props({ rating: { type: 'number', required: true } }) }).checks['data-shape']).toBe('hit');
    expect(fits(list, { contract: props({}) }).checks['data-shape']).toBe('hit');
    // The candidate-required arm stays beside it.
    expect(fits({ contract: props({ rating: { type: 'number', required: true } }) }, { contract: props({}) }).checks['data-shape']).toBe('miss');
  });

  it('surface: the request canvas must be one the candidate was judged on', () => {
    expect(fits({ contract: props({}), judgedCanvases: ['sm', 'md'] }, { contract: props({}), canvas: 'xl' }).checks.surface).toBe('miss');
    expect(fits({ contract: props({}), judgedCanvases: ['sm', 'md'] }, { contract: props({}), canvas: 'md' }).checks.surface).toBe('hit');
  });

  it('direction: a request preset without a version compares by id alone; with one it compares both', () => {
    const cand = { contract: props({}), aestheticPreset: { id: 'editorial', version: '3' } };
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'editorial' } }).checks.direction).toBe('hit');
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'editorial', version: null } }).checks.direction).toBe('hit');
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'editorial', version: '3' } }).checks.direction).toBe('hit');
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'editorial', version: '2' } }).checks.direction).toBe('miss');
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'brutalist' } }).checks.direction).toBe('miss');
    // A request that pins a version misses a candidate whose row recorded none.
    expect(fits({ contract: props({}), aestheticPreset: { id: 'editorial' } }, { contract: props({}), aestheticPreset: { id: 'editorial', version: '3' } }).checks.direction).toBe('miss');
  });

  it('direction: the digests must be equal when both sides carry one; preset and digest are one check', () => {
    const cand = { contract: props({}), aestheticPreset: { id: 'editorial', version: '3' }, directionDigest: digest };
    expect(fits(cand, { contract: props({}), directionDigest: directionDigest('cold tone') }).checks.direction).toBe('miss');
    expect(fits(cand, { contract: props({}), directionDigest: digest }).checks.direction).toBe('hit');
    // Preset matches, digest differs → the check misses (the app changed its direction).
    expect(fits(cand, { contract: props({}), aestheticPreset: { id: 'editorial' }, directionDigest: directionDigest('cold tone') }).checks.direction).toBe('miss');
  });
});

describe('fits — the direction scope rides the verdict (cto on #1427)', () => {
  const digest = directionDigest('warm tone');
  it('a candidate that declares its direction scope carries it on the verdict whenever the direction check ran — hit or miss', () => {
    const miss = fits({ contract: props({}), directionDigest: digest, directionScope: 'request' }, { contract: props({}), directionDigest: directionDigest('cold tone') });
    expect(miss.checks.direction).toBe('miss');
    expect(miss.directionScope).toBe('request');
    const hit = fits({ contract: props({}), directionDigest: digest, directionScope: 'app' }, { contract: props({}), directionDigest: digest });
    expect(hit.checks.direction).toBe('hit');
    expect(hit.directionScope).toBe('app');
  });
  it('no scope on the verdict when the candidate declared none, or when the direction check did not run', () => {
    expect(fits({ contract: props({}), directionDigest: digest }, { contract: props({}), directionDigest: digest })).not.toHaveProperty('directionScope');
    expect(fits({ contract: props({}), directionDigest: digest, directionScope: 'app' }, { contract: props({}) })).not.toHaveProperty('directionScope');
  });
});
