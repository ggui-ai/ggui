/**
 * `reserved-channel-authority` fixture sub-module.
 *
 * Exercises the reserved-channel contract (SPEC §4.4 Reserved-channel
 * Authority):
 *   - Channel-0 `props_update` round-trips deliver new props and the
 *     iframe DOM reflects the update.
 *
 * One fixture today (`props-update-roundtrip`), `ConformanceHost`-gated
 * via direct envelope dispatch. Additional reserved-channel fixtures
 * (declared-channel schema-violation rejection, agent-authoring
 * rejection) land here as the family grows — a kit minor version.
 */
import propsUpdateRoundtrip from './props-update-roundtrip.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting reserved-channel authority (SPEC §4.4). */
export const reservedChannelAuthorityFixtures: readonly TestCase[] = [
  propsUpdateRoundtrip as TestCase,
];
