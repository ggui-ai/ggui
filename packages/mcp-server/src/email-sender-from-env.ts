/**
 * Env-driven `EmailSender` selector. Lets `ggui serve` (or any
 * embedder reading from process.env) pick between the three built-in
 * senders without hardcoding branches.
 *
 * Env contract:
 *
 *   - `GGUI_EMAIL_SENDER`        — `console` | `resend` | `smtp` (default: `console`)
 *   - `GGUI_EMAIL_FROM`          — overrides the default `fromAddress` (returned alongside the sender)
 *   - `RESEND_API_KEY`           — required when `GGUI_EMAIL_SENDER=resend`
 *   - `SMTP_URL`                 — connection string, e.g. `smtps://user:pass@host:465`
 *   - `SMTP_HOST` / `SMTP_PORT`  — discrete config (alternative to `SMTP_URL`)
 *   - `SMTP_USER` / `SMTP_PASS`  — auth (used with `SMTP_HOST`)
 *   - `SMTP_SECURE`              — `'true'`/`'false'` to override the auto-derive
 *
 * Misconfiguration (e.g. `GGUI_EMAIL_SENDER=resend` without
 * `RESEND_API_KEY`) returns `{ kind: 'error', reason }` so the CLI
 * can log + fall back to console rather than crashing the boot.
 *
 * @public
 */
import { ConsoleEmailSender } from './email-login.js';
import type { EmailSender } from './email-login.js';
import { ResendEmailSender } from './email-resend.js';
import { SmtpEmailSender } from './email-smtp.js';
import type { Logger } from './logger.js';

/**
 * @public
 */
export type EmailSenderKind = 'console' | 'resend' | 'smtp';

/**
 * @public
 */
export type EmailSenderSelection =
  | {
      kind: 'ok';
      sender: EmailSender;
      senderKind: EmailSenderKind;
      /** Operator-supplied `GGUI_EMAIL_FROM`, if set. CLI uses this to override the default `fromAddress`. */
      fromAddress?: string;
    }
  | {
      kind: 'error';
      senderKind: EmailSenderKind;
      reason: string;
    };

/**
 * @public
 */
export interface SelectEmailSenderOptions {
  /** Process env. Defaults to `process.env`. */
  readonly env?: NodeJS.ProcessEnv;
  /** Optional logger threaded into the constructed sender. */
  readonly logger?: Logger;
}

/**
 * @public
 */
export function selectEmailSenderFromEnv(
  opts: SelectEmailSenderOptions = {},
): EmailSenderSelection {
  const env = opts.env ?? process.env;
  const raw = env.GGUI_EMAIL_SENDER?.trim().toLowerCase() ?? 'console';
  const fromAddress = env.GGUI_EMAIL_FROM?.trim() || undefined;

  if (raw !== 'console' && raw !== 'resend' && raw !== 'smtp') {
    return {
      kind: 'error',
      senderKind: 'console',
      reason: `GGUI_EMAIL_SENDER='${raw}' is not one of console|resend|smtp`,
    };
  }
  const senderKind = raw as EmailSenderKind;

  if (senderKind === 'console') {
    const result: EmailSenderSelection = {
      kind: 'ok',
      sender: new ConsoleEmailSender(opts.logger),
      senderKind,
    };
    return fromAddress ? { ...result, fromAddress } : result;
  }

  if (senderKind === 'resend') {
    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) {
      return {
        kind: 'error',
        senderKind,
        reason: 'GGUI_EMAIL_SENDER=resend but RESEND_API_KEY is not set',
      };
    }
    const result: EmailSenderSelection = {
      kind: 'ok',
      sender: new ResendEmailSender({
        apiKey,
        ...(opts.logger ? { logger: opts.logger } : {}),
      }),
      senderKind,
    };
    return fromAddress ? { ...result, fromAddress } : result;
  }

  // smtp
  const url = env.SMTP_URL?.trim();
  const host = env.SMTP_HOST?.trim();
  if (!url && !host) {
    return {
      kind: 'error',
      senderKind,
      reason:
        'GGUI_EMAIL_SENDER=smtp but neither SMTP_URL nor SMTP_HOST is set',
    };
  }
  const portRaw = env.SMTP_PORT?.trim();
  const port = portRaw ? Number(portRaw) : undefined;
  if (portRaw && (Number.isNaN(port) || port! <= 0 || port! > 65535)) {
    return {
      kind: 'error',
      senderKind,
      reason: `SMTP_PORT='${portRaw}' is not a valid port number`,
    };
  }
  const secureRaw = env.SMTP_SECURE?.trim().toLowerCase();
  const secure =
    secureRaw === 'true' ? true : secureRaw === 'false' ? false : undefined;

  try {
    const sender = new SmtpEmailSender({
      ...(url ? { url } : {}),
      ...(host ? { host } : {}),
      ...(port !== undefined ? { port } : {}),
      ...(secure !== undefined ? { secure } : {}),
      ...(env.SMTP_USER ? { user: env.SMTP_USER } : {}),
      ...(env.SMTP_PASS ? { pass: env.SMTP_PASS } : {}),
      ...(opts.logger ? { logger: opts.logger } : {}),
    });
    const result: EmailSenderSelection = {
      kind: 'ok',
      sender,
      senderKind,
    };
    return fromAddress ? { ...result, fromAddress } : result;
  } catch (err) {
    return {
      kind: 'error',
      senderKind,
      reason: err instanceof Error ? err.message : String(err),
    };
  }
}
