/**
 * Resend-backed `EmailSender`.
 *
 * Wraps the `resend` SDK (https://resend.com) into the same
 * `EmailSender` interface as `ConsoleEmailSender` — drop-in
 * replacement: construct it, pass it to `createGguiServer({emailLogin: {sender, …}})`.
 *
 * The OSS CLI auto-constructs this when `GGUI_EMAIL_SENDER=resend` and
 * `RESEND_API_KEY` are set in the environment. Programmatic embedders
 * import it directly:
 *
 * ```ts
 * import { ResendEmailSender, createGguiServer } from '@ggui-ai/mcp-server';
 *
 * const server = createGguiServer({
 *   emailLogin: {
 *     sender: new ResendEmailSender({ apiKey: process.env.RESEND_API_KEY! }),
 *     fromAddress: 'Acme <noreply@acme.com>',
 *   },
 *   // ...
 * });
 * ```
 *
 * Note: Resend requires the `from` address's domain to be verified
 * in the Resend dashboard. Pass an unverified domain and `send()`
 * will reject — the adapter surfaces the SDK error verbatim, no
 * silent swallow. See https://resend.com/docs/dashboard/domains/introduction.
 */
import { Resend } from 'resend';
import type { EmailMessage, EmailSender } from './email-login.js';
import { createConsoleLogger } from './logger.js';
import type { Logger } from './logger.js';

/**
 * @public
 */
export interface ResendEmailSenderOptions {
  /**
   * Resend API key, format `re_...`. Mint at
   * https://resend.com/api-keys. Required.
   */
  readonly apiKey: string;
  /**
   * Optional logger. Defaults to a component-bound console logger.
   * Receives one `email_resend_sent` event per successful send and
   * one `email_resend_failed` event per failure (with `errorCode`
   * + `errorMessage` from the SDK response).
   */
  readonly logger?: Logger;
}

/**
 * @public
 */
export class ResendEmailSender implements EmailSender {
  private readonly client: Resend;
  private readonly logger: Logger;

  constructor(opts: ResendEmailSenderOptions) {
    this.client = new Resend(opts.apiKey);
    this.logger =
      opts.logger ?? createConsoleLogger({ component: 'email-resend-sender' });
  }

  async send(message: EmailMessage): Promise<void> {
    if (!message.from) {
      // Resend requires an explicit `from`. Defer the surface error
      // to the caller — `mountEmailLoginRoutes` always supplies one
      // from `fromAddress`, so this branch is operator-config error.
      throw new Error(
        'ResendEmailSender: `from` address required (set `emailLogin.fromAddress` on createGguiServer).',
      );
    }
    const { data, error } = await this.client.emails.send({
      from: message.from,
      to: message.to,
      subject: message.subject,
      text: message.text,
      ...(message.html ? { html: message.html } : {}),
    });
    if (error) {
      this.logger.warn('email_resend_failed', {
        to: message.to,
        from: message.from,
        errorName: error.name,
        errorMessage: error.message,
      });
      throw new Error(
        `ResendEmailSender.send failed: ${error.name}: ${error.message}`,
      );
    }
    this.logger.info('email_resend_sent', {
      to: message.to,
      from: message.from,
      messageId: data?.id,
    });
  }
}
