/**
 * App-discovery handler family — per-app metadata lookups.
 *
 * This subpath holds tools that surface runtime, per-app state (vs.
 * the static spec/discovery `ggui_protocol_*` family in
 * `blueprints/`).
 *
 *   - `createGguiListGadgetsHandler` — `ggui_list_gadgets`
 *     returns the app's `gadgets` catalog (stdlib seed by
 *     default).
 *
 * Future additions land here when they read per-app data scoped to
 * `ctx.appId` (per-app adapter grants, per-app permission scopes,
 * etc.).
 */
export {
  createGguiListGadgetsHandler,
  type GguiListGadgetsHandlerDeps,
  type GguiListGadgetsOutput,
} from './list-gadgets.js';
export {
  createGguiListThemesHandler,
  type GguiListThemesHandlerDeps,
  type GguiListThemesOutput,
  type ThemeCatalogEntry,
} from './list-themes.js';
export { AppAccessDeniedError } from './errors.js';
