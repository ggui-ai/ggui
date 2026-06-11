/**
 * `schema-version-handshake` fixture sub-module.
 *
 * Exercises the optional version-negotiation handshake (SPEC §12.2.2):
 *   - `SubscribePayload.supportedVersions` + `AckPayload.serverVersion`.
 *   - `UPGRADE_REQUIRED` error frame on mismatch per server's
 *     `versionPolicy` setting.
 *
 * Both fixtures declare `subscribe.supportedVersions: 'current'` —
 * the runner resolves the sentinel to the kit's compiled
 * `PROTOCOL_SCHEMA_VERSION`, so the catalog stays evergreen across
 * protocol version bumps (no stale version literals). `version-match`
 * grades BOTH halves of the happy path: the declared set is actually
 * transmitted, and the ack must advertise `serverVersion` equal to
 * the canonical (`expectedBehavior.serverVersion: 'current'`) — it is
 * NOT redundant with `bootstrap-success`, whose ack assertion is
 * versionless. `version-mismatch` grades the rejection half via the
 * `server-version-override` directive: the same 'current' declaration
 * excludes the override by construction, so only the override seam
 * can produce the rejection.
 */
import versionMatch from './version-match.json' with { type: 'json' };
import versionMismatch from './version-mismatch.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting the schema-version handshake (Protocol #3). */
export const schemaVersionHandshakeFixtures: readonly TestCase[] = [
  versionMatch as TestCase,
  versionMismatch as TestCase,
];
