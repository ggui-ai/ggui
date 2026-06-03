import type { BlueprintSource } from '@ggui-ai/mcp-server-handlers';
import type { PortableBlueprint } from '@ggui-ai/protocol';
import { readPoolArtifact } from './pool-artifact.js';

/** Reads a seed-pool directory artifact (B2 OSS adapter). */
export class FileSystemBlueprintSource implements BlueprintSource {
  readonly label: string;
  constructor(private readonly dir: string) {
    this.label = `seed:${dir}`;
  }
  async loadAll(): Promise<readonly PortableBlueprint[]> {
    const { records, issues } = await readPoolArtifact(this.dir);
    for (const issue of issues) {
      // eslint-disable-next-line no-console -- operator-visible load warning
      console.warn(`[ggui] ${issue}`);
    }
    return records;
  }
}
