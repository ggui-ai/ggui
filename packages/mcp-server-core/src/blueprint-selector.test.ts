/**
 * Tests for the deterministic {@link BlueprintSelector} ladder
 * (MVB-2, 2026-05-12). Covers each ladder step + tiebreakers.
 */
import type { Blueprint } from '@ggui-ai/protocol';
import { describe, expect, it } from 'vitest';
import { createDeterministicBlueprintSelector } from './blueprint-selector.js';

function bp(overrides: Partial<Blueprint> & { blueprintId: string }): Blueprint {
  return {
    blueprintId: overrides.blueprintId,
    contractHash: overrides.contractHash ?? 'hash-1',
    appId: overrides.appId ?? 'app-1',
    codeS3Url: overrides.codeS3Url,
    codeHash: overrides.codeHash,
    source: overrides.source ?? {
      kind: 'llm',
      generator: 'ui-gen-default-haiku-4-5',
      model: 'claude-haiku-4-5',
    },
    validatorScore: overrides.validatorScore,
    variance: overrides.variance ?? {},
    isOperatorDefault: overrides.isOperatorDefault,
    createdAt: overrides.createdAt ?? '2026-05-12T00:00:00.000Z',
    createdBy: overrides.createdBy ?? 'agent',
    contract: overrides.contract ?? { propsSpec: { properties: {} } },
  };
}

describe('createDeterministicBlueprintSelector', () => {
  const selector = createDeterministicBlueprintSelector();

  it('returns null on empty candidate list', () => {
    expect(selector.selectVariant([])).toBeNull();
  });

  describe('step 1 — operator default wins', () => {
    it('picks the row with isOperatorDefault: true', () => {
      const a = bp({ blueprintId: 'a', validatorScore: 0.95 });
      const b = bp({
        blueprintId: 'b',
        validatorScore: 0.1,
        isOperatorDefault: true,
      });
      const c = bp({ blueprintId: 'c', validatorScore: 0.9 });
      expect(selector.selectVariant([a, b, c])?.blueprintId).toBe('b');
    });
  });

  describe('step 2 — highest validator score', () => {
    it('picks the row with the highest validatorScore when no default set', () => {
      const a = bp({ blueprintId: 'a', validatorScore: 0.5 });
      const b = bp({ blueprintId: 'b', validatorScore: 0.9 });
      const c = bp({ blueprintId: 'c', validatorScore: 0.7 });
      expect(selector.selectVariant([a, b, c])?.blueprintId).toBe('b');
    });

    it('ignores rows where validatorScore is undefined', () => {
      const a = bp({ blueprintId: 'a' }); // undefined
      const b = bp({ blueprintId: 'b', validatorScore: 0.5 });
      expect(selector.selectVariant([a, b])?.blueprintId).toBe('b');
    });

    it('breaks score ties by createdAt desc', () => {
      const a = bp({
        blueprintId: 'a',
        validatorScore: 0.8,
        createdAt: '2026-05-12T00:00:00.000Z',
      });
      const b = bp({
        blueprintId: 'b',
        validatorScore: 0.8,
        createdAt: '2026-05-12T01:00:00.000Z',
      });
      expect(selector.selectVariant([a, b])?.blueprintId).toBe('b');
    });

    it('breaks score+createdAt ties by blueprintId asc', () => {
      const a = bp({
        blueprintId: 'a',
        validatorScore: 0.8,
        createdAt: '2026-05-12T00:00:00.000Z',
      });
      const b = bp({
        blueprintId: 'b',
        validatorScore: 0.8,
        createdAt: '2026-05-12T00:00:00.000Z',
      });
      expect(selector.selectVariant([a, b])?.blueprintId).toBe('a');
    });
  });

  describe('step 3 — newest createdAt when no validator scores', () => {
    it('picks the row with the newest createdAt', () => {
      const a = bp({ blueprintId: 'a', createdAt: '2026-05-12T00:00:00.000Z' });
      const b = bp({ blueprintId: 'b', createdAt: '2026-05-12T02:00:00.000Z' });
      const c = bp({ blueprintId: 'c', createdAt: '2026-05-12T01:00:00.000Z' });
      expect(selector.selectVariant([a, b, c])?.blueprintId).toBe('b');
    });

    it('breaks createdAt ties by blueprintId asc', () => {
      const a = bp({ blueprintId: 'a', createdAt: '2026-05-12T00:00:00.000Z' });
      const b = bp({ blueprintId: 'b', createdAt: '2026-05-12T00:00:00.000Z' });
      expect(selector.selectVariant([a, b])?.blueprintId).toBe('a');
    });
  });

  describe('determinism', () => {
    it('produces the same pick on repeated calls', () => {
      const a = bp({ blueprintId: 'z', validatorScore: 0.8 });
      const b = bp({ blueprintId: 'a', validatorScore: 0.8 });
      const first = selector.selectVariant([a, b])?.blueprintId;
      const second = selector.selectVariant([a, b])?.blueprintId;
      expect(first).toBe(second);
      // Tiebreak rule (step 2 tail) sorts by blueprintId asc on equal score+createdAt.
      expect(first).toBe('a');
    });

    it('produces the same pick regardless of candidate order', () => {
      const a = bp({ blueprintId: 'a', validatorScore: 0.8 });
      const b = bp({ blueprintId: 'b', validatorScore: 0.9 });
      const c = bp({ blueprintId: 'c', validatorScore: 0.7 });
      const forward = selector.selectVariant([a, b, c])?.blueprintId;
      const reverse = selector.selectVariant([c, b, a])?.blueprintId;
      expect(forward).toBe('b');
      expect(reverse).toBe('b');
    });
  });
});
