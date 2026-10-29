import { resolve } from 'node:path';
import type { Config } from '../../config/env.js';
import { DevMailServerAdapter } from './dev.adapter.js';
import type { MailServerAdapter } from './mail-server.interface.js';
import { StalwartAdapter } from './stalwart.adapter.js';

export function createMailServerAdapter(config: Config): MailServerAdapter {
  if (config.MAIL_ADAPTER === 'stalwart') {
    return new StalwartAdapter({
      baseUrl: config.STALWART_URL!,
      username: config.STALWART_ADMIN_USER!,
      secret: config.STALWART_ADMIN_SECRET!,
      timeoutMs: config.STALWART_TIMEOUT_MS,
    });
  }
  if (config.isProduction) throw new Error('Development mail adapter is not permitted in production.');
  return new DevMailServerAdapter({ statePath: resolve(config.DEV_MAIL_ENGINE_STATE), mailHostname: config.MAIL_HOSTNAME });
}
