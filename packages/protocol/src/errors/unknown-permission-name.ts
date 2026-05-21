/**
 * Typed error surface for SDK `requestPermission(name)` calls that pass
 * a permission name outside the Web Permissions API enum
 * (`KNOWN_PERMISSION_NAMES`).
 *
 * Background: the grant model lives on
 * `clientCapabilities.gadgets[*].permission`. Without a validation
 * gate, SDK callers (and LLM-generated component code) could request
 * arbitrary permission strings, including typos like `'geolocaiton'`
 * or unsupported names. This error is that gate.
 *
 * The class pins `.name === 'UnknownPermissionNameError'` so consumers
 * can pattern-match without sniffing the message string. Carries the
 * observed name + the accepted enum so operators can diagnose without
 * additional context.
 */
import { KNOWN_PERMISSION_NAMES } from '../validation/hygiene-rules.js';

export interface UnknownPermissionNameErrorOptions {
  /** The name the SDK caller passed to `requestPermission`. */
  readonly observedName: string;
}

export class UnknownPermissionNameError extends Error {
  /** The name the SDK caller passed. */
  readonly observedName: string;
  /** Accepted permission-name enum (Web Permissions API + MCP Apps mirror). */
  readonly acceptedNames: readonly string[] = KNOWN_PERMISSION_NAMES;

  constructor(opts: UnknownPermissionNameErrorOptions) {
    super(
      `Unknown permission name '${opts.observedName}'. ` +
        `Pick a name from the Web Permissions API enum: [${KNOWN_PERMISSION_NAMES.join(
          ', ',
        )}].`,
    );
    this.name = 'UnknownPermissionNameError';
    this.observedName = opts.observedName;
  }
}
