/**
 * `ggui logout` — discard the local `~/.ggui/auth.json` session.
 *
 * Does NOT call a server-side revoke (no `/v1/auth/logout` endpoint
 * at v1). The local-only delete means the access token stays valid on
 * the server until its TTL expires (~1h). For sensitive scenarios,
 * follow with `ggui keys revoke <id>` for any keys that were
 * provisioned during the session.
 */
import { deleteAuthSession } from './auth-store.js';

export const LOGOUT_HELP = `ggui logout — clear the local CLI session

Usage:
  ggui logout

Deletes ~/.ggui/auth.json. Server-side tokens stay valid until their
TTL expires (~1h access, ~30d refresh).
`;

export function runLogoutCommand(args: readonly string[]): number {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(LOGOUT_HELP);
    return 0;
  }
  const { deleted } = deleteAuthSession();
  if (deleted) {
    process.stdout.write(`Signed out. ~/.ggui/auth.json removed.\n`);
  } else {
    process.stdout.write(`No active session found.\n`);
  }
  return 0;
}
