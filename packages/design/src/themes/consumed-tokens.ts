/**
 * The consumed-token manifest as a typed export — the closed set of
 * `--ggui-*` variables generated component code actually consumes,
 * which registration coverage (ggui#598-C) validates against. The
 * JSON file stays the single source of truth; this module is its
 * typed doorway for composers wiring `validateOverlayCoverage` (ggui#987 §3.4).
 */
// GROWTH RULE (ggui#1184, VERSION-POLICY §3.6): this manifest is a WIRE. A client pinned to the
// previous release projects exactly that release's manifest and this release's door judges
// coverage against today's — so a token may be ADDED only with a completion rule in
// `completeThemeVariables` (it fills from what a previous projection carries) or a floor entry in
// `NON_THEME_DEFINABLE_TOKENS`. `__fixtures__/consumed-tokens.manifest.release-<N-1>.json` is the
// previous release's manifest verbatim; `validate-overlay-coverage.test.ts` refuses a growth that
// does neither, and the fixture is re-pinned at each release cut.
import manifest from './consumed-tokens.manifest.json' with { type: 'json' };

export const consumedTokenManifest: readonly string[] = manifest.tokens;
