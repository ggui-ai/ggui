import { describe, it, expect } from 'vitest';
import { dataContractSchema } from '@ggui-ai/protocol';
import { BENCHMARK_COMMITS, EXPERIMENT_COMMITS, resolveRunCommits } from './commits';

describe('experiment corpus (outside the public matrix)', () => {
  it('is disjoint from the public corpus, so the published run is unchanged', () => {
    const publicIds = new Set(BENCHMARK_COMMITS.map((c) => c.id));
    for (const c of EXPERIMENT_COMMITS) expect(publicIds.has(c.id)).toBe(false);
  });

  it('booking-confirm (#1223) declares confirm oneShot and edit repeatable, under the protocol schema', () => {
    const c = EXPERIMENT_COMMITS.find((x) => x.id === 'booking-confirm');
    expect(c).toBeDefined();
    const parsed = dataContractSchema.safeParse(c!.contract);
    expect(parsed.success).toBe(true);
    expect(c!.contract.actionSpec?.confirm?.oneShot).toBe(true);
    expect(c!.contract.actionSpec?.edit?.oneShot).toBeUndefined();
  });
});

describe('resolveRunCommits', () => {
  it('the public ids resolve to exactly the public corpus, in order', () => {
    expect(resolveRunCommits(BENCHMARK_COMMITS.map((c) => c.id))).toEqual(BENCHMARK_COMMITS);
  });

  it('an experiment id is addressable by name', () => {
    expect(resolveRunCommits(['booking-confirm']).map((c) => c.id)).toEqual(['booking-confirm']);
  });

  it('an unknown id throws instead of being dropped', () => {
    expect(() => resolveRunCommits(['weather-card', 'no-such-card'])).toThrow(/Unknown commit ID\(s\): no-such-card/);
  });
});
