/**
 * `@ggui-ai/project-config` — root barrel (browser-safe).
 *
 * Exports the v1 `ggui.json` schema + pure parsers. These carry no
 * Node dependencies and can be imported from browser code (e.g.,
 * paste-a-manifest validators, dev UIs).
 *
 * Filesystem helpers live on the `./node` subpath. See that module
 * for `findGguiJson` / `loadGguiJson` / `saveGguiJson` / related
 * types.
 */
export * from './schema.js';
export * from './ui-manifest.js';
export * from './primitives-manifest.js';
export * from './theme.js';
