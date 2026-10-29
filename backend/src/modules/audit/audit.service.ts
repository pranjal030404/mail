import { exec, toJson, type Queryable } from '../../db/pool.js';

export interface AuditEntry {
  actorType: 'user' | 'platform_admin' | 'system' | 'worker' | 'anonymous';
  actorUserId?: string | null;
  /** Platform-admin actor, separate from tenant users. */
  actorAdminId?: string | null;
  tenantId?: string | null;
  action: string;
  targetType?: string | null;
  targetId?: string | null;
  outcome: 'success' | 'failure' | 'denied';
  reason?: string | null;
  correlationId?: string | null;
  ip?: string | null;
  /** Must never include passwords, tokens, keys or message content. */
  metadata?: Record<string, unknown> | null;
}

const FORBIDDEN_KEYS = /pass(word)?|secret|token|key|otp|code|cookie|authorization/i;

/** Defence in depth: strip suspicious keys even if a caller passes them by mistake. */
export function sanitizeMetadata(meta: Record<string, unknown> | null | undefined): Record<string, unknown> | null {
  if (!meta) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (FORBIDDEN_KEYS.test(k)) continue;
    out[k] = typeof v === 'string' && v.length > 500 ? `${v.slice(0, 500)}…` : v;
  }
  return out;
}

export async function audit(db: Queryable, e: AuditEntry): Promise<void> {
  await exec(
    db,
    `INSERT INTO audit_logs (actor_type, actor_user_id, actor_admin_id, tenant_id, action, target_type, target_id, outcome, reason, correlation_id, ip, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      e.actorType,
      e.actorUserId ?? null,
      e.actorAdminId ?? null,
      e.tenantId ?? null,
      e.action,
      e.targetType ?? null,
      e.targetId ?? null,
      e.outcome,
      e.reason ? e.reason.slice(0, 500) : null,
      e.correlationId ?? null,
      e.ip ?? null,
      toJson(sanitizeMetadata(e.metadata)),
    ],
  );
}
