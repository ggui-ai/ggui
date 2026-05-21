/**
 * `observability-events` fixture sub-module.
 *
 * Exercises the renderer's observability-event emission contract:
 * every wired-action dispatch emits a `wired-tool-invoked` event;
 * every `_ggui:contract-error` envelope emits a matching
 * `contract-error-emitted` event.
 *
 * Both fixtures are `ConformanceHost`-gated — the direct
 * postMessage-frame assertion requires a `page.exposeBinding` harness
 * hook that the runner supplies. The effects are asserted implicitly
 * via DOM state on the `wired-action-success` + contract-error
 * fixtures in `wired-action-dispatch/`.
 */
import observabilityContractErrorEmitted from './observability-contract-error-emitted.json' with { type: 'json' };
import observabilityWiredToolInvoked from './observability-wired-tool-invoked.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting the observability-event contract
 *  (SPEC §"Runtime Consequence Chain" Tier 3). */
export const observabilityEventsFixtures: readonly TestCase[] = [
  observabilityContractErrorEmitted as TestCase,
  observabilityWiredToolInvoked as TestCase,
];
