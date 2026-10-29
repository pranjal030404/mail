/** Configurable plan entitlements. All limits are hard limits; `null` is never "unlimited". */
export interface Limits {
  maxDomains: number;
  maxMailboxes: number;
  maxMailboxesPerDomain: number;
  maxAliases: number;
  mailboxQuotaDefaultBytes: number;
  mailboxQuotaMaxBytes: number;
  tenantStorageMaxBytes: number;
  attachmentMaxBytes: number;
  dailySendLimit: number;
  hourlySendLimit: number;
  allowExternalForwarding: boolean;
  allowCatchAll: boolean;
  warnThresholds: number[];
}

export type LimitOverrides = Partial<{ [K in keyof Limits]: Limits[K] | null }>;

export function effectiveLimits(plan: Limits, overrides?: LimitOverrides | null): Limits {
  const out: Limits = { ...plan, warnThresholds: [...plan.warnThresholds] };
  if (!overrides) return out;
  for (const key of Object.keys(overrides) as (keyof Limits)[]) {
    const v = overrides[key];
    if (v !== null && v !== undefined) {
      (out as unknown as Record<string, unknown>)[key] = v;
    }
  }
  return out;
}

export interface TenantUsageCounts {
  domains: number;
  mailboxes: number;
  aliases: number;
  /** Sum of quota allocated to non-deleted mailboxes. */
  allocatedBytes: number;
}

export type EntitlementCheck = { ok: true } | { ok: false; code: string; message: string };

const ok: EntitlementCheck = { ok: true };

export function checkCanAddDomain(usage: TenantUsageCounts, limits: Limits): EntitlementCheck {
  if (usage.domains >= limits.maxDomains) {
    return { ok: false, code: 'plan_limit_domains', message: `Your plan allows ${limits.maxDomains} domain(s). Remove a domain or change plan to add another.` };
  }
  return ok;
}

export function checkCanAddMailbox(
  usage: TenantUsageCounts,
  mailboxesInDomain: number,
  requestedQuotaBytes: number,
  limits: Limits,
): EntitlementCheck {
  if (usage.mailboxes >= limits.maxMailboxes) {
    return { ok: false, code: 'plan_limit_mailboxes', message: `Your plan allows ${limits.maxMailboxes} mailbox(es) in total.` };
  }
  if (mailboxesInDomain >= limits.maxMailboxesPerDomain) {
    return { ok: false, code: 'plan_limit_mailboxes_per_domain', message: `Your plan allows ${limits.maxMailboxesPerDomain} mailbox(es) per domain.` };
  }
  return checkQuotaAllocation(usage.allocatedBytes, requestedQuotaBytes, limits);
}

export function checkQuotaAllocation(currentAllocatedBytes: number, requestedQuotaBytes: number, limits: Limits): EntitlementCheck {
  if (!Number.isFinite(requestedQuotaBytes) || requestedQuotaBytes <= 0) {
    return { ok: false, code: 'invalid_quota', message: 'Mailbox quota must be a positive size.' };
  }
  if (requestedQuotaBytes > limits.mailboxQuotaMaxBytes) {
    return { ok: false, code: 'plan_limit_mailbox_quota', message: `The maximum mailbox size on your plan is ${formatBytes(limits.mailboxQuotaMaxBytes)}.` };
  }
  if (currentAllocatedBytes + requestedQuotaBytes > limits.tenantStorageMaxBytes) {
    const remaining = Math.max(0, limits.tenantStorageMaxBytes - currentAllocatedBytes);
    return {
      ok: false,
      code: 'plan_limit_tenant_storage',
      message: `Not enough workspace storage. ${formatBytes(remaining)} of ${formatBytes(limits.tenantStorageMaxBytes)} is still unallocated.`,
    };
  }
  return ok;
}

export function checkCanAddAlias(usage: TenantUsageCounts, limits: Limits): EntitlementCheck {
  if (usage.aliases >= limits.maxAliases) {
    return { ok: false, code: 'plan_limit_aliases', message: `Your plan allows ${limits.maxAliases} alias(es).` };
  }
  return ok;
}

export function usagePercent(usedBytes: number, quotaBytes: number): number {
  if (quotaBytes <= 0) return 100;
  return Math.min(100, Math.round((usedBytes / quotaBytes) * 1000) / 10);
}

/** Returns the highest configured threshold that the usage has reached, or null. */
export function highestThresholdReached(usedBytes: number, quotaBytes: number, thresholds: number[]): number | null {
  const pct = quotaBytes <= 0 ? 100 : (usedBytes / quotaBytes) * 100;
  const reached = [...thresholds].sort((a, b) => a - b).filter((t) => pct >= t);
  return reached.length ? reached[reached.length - 1]! : null;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

export const MB = 1024 * 1024;
export const GB = 1024 * MB;
