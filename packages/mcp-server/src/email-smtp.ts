/**
 * SMTP-backed `EmailSender` via nodemailer.
 *
 * Drop-in replacement for `ConsoleEmailSender` — works against any
 * SMTP server: SES SMTP endpoint, Gmail App Password, Postmark SMTP,
 * Mailgun, a self-hosted Postfix, etc. No vendor lock-in.
 *
 * The OSS CLI auto-constructs this when `GGUI_EMAIL_SENDER=smtp` and
 * either `SMTP_URL` or the discrete `SMTP_HOST/SMTP_PORT/SMTP_USER/
 * SMTP_PASS` set are present. Programmatic embedders pass options
 * directly:
 *
 * ```ts
 * import { SmtpEmailSender, createGguiServer } from '@ggui-ai/mcp-server';
 *
 * const server = createGguiServer({
 *   emailLogin: {
 *     sender: new SmtpEmailSender({
 *       url: 'smtps://AKIA...:secret@email-smtp.us-east-1.amazonaws.com:465',
 *     }),
 *     fromAddress: 'Acme <noreply@acme.com>',
 *   },
 *   // ...
 * });
 * ```
 *
 * Either `url` OR `host` (with the rest of the discrete fields) is
 * required. Passing both is a configuration error and throws at
 * construction time.
 */
import nodemailer from 'nodemailer';
import type { Transporter } from 'nodemailer';
import type { EmailMessage, EmailSender } from './email-login.js';
import { createConsoleLogger } from './logger.js';
import type { Logger } from './logger.js';

/**
 * @public
 */
export interface SmtpEmailSenderOptions {
  /**
   * SMTP connection URL, e.g. `smtps://user:pass@host:465` or
   * `smtp://user:pass@host:587`. Convenient for env-driven config.
   * Mutually exclusive with the discrete `host`/`port`/etc. fields.
   */
  readonly url?: string;
  /** SMTP server hostname. Required if `url` is omitted. */
  readonly host?: string;
  /** SMTP server port. Common: 465 (TLS), 587 (STARTTLS), 25 (plaintext). */
  readonly port?: number;
  /**
   * Whether to use a fully-encrypted TLS socket (port 465). Set
   * `false` for STARTTLS upgrade on 587. Defaults to `port === 465`.
   */
  readonly secure?: boolean;
  /** SMTP auth username. */
  readonly user?: string;
  /** SMTP auth password. */
  readonly pass?: string;
  /**
   * Optional logger. Defaults to a component-bound console logger.
   * Emits one `email_smtp_sent` event per successful delivery; SMTP
   * errors propagate via thrown exception (caller logs).
   */
  readonly logger?: Logger;
}

/**
 * @public
 */
export class SmtpEmailSender implements EmailSender {
  private readonly transporter: Transporter;
  private readonly logger: Logger;

  constructor(opts: SmtpEmailSenderOptions) {
    if (opts.url && opts.host) {
      throw new Error(
        'SmtpEmailSender: pass `url` OR `host` (with port/user/pass), not both.',
      );
    }
    if (!opts.url && !opts.host) {
      throw new Error(
        'SmtpEmailSender: `url` or `host` is required (set SMTP_URL or SMTP_HOST in the environment).',
      );
    }
    this.transporter = opts.url
      ? nodemailer.createTransport(opts.url)
      : nodemailer.createTransport({
          host: opts.host!,
          ...(opts.port !== undefined ? { port: opts.port } : {}),
          ...(opts.secure !== undefined
            ? { secure: opts.secure }
            : opts.port === 465
              ? { secure: true }
              : {}),
          ...(opts.user || opts.pass
            ? { auth: { user: opts.user ?? '', pass: opts.pass ?? '' } }
            : {}),
        });
    this.logger =
      opts.logger ?? createConsoleLogger({ component: 'email-smtp-sender' });
  }

  async send(message: EmailMessage): Promise<void> {
    if (!message.from) {
      throw new Error(
        'SmtpEmailSender: `from` address required (set `emailLogin.fromAddress` on createGguiServer).',
      );
    }
    const info = await this.transporter.sendMail({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    this.logger.info('email_smtp_sent', {
      to: message.to,
      from: message.from,
      messageId: info.messageId,
      response: info.response,
    });
  }
}
