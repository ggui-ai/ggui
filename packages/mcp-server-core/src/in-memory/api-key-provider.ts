/**
 * InMemoryApiKeyProvider — reference {@link ApiKeyProvider}
 * implementation. Ephemeral; tests + dev.
 *
 * Secrets are hashed at mint time with SHA-256; the hash is what
 * we retain. `verify` uses `timingSafeEqual` on the hash buffer to
 * avoid leaking timing information about which byte mismatched.
 * That's a low-effort win that the on-disk adapter keeps — callers
 * shouldn't have to reach for a different implementation just to
 * get constant-time comparison.
 *
 * Key id format: `ggui_sk_<8-byte random hex>`. The id IS the
 * token prefix — verify strips the prefix + hashes the tail.
 * Prefix lets operators spot ggui secrets in logs / credential
 * managers without needing an OIDC scope.
 */
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import type {
  ApiKey,
  ApiKeyProvider,
  MintApiKeyInput,
  MintedApiKey,
} from '../api-key-provider.js';

/** Public prefix on every minted secret. Visible in logs. */
const SECRET_PREFIX = 'ggui_sk_';
/** Random-bytes length for the tail (high-entropy suffix). */
const SECRET_TAIL_BYTES = 24;

interface StoredKey {
  record: ApiKey;
  /** SHA-256 of the full plaintext secret (prefix + tail). */
  secretHash: Buffer;
}

export interface InMemoryApiKeyProviderOptions {
  /** Clock. Defaults to `Date.now`. Inject for deterministic tests. */
  now?: () => number;
  /**
   * Id generator for the public `ApiKey.id`. Defaults to
   * `crypto.randomUUID`. Inject for deterministic tests.
   */
  generateId?: () => string;
  /**
   * Secret-tail generator — the random-bytes half of the token.
   * Defaults to `randomBytes(24).toString('hex')`. Inject for tests
   * that want deterministic secrets.
   */
  generateSecretTail?: () => string;
}

export class InMemoryApiKeyProvider implements ApiKeyProvider {
  private readonly byId = new Map<string, StoredKey>();
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly generateSecretTail: () => string;

  constructor(opts: InMemoryApiKeyProviderOptions = {}) {
    this.now = opts.now ?? Date.now;
    this.generateId = opts.generateId ?? (() => randomUUID());
    this.generateSecretTail =
      opts.generateSecretTail ??
      (() => randomBytes(SECRET_TAIL_BYTES).toString('hex'));
  }

  async mint(input: MintApiKeyInput): Promise<MintedApiKey> {
    const tail = this.generateSecretTail();
    const secret = `${SECRET_PREFIX}${tail}`;
    const record: ApiKey = {
      id: this.generateId(),
      appId: input.appId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt: this.now(),
    };
    this.byId.set(record.id, {
      record,
      secretHash: hashSecret(secret),
    });
    return { record: cloneRecord(record), secret };
  }

  async verify(secret: string): Promise<ApiKey | null> {
    if (!secret.startsWith(SECRET_PREFIX)) return null;
    const probe = hashSecret(secret);
    for (const stored of this.byId.values()) {
      if (constantTimeEqual(probe, stored.secretHash)) {
        stored.record.lastUsedAt = this.now();
        return cloneRecord(stored.record);
      }
    }
    return null;
  }

  async list(appId: string): Promise<ApiKey[]> {
    const out: ApiKey[] = [];
    for (const stored of this.byId.values()) {
      if (stored.record.appId === appId) {
        out.push(cloneRecord(stored.record));
      }
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return out;
  }

  async revoke(id: string): Promise<void> {
    this.byId.delete(id);
  }
}

function hashSecret(secret: string): Buffer {
  return createHash('sha256').update(secret, 'utf8').digest();
}

function constantTimeEqual(a: Buffer, b: Buffer): boolean {
  // timingSafeEqual requires same-length buffers; SHA-256 output is
  // always 32 bytes, so the length check is a belt-and-braces guard
  // rather than a real branch.
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function cloneRecord(r: ApiKey): ApiKey {
  return {
    id: r.id,
    appId: r.appId,
    ...(r.label !== undefined ? { label: r.label } : {}),
    createdAt: r.createdAt,
    ...(r.lastUsedAt !== undefined ? { lastUsedAt: r.lastUsedAt } : {}),
  };
}
