/**
 * EmbeddingProvider — text → vector.
 *
 * Called by the negotiator and by RAG search to embed queries and
 * blueprint contracts before nearest-neighbor lookup in
 * {@link VectorStore}.
 *
 * Reference implementations:
 *   - MockEmbeddingProvider     (tests; deterministic vectors)
 *   - OpenAIEmbeddingProvider   (OSS BYOK default; cloud-agnostic)
 *   - BedrockEmbeddingProvider  (hosted runtime — `cloud/`, closed)
 */

export interface EmbeddingProvider {
  /**
   * Provider id — e.g. `"openai-3-small"`, `"bedrock-titan-v2"`, `"mock"`.
   * Used as a storage-subdirectory key and to detect provider drift when
   * loading a VectorStore written by a different provider.
   */
  readonly id: string;

  /**
   * Dimensions of every vector this provider emits. MUST be constant across
   * the provider's lifetime. Callers compare this against the stored
   * dimension of a VectorStore index at initialization time.
   */
  readonly dimensions: number;

  /**
   * Embed a single text to a normalized vector of length `dimensions`.
   *
   * Normative semantics:
   * - Output length MUST equal `dimensions`.
   * - Output SHOULD be L2-normalized so cosine similarity reduces to dot
   *   product downstream.
   * - Implementations MAY truncate or chunk long inputs; document the
   *   policy. Bedrock Titan v2 truncates to 8K chars today.
   */
  embed(text: string): Promise<number[]>;
}
