export const MAILBOX_STATUSES = [
  'draft',
  'provisioning',
  'provisioning_failed',
  'active',
  'suspended',
  'deletion_scheduled',
  'deleting',
  'deleted',
  'retained',
] as const;
export type MailboxStatus = (typeof MAILBOX_STATUSES)[number];

const MAILBOX_TRANSITIONS: Record<MailboxStatus, readonly MailboxStatus[]> = {
  draft: ['provisioning'],
  provisioning: ['active', 'provisioning_failed'],
  provisioning_failed: ['provisioning', 'deleted'],
  active: ['suspended', 'deletion_scheduled'],
  suspended: ['active', 'deletion_scheduled'],
  deletion_scheduled: ['active', 'suspended', 'deleting'],
  deleting: ['deleted', 'retained', 'deletion_scheduled'],
  deleted: [],
  retained: ['deleted'],
};

export function canTransitionMailbox(from: MailboxStatus, to: MailboxStatus): boolean {
  return MAILBOX_TRANSITIONS[from]?.includes(to) ?? false;
}

export const JOB_STATUSES = ['queued', 'running', 'succeeded', 'retrying', 'failed', 'needs_manual_review', 'cancelled'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

const JOB_TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  queued: ['running', 'cancelled'],
  running: ['succeeded', 'retrying', 'failed', 'needs_manual_review'],
  retrying: ['running', 'cancelled', 'needs_manual_review'],
  succeeded: [],
  failed: ['queued', 'cancelled'],
  needs_manual_review: ['queued', 'cancelled'],
  cancelled: [],
};

export function canTransitionJob(from: JobStatus, to: JobStatus): boolean {
  return JOB_TRANSITIONS[from]?.includes(to) ?? false;
}

export const DOMAIN_STATUSES = ['pending_verification', 'verified', 'active', 'suspended', 'removal_scheduled', 'removed'] as const;
export type DomainStatus = (typeof DOMAIN_STATUSES)[number];

export type CheckStatus = 'pass' | 'warning' | 'fail' | 'error' | 'pending';
export type ReadinessStatus = 'unknown' | 'ok' | 'warning' | 'error';

export const MAILBOX_STATUS_LABELS: Record<MailboxStatus, string> = {
  draft: 'Draft',
  provisioning: 'Provisioning',
  provisioning_failed: 'Provisioning failed',
  active: 'Active',
  suspended: 'Suspended',
  deletion_scheduled: 'Deletion scheduled',
  deleting: 'Deleting',
  deleted: 'Deleted',
  retained: 'Retained',
};
