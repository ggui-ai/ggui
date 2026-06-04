/**
 * Typed error surface for the protocol-version handshake.
 *
 * Raised by first-party clients + servers when the handshake observes
 * a version mismatch:
 *
 *   - Server side: `SubscribePayload.supportedVersions` is present AND
 *     does not contain the server's `PROTOCOL_SCHEMA_VERSION`. The
 *     server emits an `{type: 'error'}` frame with `code:
 *     UPGRADE_REQUIRED`; first-party servers also surface this class
 *     to their own observability path so operators see the
 *     unsatisfied subscribe locally.
 *   - Client side: on ack receipt, `AckPayload.serverVersion` is
 *     present AND NOT in `CLIENT_SUPPORTED_VERSIONS`. The client
 *     instantiates this class and surfaces it to the caller via the
 *     render's `onError` hook.
 *
 * The class pins `.name === 'UpgradeRequiredError'` and `.code ===
 * UPGRADE_REQUIRED` so consumers can pattern-match without
 * string-sniffing the message — `UPGRADE_REQUIRED` is reachable via
 * a typed protocol-error surface, not just via raw string compares.
 *
 * Wire-shape coupling: the class carries the observed version(s) +
 * the receiver's known-accepted set so operators can diagnose without
 * additional context. The `code` property matches the wire value
 * emitted in `ErrorPayload.code` — symmetric by design.
 */
import { UPGRADE_REQUIRED } from '../version.js';

export interface UpgradeRequiredErrorOptions {
  /**
   * The version the peer declared on the wire. Server-side: the
   * client's `supportedVersions` entry or the full list. Client-side:
   * `AckPayload.serverVersion`.
   */
  readonly observedVersion?: string | readonly string[];
  /**
   * The receiver's accepted-versions set. Server-side: a singleton
   * `[PROTOCOL_SCHEMA_VERSION]`. Client-side: `CLIENT_SUPPORTED_VERSIONS`.
   */
  readonly acceptedVersions: readonly string[];
  /**
   * Which side observed the mismatch. Server-side emission sets
   * `'server'`; client-side surface sets `'client'`.
   */
  readonly observedBy: 'server' | 'client';
}

export class UpgradeRequiredError extends Error {
  /** Canonical `ErrorPayload.code` value. Symmetric with wire shape. */
  readonly code: typeof UPGRADE_REQUIRED = UPGRADE_REQUIRED;
  readonly observedVersion?: string | readonly string[];
  readonly acceptedVersions: readonly string[];
  readonly observedBy: 'server' | 'client';

  constructor(opts: UpgradeRequiredErrorOptions) {
    const observed =
      opts.observedVersion === undefined
        ? 'unknown'
        : Array.isArray(opts.observedVersion)
          ? (opts.observedVersion as readonly string[]).join(', ')
          : String(opts.observedVersion);
    const accepted = opts.acceptedVersions.join(', ');
    super(
      `UPGRADE_REQUIRED: ${opts.observedBy === 'server' ? 'client' : 'server'} ` +
        `speaks version '${observed}' which is not in the ${opts.observedBy === 'server' ? 'server' : 'client'}'s ` +
        `accepted set [${accepted}].`,
    );
    this.name = 'UpgradeRequiredError';
    if (opts.observedVersion !== undefined) {
      this.observedVersion = opts.observedVersion;
    }
    this.acceptedVersions = opts.acceptedVersions;
    this.observedBy = opts.observedBy;
  }
}
