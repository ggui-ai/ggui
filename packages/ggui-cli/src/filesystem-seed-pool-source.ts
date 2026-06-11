import type { SeedPoolSource } from '@ggui-ai/mcp-server-handlers';
import { readPoolArtifact } from './pool-artifact.js';

/**
 * Reads a seed-pool directory artifact (B2 OSS adapter). Records come
 * back raw/unvalidated — `buildSeedPool` runs each one through the
 * `fromPortableBlueprint` trust boundary.
 */
export class FileSystemSeedPoolSource implements SeedPoolSource {
  readonly label: string;
  constructor(private readonly dir: string) {
    this.label = `seed:${dir}`;
  }
  async loadAll(): Promise<readonly unknown[]> {
    const { records, issues } = await readPoolArtifact(this.dir);
    for (const issue of issues) {
      // eslint-disable-next-line no-console -- operator-visible load warning
      console.warn(`[ggui] ${issue}`);
    }
    return records;
  }
}
