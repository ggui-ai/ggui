/**
 * `themeFileUploader` factory for `ggui serve`.
 *
 * Pairs with `createThemeWriter`: the upload route on the OSS server
 * writes a DTCG theme document to a file alongside `ggui.json`, then
 * calls the regular theme writer to point the manifest at that file.
 *
 * This factory ONLY handles the file-write half. The route ordering
 * (uploader → writer) is the server's responsibility — see
 * `mountDevtoolThemeRoutes` in `@ggui-ai/mcp-server`.
 *
 * Behavior:
 *
 *   - `filename` is gated upstream by the route (alphanumeric, `.json`
 *     suffix, no path separators, no reserved-name shadowing). We
 *     re-validate here as belt-and-braces — programmatic embedders
 *     that called the seam directly should also get a clear refusal
 *     rather than a silent path-traversal write.
 *   - The file is written into `dirname(manifestPath)`, atomically
 *     (`tmp` + `rename` + `fsync`) — same pattern the existing theme
 *     writer uses for `ggui.json`.
 *   - Content is serialised with 2-space indent and a trailing newline,
 *     matching the manifest's formatting so the operator's repo stays
 *     consistent.
 */
import { dirname, join } from 'node:path';
import { promises as fs } from 'node:fs';
import type { ThemeFileUploader } from '@ggui-ai/mcp-server';

const SAFE_FILENAME_RE = /^[a-zA-Z0-9._-]+\.json$/;
const FORBIDDEN_FILENAMES = new Set(['ggui.json', 'package.json']);

/**
 * Build a {@link ThemeFileUploader} bound to the directory holding
 * `manifestPath`. The returned function writes
 * `<dir>/<filename>` atomically. Idempotent for equal inputs.
 */
export function createThemeFileUploader(manifestPath: string): ThemeFileUploader {
  const projectDir = dirname(manifestPath);

  return async (filename: string, content: unknown): Promise<void> => {
    if (!SAFE_FILENAME_RE.test(filename)) {
      throw new Error(
        `themeFileUploader: filename must match /^[a-zA-Z0-9._-]+\\.json$/ — got ${JSON.stringify(filename)}`,
      );
    }
    if (FORBIDDEN_FILENAMES.has(filename)) {
      throw new Error(
        `themeFileUploader: filename "${filename}" would shadow a reserved file.`,
      );
    }

    const target = join(projectDir, filename);
    const next = `${JSON.stringify(content, null, 2)}\n`;

    const tmp = `${target}.tmp`;
    await fs.mkdir(projectDir, { recursive: true });
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(next, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, target);
  };
}
