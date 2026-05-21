/**
 * `schema-version-handshake` fixture sub-module.
 *
 * Exercises the optional version-negotiation handshake (SPEC §12.2.2):
 *   - `SubscribePayload.supportedVersions` + `AckPayload.serverVersion`.
 *   - `UPGRADE_REQUIRED` error frame on mismatch per server's
 *     `versionPolicy` setting.
 *
 * Two fixtures; `version-match` is redundant-by-design with
 * `bootstrap-success` on today's harness but authored distinctly so
 * a `ConformanceHost` can expose the handshake as a discrete
 * assertion slot.
 */
import versionMatch from './version-match.json' with { type: 'json' };
import versionMismatch from './version-mismatch.json' with { type: 'json' };

import type { TestCase } from '../../types.js';

/** All fixtures asserting the schema-version handshake (Protocol #3). */
export const schemaVersionHandshakeFixtures: readonly TestCase[] = [
  versionMatch as TestCase,
  versionMismatch as TestCase,
];
