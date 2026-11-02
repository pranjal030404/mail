import { afterMailboxActive } from '../invitations/invitations.service.js';
import type { AppContext } from '../../context.js';
import { exec, one, rows } from '../../db/pool.js';
import { audit } from '../audit/audit.service.js';
import { markFailed, markRetry, markSucceeded, type JobRow } from '../jobs/jobs.repository.js';
import { notifyTenantAdmins } from '../notifications/notifications.service.js';
import { MailServerError, markerFor } from './mail-server.interface.js';

/** A failure that retrying cannot fix; routed to manual review with a sanitized message. */
class PermanentError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly review = true,
  ) {
    super(message);
  }
}

interface DomainEngineRow {
  id: string;
  tenant_id: string;
  name: string;
  mail_engine_domain_id: string | null;
  status: string;
}
interface MailboxEngineRow {
  id: string;
  tenant_id: string;
  domain_id: string;
  local_part: string;
  normalized_address: string;
  display_name: string | null;
  quota_bytes: number | string;
  status: string;
  mail_engine_account_id: string | null;
  mail_engine_domain_id: string | null;
}

async function loadMailbox(ctx: AppContext, id: string): Promise<MailboxEngineRow | null> {
  return one<MailboxEngineRow>(ctx.db, 'SELECT m.*, d.mail_engine_domain_id FROM mailboxes m JOIN domains d ON d.id = m.domain_id WHERE m.id = ?', [id]);
}

/**
 * Every handler is idempotent and converges on the desired state recorded in MySQL: it first looks at the
 * engine's actual state, so an "uncertain" earlier attempt (applied but unacknowledged) is adopted, not duplicated.
 */
const handlers: Record<string, (ctx: AppContext, job: JobRow) => Promise<Record<string, unknown> | void>> = {
  async 'domain.provision'(ctx, job) {
    const d = await one<DomainEngineRow>(ctx.db, 'SELECT id, tenant_id, name, mail_engine_domain_id, status FROM domains WHERE id = ?', [job.target_id]);
    if (!d || d.status === 'removed' || d.status === 'removal_scheduled') return { skipped: true };
    await exec(ctx.db, "UPDATE domains SET provisioning_status = 'provisioning' WHERE id = ? AND provisioning_status IN ('not_started','failed')", [d.id]);
    const { engineDomainId } = await ctx.mail.ensureDomain(d.name);
    const records = await ctx.mail.getDomainDnsRecords(engineDomainId, d.name);
    await exec(ctx.db, "UPDATE domains SET mail_engine_domain_id = ?, expected_records = ?, expected_records_at = NOW(3), provisioning_status = 'ready' WHERE id = ?", [engineDomainId, JSON.stringify(records), d.id]);
    return { engineDomainId, records: records.length };
  },

  async 'domain.remove'(ctx, job) {
    const d = await one<DomainEngineRow>(ctx.db, 'SELECT id, tenant_id, name, mail_engine_domain_id, status FROM domains WHERE id = ?', [job.target_id]);
    if (!d || d.status === 'removed') return { skipped: true };
    if (d.status !== 'removal_scheduled') return { skipped: true };
    if (d.mail_engine_domain_id) await ctx.mail.removeDomain(d.mail_engine_domain_id);
    await exec(ctx.db, "UPDATE domains SET status = 'removed', provisioning_status = 'removed', removed_at = NOW(3), claim_name = NULL, expected_records = NULL WHERE id = ?", [d.id]);
  },

  async 'mailbox.create'(ctx, job) {
    const m = await loadMailbox(ctx, job.target_id!);
    if (!m || m.status !== 'provisioning') return { skipped: true };
    if (!m.mail_engine_domain_id) throw new MailServerError('unavailable', 'The domain is not ready on the mail server yet.');
    const marker = markerFor('mailbox', m.id);
    let account = await ctx.mail.findMailbox(m.mail_engine_domain_id, m.local_part);
    if (account && account.marker !== marker) {
      throw new PermanentError('engine_conflict', 'An account with this address already exists on the mail server and is not managed by this record.');
    }
    account ??= await ctx.mail.createMailbox({
      appMailboxId: m.id,
      engineDomainId: m.mail_engine_domain_id,
      localPart: m.local_part,
      address: m.normalized_address,
      displayName: m.display_name,
      quotaBytes: Number(m.quota_bytes),
    });
    if (account.quotaBytes !== null && account.quotaBytes !== Number(m.quota_bytes)) await ctx.mail.updateMailboxQuota(account.engineId, Number(m.quota_bytes));
    await exec(ctx.db, "UPDATE mailboxes SET mail_engine_account_id = ?, status = 'active', used_bytes = ?, usage_collected_at = NOW(3) WHERE id = ? AND status = 'provisioning'", [account.engineId, account.usedBytes, m.id]);
    // Onboarding mail is best effort: a notification problem must never fail or retry provisioning.
    await afterMailboxActive(ctx, m.id).catch((e) => ctx.log.warn({ err: (e as Error).message }, 'mailbox instructions not queued'));
    return { engineId: account.engineId };
  },

  async 'mailbox.suspend'(ctx, job) {
    const m = await loadMailbox(ctx, job.target_id!);
    if (!m?.mail_engine_account_id) return { skipped: true };
    // Only act while the desired state is still "blocked"; a later reactivation wins.
    if (!['suspended', 'deletion_scheduled', 'deleting'].includes(m.status)) return { skipped: true };
    await ctx.mail.suspendMailbox(m.mail_engine_account_id);
  },

  async 'mailbox.reactivate'(ctx, job) {
    const m = await loadMailbox(ctx, job.target_id!);
    if (!m?.mail_engine_account_id || m.status !== 'active') return { skipped: true };
    await ctx.mail.reactivateMailbox(m.mail_engine_account_id);
  },

  async 'mailbox.quota'(ctx, job) {
    const m = await loadMailbox(ctx, job.target_id!);
    if (!m?.mail_engine_account_id || !['active', 'suspended'].includes(m.status)) return { skipped: true };
    await ctx.mail.updateMailboxQuota(m.mail_engine_account_id, Number(m.quota_bytes));
  },

  async 'mailbox.delete'(ctx, job) {
    const m = await loadMailbox(ctx, job.target_id!);
    if (!m || m.status !== 'deleting') return { skipped: true };
    if (m.mail_engine_account_id) {
      const existing = await ctx.mail.getMailbox(m.mail_engine_account_id);
      if (existing) await ctx.mail.deleteMailbox(m.mail_engine_account_id);
    }
    await exec(ctx.db, "UPDATE mailboxes SET status = 'deleted', deleted_at = NOW(3), claim_address = NULL, mail_engine_account_id = NULL WHERE id = ?", [m.id]);
    await exec(ctx.db, 'DELETE FROM address_claims WHERE address = ? AND owner_id = ?', [m.normalized_address, m.id]);
    await audit(ctx.db, { actorType: 'worker', tenantId: m.tenant_id, action: 'mailbox.deleted', targetType: 'mailbox', targetId: m.id, outcome: 'success' });
  },

  async 'alias.ensure'(ctx, job) {
    const a = await one<{ id: string; tenant_id: string; domain_id: string; local_part: string; source_address: string; destination_address: string; status: string; mail_engine_domain_id: string | null }>(
      ctx.db,
      'SELECT a.*, d.mail_engine_domain_id FROM aliases a JOIN domains d ON d.id = a.domain_id WHERE a.id = ?',
      [job.target_id],
    );
    if (!a || !['provisioning', 'active', 'failed'].includes(a.status)) return { skipped: true };
    if (!a.mail_engine_domain_id) throw new MailServerError('unavailable', 'The domain is not ready on the mail server yet.');
    const alias = await ctx.mail.ensureAlias({ appAliasId: a.id, engineDomainId: a.mail_engine_domain_id, localPart: a.local_part, address: a.source_address, recipients: [a.destination_address] });
    await exec(ctx.db, "UPDATE aliases SET mail_engine_ref = ?, status = 'active' WHERE id = ?", [alias.engineRef, a.id]);
  },

  async 'alias.remove'(ctx, job) {
    const a = await one<{ id: string; source_address: string; mail_engine_ref: string | null; status: string }>(ctx.db, 'SELECT id, source_address, mail_engine_ref, status FROM aliases WHERE id = ?', [job.target_id]);
    if (!a || a.status !== 'deleting') return { skipped: true };
    if (a.mail_engine_ref) await ctx.mail.removeAlias(a.mail_engine_ref);
    await exec(ctx.db, "UPDATE aliases SET status = 'deleted', claim_address = NULL, mail_engine_ref = NULL WHERE id = ?", [a.id]);
    await exec(ctx.db, 'DELETE FROM address_claims WHERE address = ? AND owner_id = ?', [a.source_address, a.id]);
  },
};

/** Marks the user-facing object as failed once its job has permanently failed. */
async function onTerminalFailure(ctx: AppContext, job: JobRow, message: string): Promise<void> {
  if (job.operation === 'mailbox.create' && job.target_id) {
    await exec(ctx.db, "UPDATE mailboxes SET status = 'provisioning_failed' WHERE id = ? AND status = 'provisioning'", [job.target_id]);
  } else if (job.operation === 'domain.provision' && job.target_id) {
    await exec(ctx.db, "UPDATE domains SET provisioning_status = 'failed' WHERE id = ? AND provisioning_status <> 'ready'", [job.target_id]);
  } else if (job.operation === 'alias.ensure' && job.target_id) {
    await exec(ctx.db, "UPDATE aliases SET status = 'failed' WHERE id = ? AND status = 'provisioning'", [job.target_id]);
  }
  if (job.tenant_id) {
    await notifyTenantAdmins(ctx, ctx.db, job.tenant_id, {
      type: 'provisioning_failed',
      severity: 'warning',
      title: 'Setup problem needs attention',
      body: 'A mailbox, alias or domain operation could not be completed automatically. ARTHVEX operations have been alerted. No action is needed from you unless support contacts you.',
      link: '/dashboard',
      dedupeKey: `provfail:${job.id}`,
    }).catch(() => undefined);
  }
  await audit(ctx.db, { actorType: 'worker', tenantId: job.tenant_id, action: 'job.terminal_failure', targetType: job.target_type, targetId: job.target_id, outcome: 'failure', metadata: { operation: job.operation, jobId: job.id, message } });
}

/**
 * Runs one claimed job and records its outcome:
 *  - unavailable → retry with backoff (nothing was applied)
 *  - uncertain / unexpected → retry flagged for reconciliation (handlers re-read engine state first)
 *  - invalid / conflict / unauthorized → no retry; operator review
 */
export async function runJob(ctx: AppContext, job: JobRow): Promise<'succeeded' | 'retrying' | 'needs_manual_review' | 'failed'> {
  const handler = handlers[job.operation];
  if (!handler) {
    await markFailed(ctx.db, job.id, 'failed', 'unknown_operation', `Unknown operation ${job.operation}`);
    return 'failed';
  }
  try {
    const result = await handler(ctx, job);
    await markSucceeded(ctx.db, job.id, result ?? undefined);
    return 'succeeded';
  } catch (err) {
    if (err instanceof PermanentError) {
      await markFailed(ctx.db, job.id, err.review ? 'needs_manual_review' : 'failed', err.code, err.message);
      await onTerminalFailure(ctx, job, err.message);
      return err.review ? 'needs_manual_review' : 'failed';
    }
    if (err instanceof MailServerError) {
      if (err.kind === 'unavailable' || err.kind === 'uncertain') {
        const outcome = await markRetry(ctx.db, job, `engine_${err.kind}`, err.message, err.kind === 'uncertain');
        if (outcome === 'needs_manual_review') await onTerminalFailure(ctx, job, err.message);
        return outcome;
      }
      const status = err.kind === 'invalid' ? 'failed' : 'needs_manual_review';
      await markFailed(ctx.db, job.id, status, `engine_${err.kind}`, err.message);
      await onTerminalFailure(ctx, job, err.message);
      return status;
    }
    ctx.log.error({ jobId: job.id, operation: job.operation, err: (err as Error).message }, 'job crashed');
    const outcome = await markRetry(ctx.db, job, 'internal_error', 'Unexpected internal error; will retry.', true);
    if (outcome === 'needs_manual_review') await onTerminalFailure(ctx, job, 'internal error');
    return outcome;
  }
}

/** Moves mailboxes whose grace period has ended into deletion. Called by the worker scheduler. */
export async function startDueDeletions(ctx: AppContext): Promise<number> {
  const { enqueue } = await import('../jobs/jobs.repository.js');
  const due = await rows<{ id: string; tenant_id: string }>(ctx.db, "SELECT id, tenant_id FROM mailboxes WHERE status = 'deletion_scheduled' AND deletion_scheduled_for <= NOW(3) LIMIT 50");
  let n = 0;
  for (const m of due) {
    const res = await exec(ctx.db, "UPDATE mailboxes SET status = 'deleting' WHERE id = ? AND status = 'deletion_scheduled'", [m.id]);
    if (res.affectedRows === 1) {
      await enqueue(ctx.db, { tenantId: m.tenant_id, operation: 'mailbox.delete', targetType: 'mailbox', targetId: m.id, idempotencyKey: `mailbox.delete:${m.id}` });
      n++;
    }
  }
  return n;
}
