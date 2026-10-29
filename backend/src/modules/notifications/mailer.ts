import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import nodemailer from 'nodemailer';
import type { Config } from '../../config/env.js';
import { newId } from '../../shared/ids.js';

export interface OutgoingMessage {
  to: string;
  subject: string;
  text: string;
  /** Category used for logging; message content is never logged. */
  category: string;
}

export interface Mailer {
  readonly kind: 'smtp' | 'dev' | 'memory';
  send(msg: OutgoingMessage): Promise<void>;
}

/** Sends platform notifications through an authenticated SMTP submission account. */
export class SmtpMailer implements Mailer {
  readonly kind = 'smtp' as const;
  private readonly transport;

  constructor(private readonly config: Config) {
    this.transport = nodemailer.createTransport({
      host: config.SMTP_HOST,
      port: config.SMTP_PORT,
      secure: config.SMTP_SECURE,
      requireTLS: !config.SMTP_SECURE,
      auth: config.SMTP_USER ? { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } : undefined,
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 20000,
    });
  }

  async send(msg: OutgoingMessage): Promise<void> {
    await this.transport.sendMail({ from: this.config.MAIL_FROM, to: msg.to, subject: msg.subject, text: msg.text });
  }
}

/**
 * DEVELOPMENT-ONLY: writes messages to .eml files in DEV_OUTBOX_DIR instead of sending them.
 * Nothing leaves the machine. Refused in production by configuration validation.
 */
export class DevFileMailer implements Mailer {
  readonly kind = 'dev' as const;
  constructor(
    private readonly dir: string,
    private readonly from: string,
  ) {}

  async send(msg: OutgoingMessage): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const file = join(this.dir, `${new Date().toISOString().replace(/[:.]/g, '-')}-${msg.category}-${newId()}.eml`);
    const body = [
      'X-ARTHVEX-Dev-Outbox: this message was NOT sent; development capture only',
      `From: ${this.from}`,
      `To: ${msg.to}`,
      `Subject: ${msg.subject}`,
      'Content-Type: text/plain; charset=utf-8',
      '',
      msg.text,
    ].join('\r\n');
    await writeFile(file, body, { mode: 0o600 });
  }
}

/** In-memory mailer for automated tests. */
export class MemoryMailer implements Mailer {
  readonly kind = 'memory' as const;
  readonly sent: OutgoingMessage[] = [];
  async send(msg: OutgoingMessage): Promise<void> {
    this.sent.push(msg);
  }
  last(to: string, category?: string): OutgoingMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to === to && (!category || m.category === category));
  }
}

export function createMailer(config: Config): Mailer {
  if (config.MAILER === 'smtp') return new SmtpMailer(config);
  if (config.isProduction) throw new Error('Development mailer is not permitted in production.');
  return new DevFileMailer(resolve(config.DEV_OUTBOX_DIR), config.MAIL_FROM);
}
