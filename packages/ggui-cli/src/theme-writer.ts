/**
 * `themeWriter` factory for `ggui serve`.
 *
 * The OSS server (`@ggui-ai/mcp-server`) defines a `ThemeWriter` seam
 * but never touches the filesystem itself — it only knows the shape it
 * wants to persist (`ThemeConfig | null`). The CLI plugs in the side
 * that knows where `ggui.json` lives.
 *
 * Behavior:
 *
 *   - Read the existing `ggui.json`.
 *   - Parse as JSON. Refuse on malformed input — we will not paper over
 *     a manifest the CLI can't round-trip safely.
 *   - Mutate exactly the `theme` field (`null` argument removes it
 *     entirely so the manifest falls back to the default-theme branch).
 *   - Write back atomically (`tmp` + `rename`) with 2-space indent,
 *     trailing newline. All other fields are preserved verbatim — this
 *     is a JSON round-trip, NOT a re-serialize-from-schema, so unknown
 *     fields the operator added (forward-compat schema, custom
 *     extensions) survive a Save.
 *
 * What v1 does NOT preserve:
 *
 *   - JSON5-style comments (the schema doesn't allow them but operators
 *     occasionally have a fork that does).
 *   - Original indentation (always rewritten to 2-space).
 *   - Trailing-comma tolerance (JSON.parse already rejects, so the
 *     refusal is upstream of us).
 *
 * Operators who need comment-preserving edits should hand-edit the
 * file; the picker is a write-through path for the common case.
 *
 * Validation: `ThemeConfig` was already validated upstream by
 * `mountDevtoolThemeRoutes` (Zod safeParse against `ThemeConfigSchema`)
 * before reaching the writer. We re-do the type-narrow shape check on
 * the resulting object purely so a programmatic embedder that called
 * `themeWriter` directly with a malformed value gets a 400-equivalent
 * `Error` instead of writing nonsense to disk.
 */
import { dirname } from 'node:path';
import { promises as fs } from 'node:fs';
import {
  ThemeConfigSchema,
  type ThemeConfig,
} from '@ggui-ai/project-config';
import type { ThemeWriter } from '@ggui-ai/mcp-server';

/**
 * Build a {@link ThemeWriter} bound to the manifest at `manifestPath`.
 * The returned function is async, idempotent for equal inputs, and
 * crash-safe via a `tmp` + `rename` write.
 */
export function createThemeWriter(manifestPath: string): ThemeWriter {
  return async (config: ThemeConfig | null): Promise<void> => {
    if (config !== null) {
      // Belt-and-braces re-validate. The server's transport already
      // does this, but the seam is public — any consumer that reaches
      // it directly should still get a clear refusal rather than a
      // silent shape leak into ggui.json.
      const result = ThemeConfigSchema.safeParse(config);
      if (!result.success) {
        throw new Error(
          `themeWriter: invalid ThemeConfig — ${JSON.stringify(result.error.flatten())}`,
        );
      }
    }

    let raw: string;
    try {
      raw = await fs.readFile(manifestPath, 'utf-8');
    } catch (err) {
      // ENOENT = the manifest disappeared between server boot and
      // first save. Surface clearly so the operator sees the cause
      // instead of a silent data-loss-by-creation.
      throw new Error(
        `themeWriter: failed to read ${manifestPath} — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    let parsed: Record<string, unknown>;
    try {
      const json: unknown = JSON.parse(raw);
      if (typeof json !== 'object' || json === null || Array.isArray(json)) {
        throw new Error('manifest is not a JSON object');
      }
      parsed = json as Record<string, unknown>;
    } catch (err) {
      throw new Error(
        `themeWriter: ${manifestPath} is not parseable JSON — ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    if (config === null) {
      delete parsed['theme'];
    } else {
      parsed['theme'] = config;
    }

    const next = `${JSON.stringify(parsed, null, 2)}\n`;

    // Atomic write via tmp + rename — same pattern as
    // `oauth-providers-store::writeFileShape`. A crash mid-write leaves
    // the original `ggui.json` intact.
    const tmp = `${manifestPath}.tmp`;
    await fs.mkdir(dirname(manifestPath), { recursive: true });
    const handle = await fs.open(tmp, 'w');
    try {
      await handle.writeFile(next, 'utf-8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tmp, manifestPath);
  };
}
