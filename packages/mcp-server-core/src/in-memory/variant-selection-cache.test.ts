/**
 * Tests for {@link InMemoryVariantSelectionCache} (MVB-6, 2026-05-12).
 * Covers TTL semantics, lazy expiry, default-TTL fallback, and the
 * `(contractHash, persona, context-hash)` key derivation via
 * {@link computeVariantSelectionCacheKey}.
 */
import { describe, expect, it } from 'vitest';
import { InMemoryVariantSelectionCache } from './variant-selection-cache.js';
import {
  DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC,
  computeVariantSelectionCacheKey,
  type VariantSelectionContext,
} from '../variant-selection.js';

describe('InMemoryVariantSelectionCache', () => {
  it('reads back what it wrote', async () => {
    const cache = new InMemoryVariantSelectionCache();
    await cache.put('k', { blueprintId: 'bp-1', reason: 'r1', confidence: 0.9 });
    const hit = await cache.get('k');
    expect(hit).toEqual({ blueprintId: 'bp-1', reason: 'r1', confidence: 0.9 });
  });

  it('returns null on miss', async () => {
    const cache = new InMemoryVariantSelectionCache();
    expect(await cache.get('missing')).toBeNull();
  });

  it('expires entries past their TTL', async () => {
    let now = 1_000_000;
    const cache = new InMemoryVariantSelectionCache({
      now: () => now,
      defaultTtlSec: 10,
    });
    await cache.put('k', { blueprintId: 'bp', reason: 'r', confidence: 1 });
    expect(await cache.get('k')).not.toBeNull();
    now += 11_000; // 11s — past the 10s TTL
    expect(await cache.get('k')).toBeNull();
  });

  it('honors per-put TTL override', async () => {
    let now = 1_000_000;
    const cache = new InMemoryVariantSelectionCache({
      now: () => now,
      defaultTtlSec: 10,
    });
    // Long-lived entry — overrides the 10s default.
    await cache.put(
      'k',
      { blueprintId: 'bp', reason: 'r', confidence: 1 },
      { ttlSec: 600 },
    );
    now += 11_000; // past the default TTL
    expect(await cache.get('k')).not.toBeNull();
    now += 600_000; // past the override
    expect(await cache.get('k')).toBeNull();
  });

  it('treats ttlSec=0 as no expiry', async () => {
    let now = 1_000_000;
    const cache = new InMemoryVariantSelectionCache({
      now: () => now,
    });
    await cache.put(
      'k',
      { blueprintId: 'bp', reason: 'r', confidence: 1 },
      { ttlSec: 0 },
    );
    now += 1_000_000_000;
    expect(await cache.get('k')).not.toBeNull();
  });

  it('size() counts only live rows', async () => {
    let now = 1_000_000;
    const cache = new InMemoryVariantSelectionCache({
      now: () => now,
      defaultTtlSec: 10,
    });
    await cache.put('a', { blueprintId: 'a', reason: '', confidence: 1 });
    await cache.put('b', { blueprintId: 'b', reason: '', confidence: 1 });
    expect(cache.size()).toBe(2);
    now += 11_000;
    expect(cache.size()).toBe(0);
  });

  it('clear() drops every row', async () => {
    const cache = new InMemoryVariantSelectionCache();
    await cache.put('a', { blueprintId: 'a', reason: '', confidence: 1 });
    cache.clear();
    expect(await cache.get('a')).toBeNull();
  });

  it('defaultTtlSec defaults to the module-level constant', async () => {
    let now = 1_000_000;
    const cache = new InMemoryVariantSelectionCache({ now: () => now });
    await cache.put('k', { blueprintId: 'bp', reason: 'r', confidence: 1 });
    now += (DEFAULT_VARIANT_SELECTION_CACHE_TTL_SEC - 1) * 1000;
    expect(await cache.get('k')).not.toBeNull();
    now += 2_000; // tip past
    expect(await cache.get('k')).toBeNull();
  });
});

describe('computeVariantSelectionCacheKey', () => {
  const baseContext: VariantSelectionContext = {
    contractHash: 'hash-abc',
    intent: 'budget UI',
    variance: { persona: 'minimalist' },
  };

  it('is deterministic — same input ⇒ same key', () => {
    const k1 = computeVariantSelectionCacheKey(baseContext);
    const k2 = computeVariantSelectionCacheKey(baseContext);
    expect(k1).toBe(k2);
  });

  it('prefixes on contractHash', () => {
    const k = computeVariantSelectionCacheKey(baseContext);
    expect(k.startsWith('hash-abc:')).toBe(true);
  });

  it('lowercase + trim persona — collision resistance', () => {
    const k1 = computeVariantSelectionCacheKey({
      ...baseContext,
      variance: { persona: 'Minimalist' },
    });
    const k2 = computeVariantSelectionCacheKey({
      ...baseContext,
      variance: { persona: '  minimalist  ' },
    });
    expect(k1).toBe(k2);
  });

  it('different contractHash ⇒ different key', () => {
    const k1 = computeVariantSelectionCacheKey(baseContext);
    const k2 = computeVariantSelectionCacheKey({
      ...baseContext,
      contractHash: 'hash-xyz',
    });
    expect(k1).not.toBe(k2);
  });

  it('different persona ⇒ different key', () => {
    const k1 = computeVariantSelectionCacheKey(baseContext);
    const k2 = computeVariantSelectionCacheKey({
      ...baseContext,
      variance: { persona: 'data-dense' },
    });
    expect(k1).not.toBe(k2);
  });

  it('different variance.context ⇒ different key', () => {
    const k1 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      variance: { persona: 'p', context: { theme: 'dark' } },
    });
    const k2 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      variance: { persona: 'p', context: { theme: 'light' } },
    });
    expect(k1).not.toBe(k2);
  });

  it('field-order-insensitive on variance.context (JCS canonical)', () => {
    const k1 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      variance: { persona: 'p', context: { a: 1, b: 2 } },
    });
    const k2 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      variance: { persona: 'p', context: { b: 2, a: 1 } },
    });
    expect(k1).toBe(k2);
  });

  it('missing variance treated as empty', () => {
    const k1 = computeVariantSelectionCacheKey({ contractHash: 'h' });
    const k2 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      variance: {},
    });
    expect(k1).toBe(k2);
  });

  it('intent is NOT part of the cache key', () => {
    // High-entropy natural-language prose shouldn't fragment cache hits.
    const k1 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      intent: 'budget form for alice',
    });
    const k2 = computeVariantSelectionCacheKey({
      contractHash: 'h',
      intent: 'monthly spending tracker',
    });
    expect(k1).toBe(k2);
  });
});
