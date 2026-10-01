/**
 * `SmtpEmailSender` delivers through nodemailer to a real SMTP socket: a
 * minimal in-process server on 127.0.0.1 speaks the protocol (greeting,
 * EHLO, MAIL, RCPT, DATA, QUIT) and records what arrived, so a nodemailer
 * upgrade that changes how a transport is built or a message is sent fails
 * here rather than in a self-hoster's inbox (#1562, nodemailer 9 → 10).
 */
import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpEmailSender } from './email-smtp.js';
import type { Logger } from './logger.js';

interface Received {
  mailFrom: string;
  rcptTo: string[];
  data: string;
}

/** A one-message SMTP sink: every command succeeds; the DATA body is kept. */
function smtpSink(): Promise<{ server: Server; port: number; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((socket: Socket) => {
    const current: Received = { mailFrom: '', rcptTo: [], data: '' };
    let inData = false;
    let buffer = '';
    socket.write('220 sink.test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          received.push({ ...current, rcptTo: [...current.rcptTo] });
          socket.write('250 2.0.0 queued as SINK1\r\n');
          continue;
        }
        const nl = buffer.indexOf('\r\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO' || verb === 'HELO') socket.write('250-sink.test\r\n250 8BITMIME\r\n');
        else if (verb === 'MAIL') {
          current.mailFrom = /<([^>]*)>/.exec(line)?.[1] ?? '';
          socket.write('250 2.1.0 OK\r\n');
        } else if (verb === 'RCPT') {
          current.rcptTo.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          socket.write('250 2.1.5 OK\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 go ahead\r\n');
        } else if (verb === 'QUIT') {
          socket.end('221 2.0.0 bye\r\n');
          return;
        } else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received }));
  });
}

function capturingLogger(): { logger: Logger; events: { event: string; fields?: Record<string, unknown> }[] } {
  const events: { event: string; fields?: Record<string, unknown> }[] = [];
  const logger: Logger = {
    info: (event, fields) => void events.push({ event, ...(fields ? { fields } : {}) }),
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return { logger, events };
}

const MESSAGE = {
  from: 'GGUI <login@example.test>',
  to: 'person@example.test',
  subject: 'Your sign-in link',
  text: 'Open https://example.test/verify?t=abc to sign in.',
};

describe('SmtpEmailSender over a real SMTP socket (#1562)', () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve())));

  it('delivers one message from a connection URL: envelope, headers and text arrive; the send is logged with the server reply', async () => {
    const sink = await smtpSink();
    server = sink.server;
    const { logger, events } = capturingLogger();
    await new SmtpEmailSender({ url: `smtp://127.0.0.1:${sink.port}`, logger }).send(MESSAGE);

    expect(sink.received).toHaveLength(1);
    const [got] = sink.received;
    expect(got!.mailFrom).toBe('login@example.test');
    expect(got!.rcptTo).toEqual(['person@example.test']);
    expect(got!.data).toMatch(/^Subject: Your sign-in link$/m);
    expect(got!.data).toContain('Open https://example.test/verify?t=abc to sign in.');
    expect(events).toEqual([
      expect.objectContaining({
        event: 'email_smtp_sent',
        fields: expect.objectContaining({ to: 'person@example.test', response: expect.stringContaining('250') }),
      }),
    ]);
  });

  it('delivers the same way from discrete host and port fields', async () => {
    const sink = await smtpSink();
    server = sink.server;
    const { logger } = capturingLogger();
    await new SmtpEmailSender({ host: '127.0.0.1', port: sink.port, secure: false, logger }).send({ ...MESSAGE, to: 'other@example.test' });
    expect(sink.received.map((r) => r.rcptTo)).toEqual([['other@example.test']]);
  });

  it('refuses a configuration with both or neither of url and host, and a message without a from address', async () => {
    expect(() => new SmtpEmailSender({ url: 'smtp://127.0.0.1:2525', host: '127.0.0.1' })).toThrow(/not both/);
    expect(() => new SmtpEmailSender({})).toThrow(/`url` or `host` is required/);
    const { logger } = capturingLogger();
    const { from: _from, ...noFrom } = MESSAGE;
    await expect(new SmtpEmailSender({ url: 'smtp://127.0.0.1:2525', logger }).send(noFrom)).rejects.toThrow(/`from` address required/);
  });
});
