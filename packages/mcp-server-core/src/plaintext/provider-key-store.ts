/**
 * PlaintextFileProviderKeyStore — file-backed
 * {@link ProviderKeyStore} reference for the OSS personal-mode
 * path.
 *
 * On-disk shape — a single JSON document:
 *
 * ```json
 * {
 *   "version": 1,
 *   "apps": {
 *     "my-app": { "anthropic": "sk-ant-…", "openai": "sk-…" }
 *   }
 * }
 * ```
 *
 * Properties:
 *
 *   - **Plaintext.** Key material is stored unencrypted. Fine for
 *     a single-user workstation; not fine for shared hosts. The
 *     store creates the file with mode `0o600` (owner-only r/w) so
 *     the filesystem is the first line of defence.
 *   - **Synchronous writes.** Every mutating call re-writes the
 *     entire file via `writeFileSync` (atomic within the same FS).
 *     Acceptable because BYOK writes are rare operator actions, not
 *     hot-path.
 *   - **Auditable.** The JSON round-trips, so `cat .ggui-provider-
 *     keys.json` is a valid audit. Callers who need structured audit
 *     layer telemetry above the store.
 *
 * Not fit for:
 *   - Multi-user hosts (use OS keychain or a hosted KMS).
 *   - Concurrent writers across processes (no file locking).
 *   - Any deployment where `0o600` isn't meaningful.
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname } from 'node:path';
import type { LlmProvider, ProviderKeyRef } from '../ui-generator.js';
import type { ProviderKeyStore } from '../provider-key-store.js';

const FILE_VERSION = 1;
/** Owner-only read/write. File is reset to this mode on every save. */
const FILE_MODE = 0o600;

interface FileShape {
  version: 1;
  apps: Record<string, Partial<Record<LlmProvider, string>>>;
}

export interface PlaintextFileProviderKeyStoreOptions {
  /**
   * Absolute or relative path. The file will be created on first
   * write. Parent directory is created recursively if missing.
   */
  filename: string;
}

export class PlaintextFileProviderKeyStore implements ProviderKeyStore {
  private readonly filename: string;

  constructor(opts: PlaintextFileProviderKeyStoreOptions) {
    this.filename = opts.filename;
  }

  async get(
    appId: string,
    provider: LlmProvider,
  ): Promise<ProviderKeyRef | null> {
    const doc = this.readFile();
    const key = doc.apps[appId]?.[provider];
    if (key === undefined) return null;
    return { provider, key };
  }

  async set(
    appId: string,
    provider: LlmProvider,
    key: string,
  ): Promise<ProviderKeyRef> {
    const doc = this.readFile();
    if (!doc.apps[appId]) doc.apps[appId] = {};
    doc.apps[appId][provider] = key;
    this.writeFile(doc);
    return { provider, key };
  }

  async delete(appId: string, provider: LlmProvider): Promise<void> {
    const doc = this.readFile();
    const app = doc.apps[appId];
    if (!app) return;
    delete app[provider];
    if (Object.keys(app).length === 0) delete doc.apps[appId];
    this.writeFile(doc);
  }

  async listProviders(appId: string): Promise<LlmProvider[]> {
    const doc = this.readFile();
    const app = doc.apps[appId];
    if (!app) return [];
    return Object.keys(app).sort() as LlmProvider[];
  }

  private readFile(): FileShape {
    if (!existsSync(this.filename)) {
      return { version: FILE_VERSION, apps: {} };
    }
    const raw = readFileSync(this.filename, 'utf8');
    // Empty file is treated the same as missing — operators
    // occasionally `: > .ggui-provider-keys.json` to reset without
    // deleting. Don't blow up on that.
    if (raw.trim().length === 0) {
      return { version: FILE_VERSION, apps: {} };
    }
    const parsed = JSON.parse(raw) as unknown;
    if (!isFileShape(parsed)) {
      throw new Error(
        `PlaintextFileProviderKeyStore: file "${this.filename}" is not a valid v${FILE_VERSION} document. ` +
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
    // writeFileSync with mode only sets permissions on CREATE. If
    // the file already existed with different perms, force the
    // mode so operators can't accidentally widen access by touching
    // the file before us.
    try {
      chmodSync(this.filename, FILE_MODE);
    } catch {
      /* best-effort — e.g. Windows / non-POSIX file systems */
    }
  }
}

function isFileShape(x: unknown): x is FileShape {
  if (x === null || typeof x !== 'object') return false;
  const obj = x as Record<string, unknown>;
  if (obj.version !== FILE_VERSION) return false;
  if (obj.apps === null || typeof obj.apps !== 'object') return false;
  return true;
}
