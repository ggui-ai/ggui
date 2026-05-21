/**
 * `reserved-channel-authority` fixture sub-module.
 *
 * Exercises the reserved-channel contract (SPEC §4.4 Reserved-channel
 * Authority):
 *   - Declared-channel schema violations surface as
 *     `_ggui:contract-error` envelopes with `SCHEMA_VIOLATION` code.
 *   - Channel-0 `props_update` round-trips deliver new props and the
 *     iframe DOM reflects the update.
 *
 * Both fixtures are `ConformanceHost`-gated — `stream-schema-
 * violation` drives via malformed-tool setup, `props-update-roundtrip`
 * via direct envelope dispatch.
 */
import propsUpdateRoundtrip from './props-update-roundtrip.json' with { type: 'json' };
import streamSchemaViolation from './stream-schema-violation.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting reserved-channel authority (SPEC §4.4). */
export const reservedChannelAuthorityFixtures: readonly TestCase[] = [
  propsUpdateRoundtrip as TestCase,
  streamSchemaViolation as TestCase,
];
