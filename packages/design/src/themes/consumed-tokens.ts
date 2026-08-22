/**
 * The consumed-token manifest as a typed export — the closed set of
 * `--ggui-*` variables generated component code actually consumes,
 * which registration coverage (ggui#598-C) validates against. The
 * JSON file stays the single source of truth; this module is its
 * typed doorway for composers wiring `validateThemeCoverage`.
 */
import manifest from './consumed-tokens.manifest.json' with { type: 'json' };

export const consumedTokenManifest: readonly string[] = manifest.tokens;
