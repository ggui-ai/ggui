/**
 * Operator-class apps handler family.
 *
 * Six MCP tools, all `audience: ['ops']`, all served on `/ops`. Pure
 * over the {@link AppsSource} + {@link UserDefaultAppSource} seams —
 * NO AWS imports. Cloud deployments bind AWS-backed adapters; tests
 * use in-memory fakes.
 *
 *   - `createListAppsHandler` → `ggui_ops_list_apps`
 *   - `createCreateAppHandler` → `ggui_ops_create_app`
 *   - `createRenameAppHandler` → `ggui_ops_rename_app`
 *   - `createDeleteAppHandler` → `ggui_ops_delete_app`
 *   - `createSetDefaultAppHandler` → `ggui_ops_set_default_app`
 *   - `createUpdateAppSystemPromptHandler` →
 *     `ggui_ops_update_app_system_prompt`
 */

export type {
  AppRecord,
  AppsSource,
  UserDefaultAppSource,
} from './types.js';
export { OpsAppsAccessDeniedError } from './types.js';

export { createListAppsHandler } from './list-apps.js';
export type { ListAppsDeps, ListAppsOutput } from './list-apps.js';

export { createCreateAppHandler } from './create-app.js';
export type { CreateAppDeps, CreateAppOutput } from './create-app.js';

export { createRenameAppHandler, AppNotFoundError } from './rename-app.js';
export type { RenameAppDeps, RenameAppOutput } from './rename-app.js';

export { createDeleteAppHandler } from './delete-app.js';
export type { DeleteAppDeps, DeleteAppOutput } from './delete-app.js';

export { createSetDefaultAppHandler } from './set-default-app.js';
export type {
  SetDefaultAppDeps,
  SetDefaultAppOutput,
} from './set-default-app.js';

export { createUpdateAppSystemPromptHandler } from './update-app-system-prompt.js';
export type {
  UpdateAppSystemPromptDeps,
  UpdateAppSystemPromptOutput,
} from './update-app-system-prompt.js';
