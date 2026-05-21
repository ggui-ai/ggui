/**
 * Contract test factory for {@link EmbeddingProvider} implementations.
 *
 * Normative semantics covered:
 *   - `id` is non-empty.
 *   - `dimensions` is positive.
 *   - `embed(text)` returns a vector of exactly `dimensions` length.
 *   - Output is L2-normalized (approximately — within FP tolerance) or
 *     documented-zero for degenerate input.
 *   - Calling `embed` with the same input twice yields the same vector
 *     (determinism within a single process).
 *
 * This suite does NOT test retrieval quality — that requires real
 * corpora and is out of scope for the contract. It tests the _shape_
 * guarantee callers depend on: dimension consistency, stable id,
 * deterministic output.
 */
import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from '../embedding-provider.js';

export function embeddingProviderContract(
  label: string,
  makeProvider: () => Promise<EmbeddingProvider> | EmbeddingProvider,
): void {
  describe(`EmbeddingProvider contract — ${label}`, () => {
    it('id is non-empty', async () => {
      const p = await makeProvider();
      expect(p.id).toBeTruthy();
      expect(typeof p.id).toBe('string');
    });

    it('dimensions is a positive integer', async () => {
      const p = await makeProvider();
      expect(Number.isInteger(p.dimensions)).toBe(true);
      expect(p.dimensions).toBeGreaterThan(0);
    });

    it('embed(text) returns a vector of exactly `dimensions` length', async () => {
      const p = await makeProvider();
      const vec = await p.embed('hello world');
      expect(vec).toHaveLength(p.dimensions);
      for (const n of vec) expect(typeof n).toBe('number');
    });

    it('embed is deterministic within a process', async () => {
      const p = await makeProvider();
      const a = await p.embed('same input');
      const b = await p.embed('same input');
      expect(a).toEqual(b);
    });

    it('output is L2-normalized (or all-zeros for degenerate input)', async () => {
      const p = await makeProvider();
      const vec = await p.embed('the quick brown fox jumps over the lazy dog');
      let mag = 0;
      for (const n of vec) mag += n * n;
      mag = Math.sqrt(mag);
      // Normalized providers land at ~1.0; providers that emit all-zeros
      // for empty-input degenerate cases will land at 0.0. Anything else
      // means the vector isn't normalized and cosine similarity downstream
      // will silently misbehave.
      expect(mag === 0 || Math.abs(mag - 1) < 1e-3).toBe(true);
    });
  });
}
