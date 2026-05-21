/**
 * Pairing protocol — viewer ↔ server bluetooth-style handshake.
 *
 * No hosted-runtime account required. Works over LAN, tunnel, or
 * public URL. Trust flows from the user having access to both the
 * viewer and the server — not from a central identity authority.
 *
 * Flow:
 *   1. `ggui dev` prints a 6-digit code + QR (code valid ~10 min, one-shot).
 *   2. User enters the server URL + code in any compatible client.
 *   3. Client POSTs { code } to server `/pair` → receives a long-lived token.
 *   4. Client stores { serverUrl, token }; server stores pairing metadata.
 */

/**
 * Result of initiating a pairing from the server side. The server shows this
 * to the builder (CLI output, server-settings UI) so they can type the code
 * into their viewer.
 */
export interface PairingInit {
  /** One-shot pairing code — 6 digits or 8 alphanumeric chars. */
  code: string;
  /** Epoch-ms expiry. Default: now + 10 minutes. */
  codeExpiresAt: number;
  /** Server-side display name (e.g. "my-ggui @ homelab"). */
  serverName: string;
}

/**
 * Result of completing a pairing from the client side. The viewer stores the
 * returned `token` and uses it as a Bearer for all subsequent requests.
 */
export interface PairingCompletion {
  pairingId: string;
  /** Long-lived bearer token. No refresh flow at v1. */
  token: string;
  serverName: string;
  /** Device label the server will show in its pairings list. */
  deviceName: string;
}

/**
 * Persisted pairing record (server-side view).
 */
export interface Pairing {
  pairingId: string;
  /** Human-friendly label the user assigned (e.g. "iPhone 15"). */
  deviceName: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Last remote address that presented the token. Optional; privacy. */
  lastRemoteAddress?: string;
}

/**
 * Pairing record + the plaintext bearer token the service has on disk
 * for the same pairing. Used by the OSS console `/keys` page so the
 * operator can copy a paired bearer back into an MCP client without
 * grepping the persistence file by hand.
 *
 * Threat model: identical to {@link InMemoryPairingServiceOptions}
 * `persistencePath` — single-operator local-host. The file is on disk
 * the operator already controls; surfacing the same plaintext through
 * a same-origin admin-gated route is a UX, not a posture, change.
 *
 * Implementations that do NOT have plaintext access (hashed token
 * stores, KMS-wrapped backends) MAY return `token: null` for those
 * rows; the console renders "rotated — re-pair to recover" rather
 * than a copy affordance. Default in-memory + file impl always returns
 * the plaintext.
 */
export interface PairingWithToken extends Pairing {
  /** Plaintext bearer minted at completion time. `null` when the
   * implementation no longer has it (hashed / KMS-backed). */
  readonly token: string | null;
}

/**
 * Input for completing a pairing on the server side.
 */
export interface CompletePairingInput {
  code: string;
  /** Device label supplied by the viewer at completion time. */
  deviceName: string;
  /** Remote address for initial audit. Optional. */
  remoteAddress?: string;
}

/**
 * The contract — implemented by the server.
 *
 * - **Full owner access at v1.** Every pairing grants full builder identity.
 *   Per-pairing scopes (`scope: 'read'`) are a post-v1 extension that can
 *   land without breaking compat because the default scope is `owner`.
 * - **Revocable.** Builders can revoke individual pairings from the CLI or
 *   console. Revocation is immediate — subsequent requests with the
 *   token must be rejected.
 */
export interface PairingService {
  /** Mint a one-shot pairing code. Called by the builder (CLI or UI). */
  initPairing(): Promise<PairingInit>;

  /**
   * Read the currently pending pairing init, or `null` when none is
   * active. Implementations MUST treat expired codes as absent — a
   * caller that asks "is there a pending code?" never wants to see
   * one that has already aged past `codeExpiresAt`.
   *
   * Consumed by the console landing page (via
   * `GET /ggui/console/info`) so operators can read the pair
   * code from their browser without tailing CLI output. Read-only
   * — MUST NOT consume or mutate the pending state.
   *
   * At most one pairing code is active at a time; `initPairing()`
   * always overwrites any prior pending code, so `activeInit()`
   * naturally returns the most recent one.
   */
  activeInit(): Promise<PairingInit | null>;

  /** Complete pairing with a code. Called by the viewer client. */
  completePairing(input: CompletePairingInput): Promise<PairingCompletion>;

  /** List all active pairings for the builder's server. */
  listPairings(): Promise<Pairing[]>;

  /**
   * List pairings WITH the plaintext bearer token, for operator-only
   * surfaces (the OSS console `/keys` page). Same threat model as the
   * `persistencePath` JSON file: the operator already has plaintext
   * access on disk, this route just renders it.
   *
   * Implementations without plaintext access (hashed stores) MUST
   * return rows with `token: null` rather than throw — the console
   * renders a "rotated — re-pair to recover" cell in that case.
   */
  listPairingsWithTokens(): Promise<PairingWithToken[]>;

  /** Revoke a pairing. Idempotent — revoking a non-existent id is not an error. */
  revokePairing(pairingId: string): Promise<void>;
}
