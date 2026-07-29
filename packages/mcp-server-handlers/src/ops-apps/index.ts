/**
 * Operator-class apps handler family.
 *
 * Six MCP tools, all `audience: ['ops']`, all served on `/control`. Pure
 * over the {@link AppsSource} + {@link UserDefaultAppSource} seams —
 * NO AWS imports. Cloud deployments bind AWS-backed adapters; tests
 * use in-memory fakes.
 *
 *   - `createListAppsHandler` → `ggui_ops_list_apps`
 *   - `createCreateAppHandler` → `ggui_ops_create_app`
 *   - `createUpdateAppHandler` → `ggui_ops_update_app`
 *   - `createSetAppThemeHandler` → `ggui_ops_set_app_theme`
 *   - `createDeleteAppHandler` → `ggui_ops_delete_app`
 *   - `createSetDefaultAppHandler` → `ggui_ops_set_default_app`
 */

export type {
  AppRecord,
  AppsSource,
  AppUpdatePatch,
  UserDefaultAppSource,
} from './types.js';
export { AppNotFoundError, OpsAppsAccessDeniedError } from './types.js';

export { createListAppsHandler } from './list-apps.js';
export type { ListAppsDeps, ListAppsOutput } from './list-apps.js';

export { createCreateAppHandler } from './create-app.js';
export type { CreateAppDeps, CreateAppOutput } from './create-app.js';

export { createUpdateAppHandler } from './update-app.js';
export type { UpdateAppDeps, UpdateAppOutput } from './update-app.js';

export { createSetAppThemeHandler } from './set-app-theme.js';
export type {
  SetAppThemeDeps,
  SetAppThemeOutput,
} from './set-app-theme.js';

export { createDeleteAppHandler } from './delete-app.js';
export type { DeleteAppDeps, DeleteAppOutput } from './delete-app.js';

export { createSetDefaultAppHandler } from './set-default-app.js';
export type {
  SetDefaultAppDeps,
  SetDefaultAppOutput,
} from './set-default-app.js';
