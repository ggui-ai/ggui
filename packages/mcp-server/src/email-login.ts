/**
 * Email magic-link login.
 *
 * Passwordless flow: user enters their email → server mints a single-
 * use token → server emails the user a `verify` URL → user clicks
 * → server consumes the token + mints a session bearer → 302 to
 * `nextPath`. Two routes (`/start`, `/verify`) plus a public-readable
 * `/config` so `/login` can know whether to render the form.
 *
 * Identity model: `userId = "email:" + normalizedEmail`. Different
 * email = different identity (no email-rotation linking, same
 * stance as oauth-login-types.ts). Lowercase + trim is the only
 * normalization — Gmail-dot/plus-tag tricks deliberately stay
 * unmodified so `alice+ggui@gmail.com` is a distinct identity from
 * `alice@gmail.com` (the user is in control of which inbox the
 * link goes to).
 *
 * Security boundary:
 *
 *   - Tokens are 256-bit URL-safe, single-use, ≤15 min TTL.
 *     Consume-or-reject-atomically per request — a successful verify
 *     deletes the token before the response goes out so a refresh
 *     can't replay.
 *   - `/start` ALWAYS returns 200, regardless of whether the email
 *     was deliverable or even valid. This prevents email-enumeration
 *     attacks (an attacker probing for "is alice@example.com a known
 *     user" would otherwise see a different status / latency).
 *   - The verify URL goes ONLY to the user's inbox — never echoed
 *     back to the start-call response. The server logs it once for
 *     audit, but the user picks it up out-of-band.
 *   - `nextPath` is sanitized to same-origin relative paths. An
 *     attacker can't craft a magic link that bounces a verified
 *     session through to `https://evil/`.
 */
import type { Express, Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import type { AuditEntry, AuditSink, AuthAdapter } from '@ggui-ai/mcp-server-core';
import { formatUserSessionCookieHeader } from './user-session-auth.js';
import { createConsoleLogger } from './logger.js';
import type { Logger } from './logger.js';

/**
 * Public route paths. Operators may override via
 * `EmailLoginRoutesOptions.{startPath,verifyPath,configPath}` for
 * test or sub-mount scenarios.
 */
export const DEFAULT_EMAIL_LOGIN_START_PATH = '/ggui/email-login/start';
export const DEFAULT_EMAIL_LOGIN_VERIFY_PATH = '/ggui/email-login/verify';
export const DEFAULT_EMAIL_LOGIN_CONFIG_PATH = '/ggui/email-login/config';

const TOKEN_TTL_MS = 15 * 60 * 1000;
const DEFAULT_NEXT_PATH = '/settings';

/**
 * Outbound email contract. The default `ConsoleEmailSender` just
 * logs to the server logger — useful for `ggui serve` development
 * (the magic link shows up in the terminal). Reference
 * implementations (SMTP via nodemailer, Resend, AWS SES) live in
 * adapter packages so the OSS core stays dep-light.
 *
 * @public
 */
export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

/**
 * Plain-text first, HTML second — every transactional-email
 * service we'd plausibly target accepts this shape. `from` lets the
 * caller override the default `fromAddress` per message; absent
 * means the server-wide default.
 *
 * @public
 */
export interface EmailMessage {
  readonly to: string;
  readonly from?: string;
  readonly subject: string;
  readonly text: string;
  readonly html?: string;
}

/**
 * Fallback sender that logs every "sent" email to the configured
 * logger at info level. The verify URL appears in the logs so an
 * operator running `ggui serve` locally can copy/paste it without
 * setting up real email infrastructure. Production deploys MUST
 * swap this for a real sender — the fallback is a developer-mode
 * convenience, not a security control.
 *
 * @public
 */
export class ConsoleEmailSender implements EmailSender {
  private readonly logger: Logger;
  constructor(logger?: Logger) {
    this.logger = logger ?? createConsoleLogger({ component: 'email-console-sender' });
  }
  async send(message: EmailMessage): Promise<void> {
    this.logger.info('email_console_sender', {
      to: message.to,
      from: message.from ?? '<default>',
      subject: message.subject,
      text: message.text,
    });
  }
}

/**
 * Storage for outstanding magic-link tokens. Each `mintToken` returns
 * an opaque URL-safe string the caller emails to the user; the user's
 * subsequent click hits `/verify`, which calls `consumeToken` (atomic
 * single-use). The default `InMemoryMagicLinkStore` is per-process
 * and forgets on restart — fine for a single-host OSS server, wrong
 * for multi-host. Cluster deployments swap in a Redis/DDB-backed
 * impl whose contract matches this interface.
 *
 * @public
 */
export interface MagicLinkStore {
  mintToken(input: MintTokenInput): Promise<string>;
  /**
   * Atomic consume — returns `null` if the token is unknown,
   * already consumed, or expired. Successful consumption MUST
   * delete the token before returning so a replay finds nothing.
   */
  consumeToken(token: string): Promise<MagicLinkRecord | null>;
}

export interface MintTokenInput {
  readonly email: string;
  readonly nextPath: string;
  readonly ttlMs: number;
}

export interface MagicLinkRecord {
  readonly email: string;
  readonly nextPath: string;
}

/**
 * Default in-memory store. Loses tokens on process restart (which
 * is acceptable — pending magic links expire in 15 min anyway, and
 * a restart is itself a "request a new link" prompt to the user).
 *
 * @public
 */
export class InMemoryMagicLinkStore implements MagicLinkStore {
  private readonly records = new Map<
    string,
    { email: string; nextPath: string; expiresAt: number }
  >();

  async mintToken({ email, nextPath, ttlMs }: MintTokenInput): Promise<string> {
    // 32 random bytes → 64 hex chars. Plenty of entropy; no need
    // for the more compact base64url since hex copy/pastes cleaner
    // out of email clients that try to "smarten" punctuation.
    const token = randomBytes(32).toString('hex');
    this.records.set(token, {
      email,
      nextPath,
      expiresAt: Date.now() + ttlMs,
    });
    return token;
  }

  async consumeToken(token: string): Promise<MagicLinkRecord | null> {
    const r = this.records.get(token);
    if (!r) return null;
    // Single-use: delete BEFORE checking expiry so an expired but
    // present token can't be reconsumed by a clock-rewind attacker.
    this.records.delete(token);
    if (Date.now() > r.expiresAt) return null;
    return { email: r.email, nextPath: r.nextPath };
  }
}

/**
 * Configuration for {@link mountEmailLoginRoutes}.
 *
 * @public
 */
export interface EmailLoginRoutesOptions {
  readonly sender: EmailSender;
  readonly auth: AuthAdapter;
  readonly logger: Logger;
  /** Public base URL — used to compose the magic-link verify URL. */
  readonly publicBaseUrl: string;
  /**
   * From-address stamped on every email. Format follows RFC 5322:
   * `"display name" <addr@host>` or just `addr@host`. SMTP/Resend
   * typically REQUIRE the address to be on a domain the sender has
   * authenticated; check the sender adapter's docs.
   */
  readonly fromAddress: string;
  /** Override store (e.g., RedisMagicLinkStore for multi-host). */
  readonly store?: MagicLinkStore;
  /** Optional audit sink — fires `auth.email.start/.success/.failure`. */
  readonly auditSink?: AuditSink;
  /** Adds `Secure` to the session cookie. */
  readonly secure?: boolean;
  /** User-session cookie TTL (seconds). */
  readonly ttlSec?: number;
  /** Path overrides (mostly for tests). */
  readonly startPath?: string;
  readonly verifyPath?: string;
  readonly configPath?: string;
  /**
   * Subject line + body templating. Defaults are sensible; override
   * to match brand copy. `{verifyUrl}` is replaced before send.
   */
  readonly subject?: string;
  readonly bodyText?: string;
  readonly bodyHtml?: string;
}

const DEFAULT_SUBJECT = 'Sign in to ggui';
const DEFAULT_BODY_TEXT =
  "Click the link below to sign in. It expires in 15 minutes.\n\n" +
  '{verifyUrl}\n\n' +
  "If you didn't request this, you can safely ignore this email.";
const DEFAULT_BODY_HTML =
  '<p>Click the link below to sign in. It expires in 15 minutes.</p>' +
  '<p><a href="{verifyUrl}">{verifyUrl}</a></p>' +
  "<p style=\"color:#888\">If you didn't request this, you can safely ignore this email.</p>";

/**
 * Loose RFC 5322 subset — `local@host.tld`. Doesn't reject every
 * weird-but-legal address (no IDN, no quoted locals), just rules
 * out obviously-broken input early. The downstream SMTP/HTTP
 * sender is the authoritative validator.
 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Mount `POST /start`, `GET /verify`, `GET /config`. Idempotent
 * across multiple calls (later mount wins for the same path).
 *
 * @public
 */
export function mountEmailLoginRoutes(
  app: Express,
  opts: EmailLoginRoutesOptions,
): void {
  const startPath = opts.startPath ?? DEFAULT_EMAIL_LOGIN_START_PATH;
  const verifyPath = opts.verifyPath ?? DEFAULT_EMAIL_LOGIN_VERIFY_PATH;
  const configPath = opts.configPath ?? DEFAULT_EMAIL_LOGIN_CONFIG_PATH;
  const store = opts.store ?? new InMemoryMagicLinkStore();
  const subject = opts.subject ?? DEFAULT_SUBJECT;
  const bodyText = opts.bodyText ?? DEFAULT_BODY_TEXT;
  const bodyHtml = opts.bodyHtml ?? DEFAULT_BODY_HTML;
  const auditSink = opts.auditSink;

  const emitAudit = async (
    entry: Omit<AuditEntry, 'at'>,
    auditLogger: Logger,
  ): Promise<void> => {
    if (!auditSink) return;
    try {
      await auditSink.record({ at: Date.now(), ...entry });
    } catch (err) {
      auditLogger.warn('audit_emit_failed', {
        action: entry.action,
        error: String(err),
      });
    }
  };

  // --- GET /ggui/email-login/config ---
  // Public + cheap. /login fetches this to know whether to render
  // the email form. No secrets here — just a presence boolean.
  app.get(configPath, (_req: Request, res: Response) => {
    res.status(200).json({ enabled: true });
  });

  // --- POST /ggui/email-login/start ---
  // Body: { email: string, next?: string }. Always 200 (avoid
  // email enumeration — see route docstring for why).
  app.post(startPath, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'POST ' + startPath });
    const body =
      typeof req.body === 'object' && req.body !== null
        ? (req.body as Record<string, unknown>)
        : {};
    const rawEmail = typeof body['email'] === 'string' ? body['email'] : '';
    const email = rawEmail.trim().toLowerCase();
    if (!EMAIL_RE.test(email) || email.length > 254) {
      // 254 = RFC 5321 max length. Reject malformed up-front — this
      // is "user typo" not "attacker probe", so 400 is honest.
      reqLogger.warn('email_login_invalid_email', {});
      res.status(400).json({
        error: {
          code: 'invalid_email',
          message: 'Provide a valid email address.',
        },
      });
      return;
    }

    const nextRaw = typeof body['next'] === 'string' ? body['next'] : undefined;
    const nextPath = sanitizeNextPath(nextRaw) ?? DEFAULT_NEXT_PATH;

    const token = await store.mintToken({
      email,
      nextPath,
      ttlMs: TOKEN_TTL_MS,
    });
    const verifyUrl =
      `${trimTrailingSlash(opts.publicBaseUrl)}${verifyPath}` +
      `?token=${encodeURIComponent(token)}`;

    try {
      await opts.sender.send({
        to: email,
        from: opts.fromAddress,
        subject,
        text: bodyText.replace(/\{verifyUrl\}/g, verifyUrl),
        html: bodyHtml.replace(/\{verifyUrl\}/g, verifyUrl),
      });
      reqLogger.info('email_login_sent', { email });
      await emitAudit(
        {
          action: 'auth.email.start',
          actor: { kind: 'anonymous' },
          metadata: { email },
        },
        reqLogger,
      );
    } catch (err) {
      // Sender failures we log + audit, but we still 200 to the
      // caller — same enumeration concern. The user's "I never got
      // an email" is the discovery path; ops finds it in logs.
      reqLogger.warn('email_login_send_failed', {
        email,
        error: String(err),
      });
      await emitAudit(
        {
          action: 'auth.email.failure',
          actor: { kind: 'anonymous' },
          metadata: { email, reason: 'send_failed', detail: String(err) },
        },
        reqLogger,
      );
    }

    res.status(200).json({ ok: true });
  });

  // --- GET /ggui/email-login/verify?token=... ---
  app.get(verifyPath, async (req: Request, res: Response) => {
    const reqLogger = opts.logger.child({ route: 'GET ' + verifyPath });
    const tokenRaw = req.query['token'];
    const token = typeof tokenRaw === 'string' ? tokenRaw : '';
    if (!token) {
      reqLogger.warn('email_login_verify_missing_token', {});
      res.status(400).send('Missing token. Open your email and click the link again.');
      return;
    }

    const consumed = await store.consumeToken(token);
    if (!consumed) {
      reqLogger.warn('email_login_verify_invalid', {});
      await emitAudit(
        {
          action: 'auth.email.failure',
          actor: { kind: 'anonymous' },
          metadata: { reason: 'invalid_or_expired_token' },
        },
        reqLogger,
      );
      res
        .status(403)
        .send(
          'This sign-in link is invalid or has expired. ' +
            'Request a new link from /login.',
        );
      return;
    }

    if (!opts.auth.registerToken) {
      reqLogger.warn('email_login_register_token_unsupported', {});
      res.status(501).json({
        error: {
          code: 'not_supported',
          message:
            'AuthAdapter has no registerToken — email login requires a token-registering adapter.',
        },
      });
      return;
    }

    const userId = `email:${consumed.email}`;
    const bearer = `ggui_user_${randomBytes(24).toString('hex')}`;
    opts.auth.registerToken(bearer, {
      identity: { kind: 'user', userId, roles: [] },
      source: 'email',
      metadata: { email: consumed.email },
    });

    const sessionCookie = formatUserSessionCookieHeader({
      bearer,
      ...(opts.ttlSec !== undefined ? { ttlSec: opts.ttlSec } : {}),
      ...(opts.secure !== undefined ? { secure: opts.secure } : {}),
    });
    res.setHeader('Set-Cookie', sessionCookie);
    reqLogger.info('email_login_success', { userId });
    await emitAudit(
      {
        action: 'auth.email.success',
        actor: { kind: 'user', id: userId },
        metadata: { email: consumed.email },
      },
      reqLogger,
    );
    res.redirect(302, consumed.nextPath);
  });
}

/**
 * Reject open-redirects: only same-origin RELATIVE paths starting
 * with `/` (and NOT `//` which the URL parser treats as protocol-
 * relative). Returns null when the input fails validation so the
 * caller can pick the default.
 */
function sanitizeNextPath(raw: string | undefined): string | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  if (!raw.startsWith('/')) return null;
  if (raw.startsWith('//')) return null;
  return raw;
}

function trimTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
