/**
 * `canvas-mode-wire-shapes` fixture sub-module.
 *
 * Exercises the canvas-mode wire additions (protocol draft-2026-05-17):
 *
 *   - `GguiBootstrapMeta.canvasMode` — discriminator + mutual-exclusion
 *     with `stackItemId`. Canvas iframes are session-scoped; no pinned
 *     item.
 *   - `_ggui:lifecycle` reserved channel + `CanvasLifecyclePayload`
 *     discriminated union (`handshake_started` / `handshake_completed` /
 *     `push_started` / `consume_polling`). Server fires fire-and-forget;
 *     iframe animator advances state machine on each kind.
 *   - `canvas_navigated` C→S WS message — user back-navigated; server
 *     updates `Session.activeStackItemId`. Payload omits `appId` —
 *     subscriber binding is authoritative scope.
 *   - `host_context_observed` C→S WS message — iframe echoes
 *     `McpUiHostContext` so server persists `HostContextProjection` on
 *     the session.
 *
 * All four fixtures ship with `skipReason: null`: the kit does not
 * JSON-gate skip behavior. The runner dispatches every fixture and
 * per-fixture skips emerge at RUNTIME from the host adapter throwing
 * on an unimplemented setup directive (`set-app-mode`,
 * `assert-session-field`, `assert-channel-envelope`) or from
 * `match-behavior.ts` returning `unmatchable-on-ws`. Runner
 * activation against the reference `ConformanceHost` is a follow-up
 * kit minor once those directives land.
 *
 * Rationale: per the kit's drift discipline (see `../../types.ts`
 * "Authored protocol vocabulary"), fixtures freeze the contract intent
 * at the time the wire shape lands — not when the runner catches up.
 * Third-party host implementers can read these JSONs directly to
 * understand canvas-mode obligations without waiting for the reference
 * host's directive coverage.
 */
import canvasBootstrapMutualExclusion from './canvas-bootstrap-mutual-exclusion.json' with { type: 'json' };
import canvasLifecycleChannelEmitsHandshakeStarted from './canvas-lifecycle-channel-emits-handshake-started.json' with { type: 'json' };
import canvasNavigatedUpdatesActiveStackItem from './canvas-navigated-updates-active-stack-item.json' with { type: 'json' };
import hostContextObservedPersists from './host-context-observed-persists.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting canvas-mode wire shapes (protocol
 *  draft-2026-05-17). */
export const canvasModeWireShapesFixtures: readonly TestCase[] = [
  canvasBootstrapMutualExclusion as TestCase,
  canvasLifecycleChannelEmitsHandshakeStarted as TestCase,
  canvasNavigatedUpdatesActiveStackItem as TestCase,
  hostContextObservedPersists as TestCase,
];
