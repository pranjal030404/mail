import { resolve } from 'node:path';
import type { Config } from '../../config/env.js';
import { DevWebmailAdapter } from './dev-webmail.adapter.js';
import { JmapWebmailAdapter } from './jmap-webmail.adapter.js';
import type { WebmailAdapter } from './webmail.interface.js';

export function createWebmailAdapter(config: Config): WebmailAdapter {
  if (config.MAIL_ADAPTER === 'stalwart') {
    return new JmapWebmailAdapter({
      baseUrl: config.WEBMAIL_JMAP_URL ?? config.STALWART_URL!,
      timeoutMs: config.STALWART_TIMEOUT_MS,
    });
  }
  if (config.isProduction) throw new Error('The development webmail simulator is not permitted in production.');
  return new DevWebmailAdapter(resolve(config.WEBMAIL_DEV_STATE));
}
