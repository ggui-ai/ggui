/**
 * `ggui login` — RFC 8628 device-flow client.
 *
 * Steps:
 *   1. POST /v1/auth/device → device_code + user_code + verification_uri.
 *   2. Print the verification URL + user_code, attempt to open the
 *      browser (best-effort — non-TTY / `BROWSER=none` skips).
 *   3. Poll /v1/auth/poll at the server-recommended interval until
 *      we get tokens, an error, or expiry.
 *   4. Persist tokens to `~/.ggui/auth.json` via `saveAuthSession`.
 */
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import {
  ApiError,
  postAuthDevice,
  postAuthPoll,
  type DeviceCodeResponse,
  type TokenResponse,
} from './api-client.js';
import { resolveEndpoint, saveAuthSession } from './auth-store.js';

export const LOGIN_HELP = `ggui login — sign into ggui.ai for hosted-key management

Usage:
  ggui login [--name <label>] [--no-open]

Options:
  --name <label>   Device label to show in the console (default:
                   "ggui CLI on <hostname>").
  --no-open        Don't auto-open the browser (also implied by
                   non-TTY stdout / BROWSER=none).

Endpoint resolution:
  1. GGUI_API_URL env override.
  2. https://api.ggui.ai (default; Route53 swap pending S6).

After success, tokens are written to ~/.ggui/auth.json with mode 0600.
`;

interface LoginFlags {
  readonly name: string;
  readonly autoOpen: boolean;
  readonly help: boolean;
  readonly error?: string;
}

export function parseLoginFlags(args: readonly string[]): LoginFlags {
  let name: string | undefined;
  let autoOpen = shouldAutoOpenDefault();
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--no-open') {
      autoOpen = false;
      continue;
    }
    if (arg === '--name') {
      const value = args[i + 1];
      if (typeof value !== 'string' || value.length === 0) {
        return {
          name: '',
          autoOpen,
          help,
          error: '--name requires a value',
        };
      }
      name = value;
      i += 1;
      continue;
    }
    return {
      name: '',
      autoOpen,
      help,
      error: `unknown flag: ${arg}`,
    };
  }
  return {
    name: name ?? defaultClientName(),
    autoOpen,
    help,
  };
}

function defaultClientName(): string {
  let host = 'unknown-host';
  try {
    host = hostname();
  } catch {
    // best-effort
  }
  return `ggui CLI on ${host}`;
}

function shouldAutoOpenDefault(): boolean {
  if (process.env['BROWSER'] === 'none') return false;
  if (process.env['CI'] === '1' || process.env['CI'] === 'true') return false;
  if (!process.stdout.isTTY) return false;
  return true;
}

function tryOpenBrowser(url: string): void {
  // Best-effort cross-platform browser open. macOS `open`, Linux
  // `xdg-open`, Windows `cmd /c start ""`. Never throws — failure is
  // non-fatal because the URL is also printed for the user.
  const platform = process.platform;
  let command: string;
  let args: string[];
  if (platform === 'darwin') {
    command = 'open';
    args = [url];
  } else if (platform === 'win32') {
    command = 'cmd';
    args = ['/c', 'start', '""', url];
  } else {
    command = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(command, args, {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    child.on('error', () => {
      // platform may lack the opener — silently swallow
    });
  } catch {
    // ignore
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function pollForTokens(
  endpoint: string,
  device: DeviceCodeResponse,
): Promise<TokenResponse> {
  const startMs = Date.now();
  const expiryMs = startMs + device.expires_in * 1000;
  let interval = device.interval * 1000;
  while (Date.now() < expiryMs) {
    await sleep(interval);
    try {
      return await postAuthPoll(endpoint, device.device_code);
    } catch (err) {
      if (!(err instanceof ApiError)) throw err;
      if (err.code === 'authorization_pending') {
        // Keep polling at the same interval.
        continue;
      }
      if (err.code === 'slow_down') {
        // RFC 8628 §3.5 — server asks us to back off. Add 5s per spec.
        interval += 5000;
        continue;
      }
      // expired_token | invalid_grant | server_error → terminal.
      throw err;
    }
  }
  throw new ApiError(
    400,
    'expired_token',
    'Login window expired before approval. Run `ggui login` again.',
  );
}

export async function runLoginCommand(args: readonly string[]): Promise<number> {
  const flags = parseLoginFlags(args);
  if (flags.help) {
    process.stdout.write(LOGIN_HELP);
    return 0;
  }
  if (flags.error) {
    process.stderr.write(`ggui login: ${flags.error}\n`);
    return 2;
  }

  const endpoint = resolveEndpoint();
  process.stdout.write(`Endpoint: ${endpoint.url} (${endpoint.source})\n`);

  let device: DeviceCodeResponse;
  try {
    device = await postAuthDevice(endpoint.url, flags.name);
  } catch (err) {
    process.stderr.write(`ggui login: failed to start device flow: ${describeError(err)}\n`);
    return 1;
  }

  process.stdout.write(`\n`);
  process.stdout.write(`Open this URL in your browser to approve:\n`);
  process.stdout.write(`  ${device.verification_uri_complete}\n`);
  process.stdout.write(`\n`);
  process.stdout.write(`Verification code: ${device.user_code}\n`);
  process.stdout.write(`(Confirm this matches what the browser shows.)\n`);
  process.stdout.write(`\n`);

  if (flags.autoOpen) {
    tryOpenBrowser(device.verification_uri_complete);
  }

  process.stdout.write(`Waiting for approval…\n`);

  let tokens: TokenResponse;
  try {
    tokens = await pollForTokens(endpoint.url, device);
  } catch (err) {
    process.stderr.write(`ggui login: ${describeError(err)}\n`);
    return 1;
  }

  // Get user info to populate auth.json.userId. The /v1/me endpoint
  // returns userId from the freshly-minted access token. If this 401s
  // there's a server bug, but we still have valid tokens — fall back to
  // empty userId so we can persist what we have.
  const now = Math.floor(Date.now() / 1000);
  const accessExpiresAt = now + tokens.expires_in;
  // Refresh tokens have ~30d TTL on the server — see backend
  // `REFRESH_TOKEN_TTL_SECONDS`. Mirror that so the CLI doesn't need
  // to call /v1/me just to find out.
  const refreshExpiresAt = now + 30 * 24 * 60 * 60;

  // Persist with a placeholder userId; the next /v1/me call (whoami)
  // will fetch the real value. Alternatively we could call /v1/me here
  // — but that adds a round-trip on the hot login path. Defer.
  saveAuthSession({
    version: 1,
    endpoint: endpoint.url,
    userId: '',
    sessionId: tokens.session_id,
    accessToken: tokens.access_token,
    accessExpiresAt,
    refreshToken: tokens.refresh_token,
    refreshExpiresAt,
    clientName: flags.name,
    writtenAt: new Date().toISOString(),
  });

  process.stdout.write(`\nSigned in. Tokens saved to ~/.ggui/auth.json.\n`);
  process.stdout.write(`Try \`ggui whoami\` or \`ggui keys list\`.\n`);
  return 0;
}

function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    return `${err.code}: ${err.message}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}
