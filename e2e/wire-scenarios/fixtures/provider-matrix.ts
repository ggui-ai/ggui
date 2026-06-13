/**
 * Provider matrix fixture for scenarios that drive the ggui server's
 * own cold-gen (no agent SDK in the loop). Each `ProviderRow` points
 * at a `ggui-default-<provider>` instance spawned by global-setup
 * with that provider's API key only — so the CLI's boot-time provider
 * scan locks each instance to a specific upstream LLM family.
 *
 * Scenarios use this by replacing their hard-coded `GGUI_PORT` /
 * `MCP_URL` / `HAS_KEY` constants with a `for (const provider of
 * PROVIDERS)` wrap around `describe`. Each row skips cleanly when its
 * key is missing — unless `GGUI_E2E_REQUIRE_ALL_PROVIDERS=1` is set,
 * which flips skip → hard-fail so the label-gated CI path catches
 * a missing credential explicitly.
 *
 * Port mapping mirrors the entries in `fixtures/global-setup.ts`:
 *   anthropic → 6781 (existing ggui-default)
 *   openai    → 6787 (ggui-default-openai)
 *   google    → 6788 (ggui-default-google)
 */
export interface ProviderRow {
  /** Human-readable label used in describe-block names. */
  readonly name: 'anthropic' | 'openai' | 'google';
  /** Port of the matching ggui-default-<provider> instance. */
  readonly port: number;
  /** Pre-formatted MCP endpoint for the matching instance. */
  readonly mcpUrl: string;
  /** API key env var required for this provider's cold-gen path. */
  readonly apiKey: 'ANTHROPIC_API_KEY' | 'OPENAI_API_KEY' | 'GEMINI_API_KEY';
}

const ANTHROPIC_PORT = Number.parseInt(process.env.GGUI_PORT ?? '6781', 10);
const OPENAI_PORT = Number.parseInt(process.env.GGUI_OPENAI_PORT ?? '6787', 10);
const GOOGLE_PORT = Number.parseInt(process.env.GGUI_GOOGLE_PORT ?? '6788', 10);

export const PROVIDERS: readonly ProviderRow[] = [
  {
    name: 'anthropic',
    port: ANTHROPIC_PORT,
    mcpUrl: `http://localhost:${ANTHROPIC_PORT}/mcp`,
    apiKey: 'ANTHROPIC_API_KEY',
  },
  {
    name: 'openai',
    port: OPENAI_PORT,
    mcpUrl: `http://localhost:${OPENAI_PORT}/mcp`,
    apiKey: 'OPENAI_API_KEY',
  },
  {
    name: 'google',
    port: GOOGLE_PORT,
    mcpUrl: `http://localhost:${GOOGLE_PORT}/mcp`,
    apiKey: 'GEMINI_API_KEY',
  },
];

/**
 * When set (`GGUI_E2E_REQUIRE_ALL_PROVIDERS=1`), the matrix tests
 * fail loudly on a missing provider key instead of silently skipping.
 * Wired by the label-gated CI workflow (`run-all-providers` PR label
 * or nightly run) so cross-provider regressions can't sneak past on
 * a "skipped" status.
 */
export const REQUIRE_ALL =
  process.env.GGUI_E2E_REQUIRE_ALL_PROVIDERS === '1';

/**
 * `describe.skipIf` predicate. Returns true when the row should skip.
 *
 * Two distinct postures, because the shared `e2e` GitHub environment
 * carries ALL THREE provider keys on every trigger (it is the same
 * environment cloud-scenarios uses) — key-presence alone can't be the
 * per-push gate, or the cross-provider rows fire on every push and the
 * documented "per-push runs anthropic only" intent is defeated:
 *
 *   - **anthropic** is the per-push baseline. It runs whenever its key
 *     resolves (REQUIRE_ALL has no bearing) — the always-on smoke row.
 *   - **openai / google** are cross-provider rows. They run ONLY under
 *     REQUIRE_ALL (the `run-all-providers` PR label or the nightly
 *     schedule). On an unlabeled per-push they skip even though their
 *     key is present in the shared environment. This keeps per-push
 *     green on anthropic alone while preserving the labeled/nightly
 *     cross-provider matrix — and is robust to whichever keys the
 *     environment happens to expose.
 *
 * When a row DOES run, the per-spec `!hasKey` guard still hard-fails it
 * if REQUIRE_ALL is on but the key turns out absent, so a genuinely
 * missing credential on the labeled/nightly path is loud, not silent.
 */
export function providerSkip(row: ProviderRow): boolean {
  // Anthropic baseline: gated purely on its own key, on every trigger.
  if (row.name === 'anthropic') {
    return !process.env[row.apiKey];
  }
  // Cross-provider rows: only when REQUIRE_ALL (labeled PR / nightly).
  return !REQUIRE_ALL;
}
