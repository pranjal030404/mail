import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { createAppContext } from '../bootstrap.js';
import { loadConfig } from '../config/env.js';
import { exec } from '../db/pool.js';
import { claimNext } from '../modules/jobs/jobs.repository.js';
import { runJob } from '../modules/mail-server/provisioning.service.js';
import { createScheduler } from './scheduler.js';

const config = loadConfig();
const log = {
  info: (o: unknown, m?: string) => console.log(JSON.stringify({ level: 'info', msg: m ?? o, ...(m ? (o as object) : {}) })),
  warn: (o: unknown, m?: string) => console.warn(JSON.stringify({ level: 'warn', msg: m ?? o, ...(m ? (o as object) : {}) })),
  error: (o: unknown, m?: string) => console.error(JSON.stringify({ level: 'error', msg: m ?? o, ...(m ? (o as object) : {}) })),
  debug: () => undefined,
};
const ctx = createAppContext(log, config);
const workerId = `${hostname()}-${randomUUID().slice(0, 8)}`;
const scheduler = createScheduler(ctx);
let stopping = false;
let processed = 0;
let running = 0;

if (ctx.mail.kind === 'dev') log.warn('DEVELOPMENT mail adapter active: no real mailboxes are created.');

async function heartbeat() {
  await exec(
    ctx.db,
    `INSERT INTO worker_heartbeats (worker_id, started_at, last_seen_at, jobs_processed, version) VALUES (?, NOW(3), NOW(3), ?, ?)
     ON DUPLICATE KEY UPDATE last_seen_at = NOW(3), jobs_processed = VALUES(jobs_processed)`,
    [workerId, processed, '0.1.0'],
  );
}

async function loop() {
  let lastBeat = 0;
  while (!stopping) {
    try {
      if (Date.now() - lastBeat > 15_000) {
        await heartbeat();
        lastBeat = Date.now();
      }
      await scheduler.tick();
      while (!stopping && running < config.WORKER_CONCURRENCY) {
        const job = await claimNext(ctx.db, workerId, config.WORKER_LEASE_SECONDS);
        if (!job) break;
        running++;
        void runJob(ctx, job)
          .then((outcome) => log.info({ jobId: job.id, operation: job.operation, outcome, attempt: job.attempts }, 'job finished'))
          .catch((err) => log.error({ jobId: job.id, err: (err as Error).message }, 'job runner crashed'))
          .finally(() => {
            running--;
            processed++;
          });
      }
    } catch (err) {
      log.error({ err: (err as Error).message }, 'worker loop error');
    }
    await new Promise((r) => setTimeout(r, config.WORKER_POLL_MS));
  }
}

async function shutdown(signal: string) {
  log.info({ signal }, 'worker stopping; waiting for running jobs');
  stopping = true;
  const deadline = Date.now() + 30_000;
  while (running > 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  await ctx.db.end();
  process.exit(0);
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

log.info({ workerId }, 'worker started');
await loop();
