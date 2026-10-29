import type { Db, Queryable } from '../../db/pool.js';
import { exec, isDuplicateKey, one, rows, toJson, tx } from '../../db/pool.js';
import { newId } from '../../shared/ids.js';

export type JobOperation =
  | 'domain.provision'
  | 'domain.remove'
  | 'mailbox.create'
  | 'mailbox.suspend'
  | 'mailbox.reactivate'
  | 'mailbox.quota'
  | 'mailbox.delete'
  | 'alias.ensure'
  | 'alias.remove';

export interface JobRow {
  id: string;
  tenant_id: string | null;
  operation: JobOperation;
  target_type: 'domain' | 'mailbox' | 'alias' | 'tenant' | 'platform';
  target_id: string | null;
  idempotency_key: string;
  payload: Record<string, unknown> | null;
  status: string;
  attempts: number;
  max_attempts: number;
  needs_reconcile: number;
  run_after: Date;
}

export interface EnqueueInput {
  tenantId: string | null;
  operation: JobOperation;
  targetType: JobRow['target_type'];
  targetId: string | null;
  /** Same key → same job. Callers include enough context (e.g. a generation counter) to allow legitimate repeats. */
  idempotencyKey: string;
  /** Must never contain passwords, tokens or keys. */
  payload?: Record<string, unknown> | null;
  createdBy?: string | null;
  maxAttempts?: number;
}

/** Inserts a job; a duplicate idempotency key returns the existing job instead of creating another. */
export async function enqueue(db: Queryable, input: EnqueueInput): Promise<{ id: string; created: boolean }> {
  const id = newId();
  try {
    await exec(
      db,
      `INSERT INTO provisioning_jobs (id, tenant_id, operation, target_type, target_id, idempotency_key, payload, max_attempts, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, input.tenantId, input.operation, input.targetType, input.targetId, input.idempotencyKey, toJson(input.payload), input.maxAttempts ?? 6, input.createdBy ?? null],
    );
    return { id, created: true };
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
    const existing = await one<{ id: string }>(db, 'SELECT id FROM provisioning_jobs WHERE idempotency_key = ?', [input.idempotencyKey]);
    return { id: existing!.id, created: false };
  }
}

/** Atomically claims the oldest runnable job. `FOR UPDATE SKIP LOCKED` prevents two workers from taking the same row. */
export async function claimNext(db: Db, workerId: string, leaseSeconds: number): Promise<JobRow | null> {
  return tx(db, async (conn) => {
    const job = await one<JobRow>(
      conn,
      `SELECT * FROM provisioning_jobs WHERE status IN ('queued','retrying') AND run_after <= NOW(3)
        ORDER BY run_after, id LIMIT 1 FOR UPDATE SKIP LOCKED`,
    );
    if (!job) return null;
    await exec(
      conn,
      `UPDATE provisioning_jobs SET status = 'running', attempts = attempts + 1, locked_by = ?, locked_until = DATE_ADD(NOW(3), INTERVAL ? SECOND),
              started_at = COALESCE(started_at, NOW(3)) WHERE id = ?`,
      [workerId, leaseSeconds, job.id],
    );
    return { ...job, attempts: job.attempts + 1, status: 'running' };
  });
}

/** Jobs whose worker died mid-flight: the outcome is uncertain, so they are reconciled before retrying. */
export async function reclaimExpired(db: Queryable): Promise<number> {
  const res = await exec(
    db,
    `UPDATE provisioning_jobs SET status = IF(attempts >= max_attempts, 'needs_manual_review', 'retrying'), needs_reconcile = 1,
            locked_by = NULL, locked_until = NULL, run_after = NOW(3),
            last_error_code = 'lease_expired', last_error_message = 'Worker stopped before finishing; outcome will be reconciled.'
      WHERE status = 'running' AND locked_until < NOW(3)`,
  );
  return res.affectedRows;
}

export async function markSucceeded(db: Queryable, id: string, result?: Record<string, unknown>): Promise<void> {
  await exec(
    db,
    `UPDATE provisioning_jobs SET status = 'succeeded', locked_by = NULL, locked_until = NULL, needs_reconcile = 0, last_error_code = NULL, last_error_message = NULL,
            result = ?, completed_at = NOW(3) WHERE id = ?`,
    [toJson(result), id],
  );
}

export function backoffSeconds(attempt: number): number {
  return Math.min(3600, 15 * 2 ** Math.max(0, attempt - 1));
}

export async function markRetry(db: Queryable, job: JobRow, code: string, message: string, reconcile: boolean): Promise<'retrying' | 'needs_manual_review'> {
  const exhausted = job.attempts >= job.max_attempts;
  await exec(
    db,
    `UPDATE provisioning_jobs SET status = ?, needs_reconcile = ?, locked_by = NULL, locked_until = NULL,
            run_after = DATE_ADD(NOW(3), INTERVAL ? SECOND), last_error_code = ?, last_error_message = ? WHERE id = ?`,
    [exhausted ? 'needs_manual_review' : 'retrying', reconcile || exhausted ? 1 : 0, backoffSeconds(job.attempts), code.slice(0, 64), message.slice(0, 500), job.id],
  );
  return exhausted ? 'needs_manual_review' : 'retrying';
}

export async function markFailed(db: Queryable, id: string, status: 'failed' | 'needs_manual_review', code: string, message: string): Promise<void> {
  await exec(
    db,
    `UPDATE provisioning_jobs SET status = ?, locked_by = NULL, locked_until = NULL, last_error_code = ?, last_error_message = ?, completed_at = NOW(3) WHERE id = ?`,
    [status, code.slice(0, 64), message.slice(0, 500), id],
  );
}

/** Operator action: return a failed/manual-review job to the queue, forcing reconciliation first. */
export async function requeue(db: Queryable, id: string): Promise<boolean> {
  const res = await exec(
    db,
    `UPDATE provisioning_jobs SET status = 'queued', needs_reconcile = 1, attempts = 0, run_after = NOW(3), completed_at = NULL
      WHERE id = ? AND status IN ('failed','needs_manual_review')`,
    [id],
  );
  return res.affectedRows === 1;
}

export async function cancelJob(db: Queryable, id: string): Promise<boolean> {
  const res = await exec(db, "UPDATE provisioning_jobs SET status = 'cancelled', completed_at = NOW(3) WHERE id = ? AND status IN ('queued','retrying','failed','needs_manual_review')", [id]);
  return res.affectedRows === 1;
}

export async function queueDepth(db: Queryable) {
  const list = await rows<{ status: string; n: number }>(db, "SELECT status, COUNT(*) AS n FROM provisioning_jobs WHERE status IN ('queued','retrying','running','failed','needs_manual_review') GROUP BY status");
  return Object.fromEntries(list.map((r) => [r.status, Number(r.n)])) as Record<string, number>;
}
