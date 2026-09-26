/**
 * ggui#1380 — ONE check-kind union. `GenerationRuntimeProbeCheck` is
 * declared in `@ggui-ai/mcp-server-core` (a generation's metadata lists the
 * checks that failed; core cannot import the engine) and the engine's
 * `RenderCheckKind` is that union under its own name — never a parallel
 * declaration that could drift by one arm. Three pins:
 *
 *   - type-level: the two names are one type, and `RenderCheckIssue.check`
 *     is it; `RENDER_CHECK_KINDS` lists every member (a member missing from
 *     the list is a type error here, a kind outside the union is a type
 *     error at the list);
 *   - runtime: every switch case in `toEvalIssue` is a member — a failed
 *     issue of each kind maps to a `runtime:<kind>` subcategory;
 *   - runtime: the subcategory parser round-trips every kind, with and
 *     without a subject, and refuses what is not a probe subcategory.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';
import type { GenerationRuntimeProbeCheck } from '@ggui-ai/mcp-server-core';
import { RENDER_CHECK_KINDS, type RenderCheckIssue, type RenderCheckKind } from './render-check.js';
import { parseRuntimeSubcategory, toEvalIssue } from './adapter.js';

const DECLARED_ORDER: readonly RenderCheckKind[] = [
  'render-no-throw',
  'prop-sensitivity',
  'action-wiring',
  'selection-identity',
  'prop-coverage',
  'optional-props-omitted',
  'stream-rerender',
];

describe('the check-kind union is declared once (ggui#1380)', () => {
  it("the engine's RenderCheckKind is core's GenerationRuntimeProbeCheck, and RenderCheckIssue.check is it", () => {
    expectTypeOf<RenderCheckKind>().toEqualTypeOf<GenerationRuntimeProbeCheck>();
    expectTypeOf<RenderCheckIssue['check']>().toEqualTypeOf<RenderCheckKind>();
  });

  it('RENDER_CHECK_KINDS lists every member exactly once, in declaration order', () => {
    expectTypeOf<Exclude<RenderCheckKind, (typeof RENDER_CHECK_KINDS)[number]>>().toEqualTypeOf<never>();
    expect([...RENDER_CHECK_KINDS]).toEqual(DECLARED_ORDER);
    expect(new Set(RENDER_CHECK_KINDS).size).toBe(RENDER_CHECK_KINDS.length);
  });

  it('every toEvalIssue switch case is a member: a failed issue of each kind maps to runtime:<kind>', () => {
    for (const check of RENDER_CHECK_KINDS) {
      const issue = toEvalIssue({ check, outcome: 'failed', reason: `${check} failed` });
      expect(issue?.result).toBe('fail');
      expect(issue?.subcategory).toBe(`runtime:${check}`);
    }
  });

  it('the subcategory parser round-trips every kind, with and without a subject', () => {
    for (const check of RENDER_CHECK_KINDS) {
      expect(parseRuntimeSubcategory(`runtime:${check}`)).toBe(check);
      const withSubject = toEvalIssue({ check, outcome: 'failed', subject: 'currentUser', reason: `${check} failed` });
      expect(withSubject?.subcategory).toBe(`runtime:${check}:currentUser`);
      expect(parseRuntimeSubcategory(withSubject?.subcategory ?? '')).toBe(check);
    }
  });

  it('the parser refuses what is not a probe subcategory', () => {
    expect(parseRuntimeSubcategory('runtime:not-a-check')).toBeUndefined();
    expect(parseRuntimeSubcategory('runtime:')).toBeUndefined();
    expect(parseRuntimeSubcategory('runtime')).toBeUndefined();
    expect(parseRuntimeSubcategory('render-no-throw')).toBeUndefined();
    expect(parseRuntimeSubcategory('raw-spacing')).toBeUndefined();
    expect(parseRuntimeSubcategory('runtime:probe-timeout')).toBeUndefined();
    expect(parseRuntimeSubcategory('')).toBeUndefined();
  });
});
