/**
 * Reserved-channel replay (SPEC §12.2.1, ggui#1521, ggui#1526): what a
 * fresh subscribe replays. Agent-declared channels replay nothing
 * without `fromSeq` (invariant 1); known-reserved channels' retained
 * envelopes SHOULD be replayed after the ack, at `seq ≤ streamSeq`.
 * The case here is a SHOULD (`level: 'should'`): a server that declines
 * it is graded a warning.
 *
 * The runner dispatches setup before it subscribes, which is exactly
 * the order this obligation needs: the envelope is emitted before any
 * viewer is attached, so a frame observed after the subscribe can only
 * be the replay.
 */
import freshSubscribeReplaysReservedPreview from './fresh-subscribe-replays-reserved-preview.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting what a fresh subscribe replays (SPEC §12.2.1). */
export const reservedChannelReplayFixtures: readonly TestCase[] = [
  freshSubscribeReplaysReservedPreview as TestCase,
];
