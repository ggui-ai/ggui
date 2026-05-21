/**
 * Operator-class orgs handler family.
 *
 * Four MCP tools, all `audience: ['ops']`, all served on `/ops`. Pure
 * over the {@link OrgsSource} + {@link OrgInvitesSource} seams — NO
 * AWS imports. Cloud deployments bind AWS-backed adapters; tests use
 * in-memory fakes.
 *
 *   - `createListOrgsHandler` → `ggui_ops_list_orgs`
 *   - `createCreateOrgHandler` → `ggui_ops_create_org`
 *   - `createInviteToOrgHandler` → `ggui_ops_invite_to_org`
 *   - `createRevokeInviteHandler` → `ggui_ops_revoke_invite`
 */

export type {
  OrgRecord,
  OrgRole,
  OrgMembershipRecord,
  OrgInviteRecord,
  OrgsSource,
  OrgInvitesSource,
} from './types.js';
export {
  OrgInviteAccessDeniedError,
  OrgInviteNotFoundError,
} from './types.js';

export { createListOrgsHandler } from './list-orgs.js';
export type { ListOrgsDeps, ListOrgsOutput } from './list-orgs.js';

export { createCreateOrgHandler } from './create-org.js';
export type { CreateOrgDeps, CreateOrgOutput } from './create-org.js';

export { createInviteToOrgHandler } from './invite-to-org.js';
export type {
  InviteToOrgDeps,
  InviteToOrgOutput,
} from './invite-to-org.js';

export { createRevokeInviteHandler } from './revoke-invite.js';
export type {
  RevokeInviteDeps,
  RevokeInviteOutput,
} from './revoke-invite.js';
