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
 * (declared-channel schema-violation rejection) land here as the
 * family grows — a kit minor version.
 *
 * ## Declared gap — the namesake MUST is not WS-gradable
 *
 * SPEC §4.4's headline obligation — the server REJECTS agent-authored
 * deliveries on `_ggui:*` reserved channels — cannot even be
 * ATTEMPTED over the channel-3 WebSocket: the Client→Server frame
 * vocabulary has no frame that authors a stream delivery (clients
 * subscribe, dispatch actions, and echo observations; `data` frames
 * are Server→Client only). Agent emission enters through the
 * `ggui_emit` MCP tool, so both the violation and the rejection that
 * grades it are observable only on the MCP binding. That fixture
 * belongs to a future MCP-binding driver — the gap is declared here
 * rather than faked with a frame the wire cannot carry.
 */
import propsUpdateRoundtrip from './props-update-roundtrip.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting reserved-channel authority (SPEC §4.4). */
export const reservedChannelAuthorityFixtures: readonly TestCase[] = [
  propsUpdateRoundtrip as TestCase,
];
