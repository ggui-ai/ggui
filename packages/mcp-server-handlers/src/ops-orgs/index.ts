/**
 * Operator-class orgs handler family.
 *
 * Seven MCP tools, all `audience: ['ops']`, all served on `/control`. Pure
 * over the {@link OrgsSource} + {@link OrgInvitesSource} seams — NO
 * AWS imports. Cloud deployments bind AWS-backed adapters; tests use
 * in-memory fakes.
 *
 *   - `createListOrgsHandler` → `ggui_ops_list_orgs`
 *   - `createCreateOrgHandler` → `ggui_ops_create_org`
 *   - `createRenameOrgHandler` → `ggui_ops_rename_org`
 *   - `createRemoveOrgMemberHandler` → `ggui_ops_remove_org_member`
 *   - `createGetOrgBalanceHandler` → `ggui_ops_get_org_balance`
 *   - `createInviteToOrgHandler` → `ggui_ops_invite_to_org`
 *   - `createRevokeInviteHandler` → `ggui_ops_revoke_invite`
 */

export type {
  OrgBalanceRecord,
  OrgRecord,
  OrgRole,
  OrgMembershipRecord,
  OrgInviteRecord,
  OrgsSource,
  OrgInvitesSource,
} from './types.js';
export {
  OrgAccessDeniedError,
  OrgInviteAccessDeniedError,
  OrgInviteNotFoundError,
  OrgMemberRemovalDeniedError,
  OrgNotFoundError,
} from './types.js';

export { createListOrgsHandler } from './list-orgs.js';
export type { ListOrgsDeps, ListOrgsOutput } from './list-orgs.js';

export { createCreateOrgHandler } from './create-org.js';
export type { CreateOrgDeps, CreateOrgOutput } from './create-org.js';

export { createRenameOrgHandler } from './rename-org.js';
export type { RenameOrgDeps, RenameOrgOutput } from './rename-org.js';

export { createRemoveOrgMemberHandler } from './remove-org-member.js';
export type {
  RemoveOrgMemberDeps,
  RemoveOrgMemberOutput,
} from './remove-org-member.js';

export { createGetOrgBalanceHandler } from './get-org-balance.js';
export type { GetOrgBalanceDeps } from './get-org-balance.js';

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
