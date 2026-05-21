/**
 * `ggui whoami` — print the authenticated user's profile.
 *
 * Reads `~/.ggui/auth.json`, calls GET /v1/me with the access bearer,
 * and pretty-prints the result. On 401, the api-client transparently
 * refreshes via /v1/auth/refresh; if that also fails the user gets
 * a "Run `ggui login` again" message and exit 1.
 */
import { ApiError, getMe } from './api-client.js';
import { tryLoadAuthSession } from './auth-store.js';

export const WHOAMI_HELP = `ggui whoami — print the authenticated user

Usage:
  ggui whoami

Reads the local session from ~/.ggui/auth.json and calls /v1/me.
`;

export async function runWhoamiCommand(args: readonly string[]): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(WHOAMI_HELP);
    return 0;
  }

  const session = tryLoadAuthSession();
  if (!session) {
    process.stderr.write(`Not signed in. Run \`ggui login\` first.\n`);
    return 1;
  }

  try {
    const me = await getMe();
    process.stdout.write(`User ID:        ${me.userId}\n`);
    process.stdout.write(`Session ID:     ${me.sessionId}\n`);
    if (me.clientName) {
      process.stdout.write(`Client:         ${me.clientName}\n`);
    }
    const expiresAt = new Date(me.accessExpiresAt * 1000).toISOString();
    process.stdout.write(`Access expires: ${expiresAt}\n`);
    process.stdout.write(`Endpoint:       ${session.endpoint}\n`);
    return 0;
  } catch (err) {
    if (err instanceof ApiError) {
      process.stderr.write(`ggui whoami: ${err.code}: ${err.message}\n`);
    } else if (err instanceof Error) {
      process.stderr.write(`ggui whoami: ${err.message}\n`);
    } else {
      process.stderr.write(`ggui whoami: unknown error\n`);
    }
    return 1;
  }
}
