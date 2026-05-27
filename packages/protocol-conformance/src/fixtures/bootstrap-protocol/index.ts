/**
 * `bootstrap-protocol` fixture sub-module.
 *
 * Exercises the MCP Apps bootstrap contract (SPEC §8):
 *   - `ui/initialize` tool-result must stamp the per-window
 *     `_meta["ai.ggui/render"]` slice with a well-formed payload.
 *   - Renderer-bundle fetch must succeed (or surface a typed
 *     `BOOTSTRAP_FAILURE` protocol error).
 *   - Happy-path boot reaches `data-ggui-code-ready="true"` with no
 *     error frames.
 *
 * Three fixtures today; `bootstrap-success` drives against the
 * current harness, the other two are `ConformanceHost`-gated.
 */
import bootstrapBundleFetchFailed from './bootstrap-bundle-fetch-failed.json' with { type: 'json' };
import bootstrapMetaMissing from './bootstrap-meta-missing.json' with { type: 'json' };
import bootstrapSuccess from './bootstrap-success.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting the bootstrap contract (Protocol #5 — named
 *  failure modes + SPEC §8 `McpAppAiGguiMeta`). */
export const bootstrapProtocolFixtures: readonly TestCase[] = [
  bootstrapBundleFetchFailed as TestCase,
  bootstrapMetaMissing as TestCase,
  bootstrapSuccess as TestCase,
];
