/**
 * MockEmbeddingProvider — deterministic reference implementation of
 * {@link EmbeddingProvider}. Tests-only.
 *
 * Produces a normalized vector via a fixed sine/cosine basis of the
 * input text's characters. Two inputs with the same characters in
 * different order produce different vectors (ordering matters).
 * Same input → same vector, across processes.
 *
 * NOT suitable for real semantic search. Use it to prove wiring +
 * storage + query pipelines — never to benchmark retrieval quality.
 */
import type { EmbeddingProvider } from '../embedding-provider.js';

export interface MockEmbeddingProviderOptions {
  /** Vector length. Defaults to 32 — small enough to print in test output. */
  dimensions?: number;
  /** Provider id; defaults to `"mock-sine"`. */
  id?: string;
}

export class MockEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly dimensions: number;

  constructor(opts: MockEmbeddingProviderOptions = {}) {
    this.dimensions = opts.dimensions ?? 32;
    this.id = opts.id ?? 'mock-sine';
  }

  async embed(text: string): Promise<number[]> {
    const vec = new Array(this.dimensions).fill(0) as number[];
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      for (let d = 0; d < this.dimensions; d++) {
        // Mix position + character into each dimension deterministically.
        vec[d]! += Math.sin((i + 1) * (d + 1) * 0.17) * (code / 128);
      }
    }
    // L2-normalize so cosine similarity is dot product downstream.
    let mag = 0;
    for (const v of vec) mag += v * v;
    mag = Math.sqrt(mag);
    if (mag === 0) return vec; // empty input → all-zeros (rare edge case)
    return vec.map((v) => v / mag);
  }
}
