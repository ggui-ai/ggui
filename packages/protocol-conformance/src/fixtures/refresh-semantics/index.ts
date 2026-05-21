/**
 * `refresh-semantics` fixture sub-module.
 *
 * Exercises stream-refresh contract:
 *   - Successful action → declared `streamSpec[channel].triggers` list
 *     triggers a refresh → new stream-update observed on the channel.
 *   - Failed action → refresh does NOT fire; stream state preserved.
 *
 * One fixture today (`stream-refresh-success`) driving through the
 * `todo-list` blueprint's DOM state. The direct stream-update channel
 * assertion is `ConformanceHost`-gated pending a channel-subscription
 * transport seam.
 */
import streamRefreshSuccess from './stream-refresh-success.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting refresh semantics (SPEC §2.3 StreamSpec +
 *  §4.4 Envelope Specification refresh triggers). */
export const refreshSemanticsFixtures: readonly TestCase[] = [
  streamRefreshSuccess as TestCase,
];
