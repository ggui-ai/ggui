/**
 * PlaintextFileApiKeyProvider — file-backed {@link ApiKeyProvider}
 * for OSS personal-mode.
 *
 * On-disk shape — a single JSON document (hashes only, no
 * secrets):
 *
 * ```json
 * {
 *   "version": 1,
 *   "keys": [
 *     {
 *       "id": "…",
 *       "appId": "my-app",
 *       "label": "laptop agent",
 *       "createdAt": 1737288000000,
 *       "lastUsedAt": 1737289000000,
 *       "secretHash": "<64 hex chars — SHA-256>"
 *     }
 *   ]
 * }
 * ```
 *
 * Properties:
 *
 *   - **Hashes only.** Secrets never land on disk. A user who
 *     loses a secret mints a new key — there is no recovery path.
 *     The file is a revocation list + audit trail, not a vault.
 *   - **File mode 0o600.** Same defence-in-depth as the provider
 *     key store: even though hashes aren't secrets, the `lastUsedAt`
 *     and labels can leak usage patterns.
 *   - **Synchronous writes.** Mutating calls re-write the full
 *     file. Fine for the expected volume (mint/revoke are rare).
 *
 * For anything more — concurrent writers, network auditing, per-
 * key rate limits — bind a production `ApiKeyProvider` instead.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import {
  createHash,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';
import { dirname } from 'node:path';
import type {
  ApiKey,
  ApiKeyProvider,
  MintApiKeyInput,
  MintedApiKey,
} from '../api-key-provider.js';

const FILE_VERSION = 1;
const FILE_MODE = 0o600;
const SECRET_PREFIX = 'ggui_sk_';
const SECRET_TAIL_BYTES = 24;

interface FileRecord {
  id: string;
  appId: string;
  label?: string;
  createdAt: number;
  lastUsedAt?: number;
  /** Hex-encoded SHA-256 of the full plaintext secret. */
  secretHash: string;
}

interface FileShape {
  version: 1;
  keys: FileRecord[];
}

export interface PlaintextFileApiKeyProviderOptions {
  filename: string;
  /** Clock. Defaults to `Date.now`. */
  now?: () => number;
  /** Id generator. Defaults to `crypto.randomUUID`. */
  generateId?: () => string;
  /** Secret-tail generator. Defaults to `randomBytes(24).toString('hex')`. */
  generateSecretTail?: () => string;
}

export class PlaintextFileApiKeyProvider implements ApiKeyProvider {
  private readonly filename: string;
  private readonly now: () => number;
  private readonly generateId: () => string;
  private readonly generateSecretTail: () => string;

  constructor(opts: PlaintextFileApiKeyProviderOptions) {
    this.filename = opts.filename;
    this.now = opts.now ?? Date.now;
    this.generateId = opts.generateId ?? (() => randomUUID());
    this.generateSecretTail =
      opts.generateSecretTail ??
      (() => randomBytes(SECRET_TAIL_BYTES).toString('hex'));
  }

  async mint(input: MintApiKeyInput): Promise<MintedApiKey> {
    const tail = this.generateSecretTail();
    const secret = `${SECRET_PREFIX}${tail}`;
    const file = this.readFile();
    const record: ApiKey = {
      id: this.generateId(),
      appId: input.appId,
      ...(input.label !== undefined ? { label: input.label } : {}),
      createdAt: this.now(),
    };
    const fileRec: FileRecord = {
      id: record.id,
      appId: record.appId,
      ...(record.label !== undefined ? { label: record.label } : {}),
      createdAt: record.createdAt,
      secretHash: hashSecret(secret),
    };
    file.keys.push(fileRec);
    this.writeFile(file);
    return { record: { ...record }, secret };
  }

  async verify(secret: string): Promise<ApiKey | null> {
    if (!secret.startsWith(SECRET_PREFIX)) return null;
    const probeHex = hashSecret(secret);
    const probe = Buffer.from(probeHex, 'hex');
    const file = this.readFile();
    for (const rec of file.keys) {
      const stored = Buffer.from(rec.secretHash, 'hex');
      if (stored.length !== probe.length) continue;
      if (timingSafeEqual(stored, probe)) {
        rec.lastUsedAt = this.now();
        this.writeFile(file);
        return recordFromFile(rec);
      }
    }
    return null;
  }

  async list(appId: string): Promise<ApiKey[]> {
    const file = this.readFile();
    const out: ApiKey[] = [];
    for (const rec of file.keys) {
      if (rec.appId === appId) out.push(recordFromFile(rec));
    }
    out.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
    return out;
  }

  async revoke(id: string): Promise<void> {
    const file = this.readFile();
    const before = file.keys.length;
    file.keys = file.keys.filter((k) => k.id !== id);
    if (file.keys.length !== before) this.writeFile(file);
  }

  private readFile(): FileShape {
    if (!existsSync(this.filename)) {
      return { version: FILE_VERSION, keys: [] };
    }
    const raw = readFileSync(this.filename, 'utf8');
    if (raw.trim().length === 0) {
      return { version: FILE_VERSION, keys: [] };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isFileShape(parsed)) {
      throw new Error(
        `PlaintextFileApiKeyProvider: file "${this.filename}" is not a valid v${FILE_VERSION} document. ` +
          `Delete the file to reset or restore from backup.`,
      );
    }
    return parsed;
  }

  private writeFile(doc: FileShape): void {
    const dir = dirname(this.filename);
    if (dir && !existsSync(dir)) mkdirSync(dir, { recursive: true });
    const body = `${JSON.stringify(doc, null, 2)}\n`;
    writeFileSync(this.filename, body, { encoding: 'utf8', mode: FILE_MODE });
    try {
      chmodSync(this.filename, FILE_MODE);
    } catch {
      /* best-effort — non-POSIX filesystems */
    }
  }
}

function hashSecret(secret: string): string {
  return createHash('sha256').update(secret, 'utf8').digest('hex');
}

function recordFromFile(r: FileRecord): ApiKey {
  return {
    id: r.id,
    appId: r.appId,
    ...(r.label !== undefined ? { label: r.label } : {}),
    createdAt: r.createdAt,
    ...(r.lastUsedAt !== undefined ? { lastUsedAt: r.lastUsedAt } : {}),
  };
}

function isFileShape(x: unknown): x is FileShape {
  if (x === null || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (!Array.isArray(obj.keys)) return false;
  return true;
}
