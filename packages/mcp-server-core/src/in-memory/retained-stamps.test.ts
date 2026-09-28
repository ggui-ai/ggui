/**
 * `RetainedStamps` (ggui#1485): the in-memory active-consumer registry's
 * exit map, bounded by a retention instead of growing with every session
 * that ever had a consumer.
 */
import { describe, expect, it } from 'vitest';
import { RetainedStamps } from './retained-stamps.js';

describe('RetainedStamps', () => {
  it('reads a stamp inside the retention, and undefined past it', () => {
    const s = new RetainedStamps(60);
    s.stamp('a', 0);
    expect(s.age('a', 60)).toBe(60);
    expect(s.age('a', 61)).toBeUndefined();
    expect(s.age('never', 0)).toBeUndefined();
  });

  it('prunes on stamp, so the map holds only the retention window however many keys were stamped', () => {
    const s = new RetainedStamps(60);
    for (let i = 0; i < 1000; i++) s.stamp(`k-${i}`, 0);
    expect(s.size).toBe(1000);
    s.stamp('late', 61);
    expect(s.size).toBe(1);
    expect(s.age('late', 61)).toBe(0);
  });

  it('keeps a stamp exactly at the retention boundary, and prunes the one past it', () => {
    const s = new RetainedStamps(60);
    s.stamp('old', 0);
    s.stamp('edge', 1);
    s.stamp('now', 61);
    expect(s.size).toBe(2);
    expect(s.age('edge', 61)).toBe(60);
    expect(s.age('old', 61)).toBeUndefined();
  });

  it('a re-stamp moves its key to the end: an old first stamp does not get it pruned', () => {
    const s = new RetainedStamps(60);
    s.stamp('a', 0);
    s.stamp('b', 0);
    s.stamp('a', 50);
    s.stamp('c', 61);
    expect(s.size).toBe(2);
    expect(s.age('a', 61)).toBe(11);
    expect(s.age('b', 61)).toBeUndefined();
  });
});
