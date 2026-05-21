/**
 * InMemoryPairingService — reference implementation of {@link PairingService}.
 *
 * Protocol (§4 of the OSS split plan):
 *   - `initPairing()` mints a 6-digit code valid for ~10 minutes, one-shot.
 *   - `completePairing({code, deviceName})` consumes the code, mints a
 *     long-lived bearer token, and persists a {@link Pairing} record.
 *   - `listPairings()` / `revokePairing(id)` manage the persisted records.
 *
 * The service is intentionally decoupled from the auth adapter. Pass the
 * optional `onTokenIssued` / `onTokenRevoked` callbacks to compose with
 * an {@link InMemoryAuthAdapter} (or any other store): the pairing
 * service calls the callback with the minted/revoked token so the auth
 * adapter can register it without this package depending on an
 * adapter-shape it doesn't own.
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type {
  CompletePairingInput,
  Pairing,
  PairingCompletion,
  PairingInit,
  PairingService,
  PairingWithToken,
} from '../pairing.js';

export interface InMemoryPairingServiceOptions {
  /** Human-readable server name (e.g. "my-ggui @ homelab"). Required. */
  serverName: string;
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /** Code TTL. Defaults to 10 minutes per the plan. */
  codeTtlMs?: number;
  /**
   * Pairing-code generator. Defaults to a 6-digit zero-padded integer.
   * Injected for tests that need deterministic codes.
   */
  generateCode?: () => string;
  /**
   * Pairing-id + token generator. The pairing id is public (shown in the
   * "paired devices" list); the token is a capability secret.
   *
   * The default `generateId` is a `Math.random`-seeded string — callers
   * that need cryptographic strength should inject {@link crypto.randomUUID}
   * or similar.
   *
   * The default `generateToken` mints `ggui_user_<12 base64url chars>`
   * (10 prefix + 12 random suffix = 22 chars total) using
   * `crypto.randomBytes(9)`. This matches the production
   * `ApiKeyAuthAdapter` token shape, so the OAuth consent placeholder
   * "ggui_user_*" is honest in dev/OSS too. Override for deterministic
   * tests.
   */
  generateId?: () => string;
  generateToken?: () => string;
  /**
   * Called after a token is issued in {@link completePairing}. Use this
   * to register the token into your auth adapter / token store.
   */
  onTokenIssued?: (token: string, pairing: Pairing) => void;
  /**
   * Called after a token is revoked in {@link revokePairing}. Use this
   * to remove the token from your auth adapter / token store.
   */
  onTokenRevoked?: (token: string, pairing: Pairing) => void;
  /**
   * Optional path to a JSON file backing the pairings map. When set:
   *   - On construction: the file is read (if present); each restored
   *     pairing replays `onTokenIssued` so a bridged auth adapter
   *     re-populates correctly. `idCounter` is bumped past the highest
   *     restored id so freshly minted pairings don't collide.
   *   - After every `completePairing` / `revokePairing`: the full state
   *     is rewritten atomically (temp + rename) with `0600` perms.
   *
   * Tokens are stored **in plaintext** at this path. The threat model
   * is single-operator local-host: the file lives on disk the operator
   * controls, same posture as `~/.ssh/known_hosts` / `~/.npmrc`. Set
   * `chmod 600` perms (we do this on write); use FS-level encryption
   * if you need defense-in-depth. For multi-operator / hosted
   * deployments, swap to a hashed adapter (cloud's `ApiKeyAuthAdapter`)
   * — this in-memory + file-backed pair is a reference impl for the
   * personal-mode self-host case.
   *
   * The pending pairing code (single-shot, ~10min TTL) is **not**
   * persisted — it's ephemeral and a restart-after-init failure mode
   * is acceptable (operator just runs `initPairing()` again).
   */
  persistencePath?: string;
}

interface PersistedState {
  /** Schema version for forward compat. Bump on breaking changes. */
  v: 1;
  pairings: Array<{
    pairingId: string;
    deviceName: string;
    createdAt: number;
    lastUsedAt?: number;
    lastRemoteAddress?: string;
    token: string;
  }>;
  idCounter: number;
}

interface CodeEntry {
  code: string;
  expiresAt: number;
}

interface PairingEntry {
  pairing: Pairing;
  token: string;
}

export class InMemoryPairingService implements PairingService {
  private readonly serverName: string;
  private readonly now: () => number;
  private readonly codeTtlMs: number;
  private readonly generateCode: () => string;
  private readonly generateId: () => string;
  private readonly generateToken: () => string;
  private readonly onTokenIssued?: InMemoryPairingServiceOptions['onTokenIssued'];
  private readonly onTokenRevoked?: InMemoryPairingServiceOptions['onTokenRevoked'];
  private readonly persistencePath: string | null;

  /** At most one outstanding code at a time — initPairing overwrites. */
  private pendingCode: CodeEntry | null = null;
  private readonly pairings = new Map<string, PairingEntry>();
  private idCounter = 0;

  constructor(opts: InMemoryPairingServiceOptions) {
    this.serverName = opts.serverName;
    this.now = opts.now ?? Date.now;
    this.codeTtlMs = opts.codeTtlMs ?? 10 * 60 * 1000;
    this.generateCode = opts.generateCode ?? defaultCodeGenerator;
    this.generateId = opts.generateId ?? (() => `pair-${++this.idCounter}`);
    this.generateToken = opts.generateToken ?? defaultTokenGenerator;
    this.onTokenIssued = opts.onTokenIssued;
    this.onTokenRevoked = opts.onTokenRevoked;
    this.persistencePath = opts.persistencePath ?? null;
    this.restoreFromDisk();
  }

  /**
   * On boot, read the persistence file (if configured + present), seed
   * `pairings` + `idCounter`, and replay `onTokenIssued` for each token
   * so any bridged auth adapter (e.g. {@link InMemoryAuthAdapter}) ends
   * up with the same set of active tokens it had before the restart.
   *
   * Failure modes:
   *   - File missing → no-op (first boot).
   *   - File empty → no-op (treated as missing).
   *   - Malformed JSON / wrong schema → throw. Loud failure beats silent
   *     credential loss; the operator can fix the file by hand or
   *     delete it to start fresh.
   */
  private restoreFromDisk(): void {
    if (!this.persistencePath) return;
    if (!existsSync(this.persistencePath)) return;
    const raw = readFileSync(this.persistencePath, 'utf8');
    if (raw.trim().length === 0) return;
    const state = JSON.parse(raw) as PersistedState;
    if (state.v !== 1) {
      throw new Error(
        `InMemoryPairingService: unsupported persistence schema v=${String(state.v)} at ${this.persistencePath} (expected v=1).`,
      );
    }
    for (const row of state.pairings) {
      const pairing: Pairing = {
        pairingId: row.pairingId,
        deviceName: row.deviceName,
        createdAt: row.createdAt,
        ...(row.lastUsedAt !== undefined ? { lastUsedAt: row.lastUsedAt } : {}),
        ...(row.lastRemoteAddress !== undefined
          ? { lastRemoteAddress: row.lastRemoteAddress }
          : {}),
      };
      this.pairings.set(row.pairingId, { pairing, token: row.token });
      this.onTokenIssued?.(row.token, { ...pairing });
    }
    this.idCounter = state.idCounter;
  }

  /**
   * Atomically rewrite the persistence file with the current state.
   * Uses temp-file + rename so a crash mid-write can't leave the file
   * truncated. Sets `0600` on the final path — operator-only.
   *
   * Synchronous: pairings are infrequent (humans clicking "pair"), file
   * is tiny (~1 KB per entry), and the alternative async fence here
   * complicates `completePairing` / `revokePairing` semantics for no
   * practical throughput gain.
   */
  private persistToDisk(): void {
    if (!this.persistencePath) return;
    const state: PersistedState = {
      v: 1,
      idCounter: this.idCounter,
      pairings: Array.from(this.pairings.values()).map((entry) => ({
        pairingId: entry.pairing.pairingId,
        deviceName: entry.pairing.deviceName,
        createdAt: entry.pairing.createdAt,
        ...(entry.pairing.lastUsedAt !== undefined
          ? { lastUsedAt: entry.pairing.lastUsedAt }
          : {}),
        ...(entry.pairing.lastRemoteAddress !== undefined
          ? { lastRemoteAddress: entry.pairing.lastRemoteAddress }
          : {}),
        token: entry.token,
      })),
    };
    const dir = dirname(this.persistencePath);
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${this.persistencePath}.tmp.${process.pid}`;
    const fd = openSync(tmp, 'w', 0o600);
    try {
      writeSync(fd, JSON.stringify(state, null, 2));
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(tmp, this.persistencePath);
      chmodSync(this.persistencePath, 0o600);
    } catch (err) {
      // Best-effort: clean up the temp on failure so we don't accumulate
      // stale `.tmp.<pid>` files.
      try {
        unlinkSync(tmp);
      } catch {
        /* swallow — original error is more important */
      }
      throw err;
    }
  }

  async initPairing(): Promise<PairingInit> {
    const code = this.generateCode();
    const codeExpiresAt = this.now() + this.codeTtlMs;
    this.pendingCode = { code, expiresAt: codeExpiresAt };
    return { code, codeExpiresAt, serverName: this.serverName };
  }

  async activeInit(): Promise<PairingInit | null> {
    const pending = this.pendingCode;
    if (!pending) return null;
    // Expired codes behave as absent — and we proactively drop them
    // so subsequent reads don't re-check the same dead entry. Mirrors
    // `completePairing`'s expiry handling so the two callers see
    // consistent state.
    if (pending.expiresAt <= this.now()) {
      this.pendingCode = null;
      return null;
    }
    return {
      code: pending.code,
      codeExpiresAt: pending.expiresAt,
      serverName: this.serverName,
    };
  }

  async completePairing(input: CompletePairingInput): Promise<PairingCompletion> {
    const pending = this.pendingCode;
    if (!pending) {
      throw new Error('InMemoryPairingService.completePairing: no pending code');
    }
    if (pending.expiresAt <= this.now()) {
      this.pendingCode = null;
      throw new Error('InMemoryPairingService.completePairing: code expired');
    }
    if (pending.code !== input.code) {
      throw new Error('InMemoryPairingService.completePairing: code mismatch');
    }
    // One-shot: consume the code immediately.
    this.pendingCode = null;

    const pairingId = this.generateId();
    const token = this.generateToken();
    const pairing: Pairing = {
      pairingId,
      deviceName: input.deviceName,
      createdAt: this.now(),
      ...(input.remoteAddress ? { lastRemoteAddress: input.remoteAddress } : {}),
    };
    this.pairings.set(pairingId, { pairing, token });
    this.persistToDisk();
    this.onTokenIssued?.(token, { ...pairing });

    return {
      pairingId,
      token,
      serverName: this.serverName,
      deviceName: input.deviceName,
    };
  }

  async listPairings(): Promise<Pairing[]> {
    return Array.from(this.pairings.values())
      .map((e) => ({ ...e.pairing }))
      .sort((a, b) => a.createdAt - b.createdAt || a.pairingId.localeCompare(b.pairingId));
  }

  async listPairingsWithTokens(): Promise<PairingWithToken[]> {
    // Plaintext exposure is intentional — same threat model as the
    // `persistencePath` JSON file. See the type's JSDoc for the
    // operator-only consumer (console `/keys` page).
    return Array.from(this.pairings.values())
      .map((e) => ({ ...e.pairing, token: e.token }))
      .sort(
        (a, b) =>
          a.createdAt - b.createdAt || a.pairingId.localeCompare(b.pairingId),
      );
  }

  async revokePairing(pairingId: string): Promise<void> {
    const entry = this.pairings.get(pairingId);
    if (!entry) return; // idempotent
    this.pairings.delete(pairingId);
    this.persistToDisk();
    this.onTokenRevoked?.(entry.token, { ...entry.pairing });
  }
}

function defaultCodeGenerator(): string {
  // 6-digit zero-padded. Math.random is adequate for a ref impl;
  // production bindings MUST use crypto.getRandomValues or equivalent.
  const n = Math.floor(Math.random() * 1_000_000);
  return n.toString().padStart(6, '0');
}

/**
 * Default token shape: `ggui_user_<12 base64url chars>`.
 *
 * 9 raw bytes encoded as base64url yields exactly 12 chars with no
 * padding (9 * 8 = 72 bits = 12 * 6). Total length: 22 chars
 * (10 for the literal `ggui_user_` prefix + 12 random suffix).
 *
 * Matches the production `ApiKeyAuthAdapter` mint shape so tokens
 * minted by the OSS in-memory path are indistinguishable in form
 * from cloud-minted ones — the OAuth consent placeholder
 * "ggui_user_*" is therefore honest in every path.
 */
function defaultTokenGenerator(): string {
  return `ggui_user_${randomBytes(9).toString('base64url')}`;
}
