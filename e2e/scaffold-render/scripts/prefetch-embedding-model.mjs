#!/usr/bin/env node
/**
 * Prefetch the local-embedding model into `GGUI_EMBEDDING_CACHE_DIR`
 * BEFORE the scaffold-render scenarios boot any scaffolded app.
 *
 * Why: the scaffolded `ggui serve` downloads `Xenova/bge-small-en-v1.5`
 * from huggingface.co on first embed. Hosted-CI egress IPs are shared
 * across all of GitHub and HF rate-limits them aggressively (HTTP 429),
 * which downgraded every cache-hit / seed-pool scenario to
 * "RAG retrieval failed" (2026-06-12 nightly, run 27404392073). The fix
 * is two-layered: this prefetch (retried by cell-entry.sh with backoff)
 * seeds the cache once per container, and the workflow persists the
 * host-mounted cache dir across runs via actions/cache so steady-state
 * nightlies never talk to HF at all.
 *
 * Fidelity: goes through `createLocalEmbeddingProvider().embed()` — the
 * exact production load path (same model id / revision / dtype / cache
 * layout) — so a populated cache is hit byte-for-byte by the scaffolded
 * app. A real embed round-trip is the success signal; load failures
 * (429s included) reject and the caller's retry loop takes over.
 *
 * Run from the workspace root (cwd-independent — resolves the built
 * workspace package relative to this file): the import only needs
 * `@ggui-ai/embedding-local` built (`pnpm --filter @ggui-ai/embedding-local build`).
 */
const cacheDir = process.env.GGUI_EMBEDDING_CACHE_DIR;
if (!cacheDir) {
  console.error(
    '[prefetch-embedding-model] GGUI_EMBEDDING_CACHE_DIR is not set — refusing to guess a cache location.',
  );
  process.exit(1);
}

const { createLocalEmbeddingProvider, DEFAULT_MODEL_ID } = await import(
  new URL('../../../packages/embedding-local/dist/index.js', import.meta.url).href
);

const provider = createLocalEmbeddingProvider({ cacheDir, warmup: false });
const started = Date.now();
const vector = await provider.embed('scaffold-render embedding-model prefetch');
console.log(
  `[prefetch-embedding-model] ✓ ${DEFAULT_MODEL_ID} ready in ${cacheDir} ` +
    `(${vector.length}-dim embed round-trip, ${Date.now() - started}ms)`,
);
