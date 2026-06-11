/**
 * `host-context` fixture sub-module.
 *
 * Exercises the host-context persistence obligation — the
 * `host_context_observed` Client→Server live-channel message defined
 * by `@ggui-ai/protocol` (`transport/websocket` union +
 * `types/host-context`'s `HostContextObservedPayload`, whose contract
 * is "server-side handler writes to `GguiSession.hostContext`"):
 *
 *   - `host-context-observed-persists` — the `HostContextProjection`
 *     the iframe echoes after `ui/initialize` MUST land on
 *     `GguiSession.hostContext` exactly as received (the projection /
 *     trimming step is iframe-side, BEFORE emission; the first-party
 *     server persists the received value verbatim, which is what the
 *     fixture's `expected` pins). A stateful obligation with no
 *     response frame — graded via the kit's session-state read-back
 *     mechanism (`ConformanceHost.readSessionField`); hosts without
 *     the introspection seam SKIP with a precise reason.
 *
 * Authoring note: the projection vocabulary is re-derived from the
 * live `HostContextProjection` — `currentDisplayMode` (NOT the
 * retired `displayMode` spelling) and NO `theme` field (theme flows
 * through ggui's theming pipeline, not host context). The runner's
 * input-envelope parser rejects unknown projection keys loudly, so a
 * stale-vocabulary fixture is a fixture-authoring error, never a
 * verdict on the implementation under test.
 *
 * Documentation-home note (declared, not hidden): the obligation's
 * normative text lives in `@ggui-ai/protocol`'s type declarations;
 * SPEC.md's §12.2 frame inventory does not yet list
 * `host_context_observed`. Per the protocol-and-contract bar, that
 * SPEC gap should close upstream — the wire type + persistence
 * contract graded here are the shipping source of truth.
 */
import hostContextObservedPersists from './host-context-observed-persists.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting host-context persistence
 *  (`host_context_observed` → `GguiSession.hostContext`). */
export const hostContextFixtures: readonly TestCase[] = [
  hostContextObservedPersists as TestCase,
];
