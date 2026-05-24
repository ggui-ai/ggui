/**
 * Predefined contracts for the blueprint-cache e2e suite (scenarios 8,
 * 16, 17, 18). One contract per scenario — each carries a unique
 * `propsSpec.description` so its `blueprintKey(contract)` (the 16-char
 * sha256 prefix of the JCS-canonicalized contract) is distinct across
 * scenarios.
 *
 * ## Why one contract per scenario
 *
 * The cache lives in the harness's shared in-memory `VectorStore`,
 * which persists for the duration of the harness's server boot (each
 * suite reuses the running `ggui serve --dev-allow-all` on :6781).
 * Cache rows from earlier scenarios stay around when later scenarios
 * run. If two scenarios shared a contract, the second one would see a
 * pre-populated cache row from the first and could not assert "cold
 * gen primes a fresh row." Distinct contracts give each scenario its
 * own `template:${contractKey}` slot in the registry.
 *
 * ## Intent pairs (canonical + paraphrased)
 *
 * Scenarios 17 + 18 specifically test that intent paraphrase doesn't
 * affect cache identity — `blueprintKey` hashes the canonical
 * contract bytes alone, so any intent string that reuses the same
 * contract must hit the same registry slot. Each scenario therefore
 * gets two intent exports:
 *   - `*_INTENT_CANONICAL` — the priming-side phrasing.
 *   - `*_INTENT_PARAPHRASED` — the agent-side rephrase that should
 *     still match the cached blueprint.
 *
 * ## Shape choice
 *
 * Contracts are intentionally minimal — `propsSpec.description` plus
 * a single prop entry (`required: true` when the test passes `props`,
 * `required: false` for pure-display scenarios). Minimal shapes keep
 * the LLM cold-gen cheap (smaller prompt, faster Haiku) without
 * affecting cache semantics — the cache key is a hash of the
 * canonical contract, not of the rendered HTML.
 *
 * ## Don't share with non-cache scenarios
 *
 * `shared-contract.ts`'s `SHARED_CONTRACT` is used by scenarios 1-3
 * (submit_action, PIPE_NOT_FOUND, contextSnapshot) which share a
 * single cold-gen on purpose. Cache scenarios deliberately get their
 * own slots so the cache-hit assertions remain meaningful — putting a
 * cache scenario on `SHARED_CONTRACT` would let scenarios 1-3's
 * earlier cold-gen do the priming, breaking the "this scenario primes
 * a fresh row" guarantee.
 */

/**
 * Scenario 8 — cross-session same-contract cache hit (override path).
 */
export const BANNER_CONTRACT = {
  propsSpec: {
    description: 'banner props',
    properties: {
      title: {
        schema: { type: 'string' },
        required: true,
        description: 'banner heading',
      },
    },
  },
} as const;

export const BANNER_INTENT =
  'show a static welcome banner with the user-supplied title prop';

/**
 * Scenario 16 — cache admin: list, invalidate, re-prime. Unique
 * signature in the description so the row sits in its own
 * `(scope, kind, contractKey)` slot — never collides with scenario 8's
 * banner row.
 */
export const CACHE_ADMIN_CONTRACT = {
  propsSpec: {
    description: 'cache-admin scenario 16 — unique signature',
    properties: {
      message: {
        schema: { type: 'string' },
        required: true,
        description: 'banner message',
      },
    },
  },
} as const;

export const CACHE_ADMIN_INTENT = 'banner with a configurable message prop';

/**
 * Scenario 18 — warm path: pre-register via `ggui_ops_generate_blueprint`,
 * then handshake with the same contract under a PARAPHRASED intent
 * must return `origin: 'cache'` and the matched blueprint's codeHash.
 * Pure-display (no required props) so the push.accept path doesn't
 * need a `props` payload.
 */
export const WARM_PATH_CONTRACT = {
  propsSpec: {
    description: 'warm-path scenario 18 — unique signature',
    properties: {
      buildStatus: {
        schema: { type: 'string' },
        required: false,
        description: 'optional build-status string',
      },
    },
  },
} as const;

export const WARM_PATH_INTENT_CANONICAL =
  'a card that displays the current build status string';

export const WARM_PATH_INTENT_PARAPHRASED =
  'an info display showing where the build pipeline is at right now';

/**
 * Scenario 17 — cold path then cache: a first handshake misses
 * (cold), a push.override registers the blueprint under the literal
 * draft, then a second handshake with the same contract (different
 * intent prose) matches via the registry. Tests the full
 * handshake-time exact-key fast path end-to-end.
 */
export const COLD_PATH_CONTRACT = {
  propsSpec: {
    description: 'cold-path scenario 17 — unique signature',
    properties: {
      deployedAt: {
        schema: { type: 'string' },
        required: false,
        description: 'optional deployment timestamp string',
      },
    },
  },
} as const;

export const COLD_PATH_INTENT_CANONICAL =
  'a card showing when the latest deployment happened';

export const COLD_PATH_INTENT_PARAPHRASED =
  'an info display reporting the most recent release timestamp';
