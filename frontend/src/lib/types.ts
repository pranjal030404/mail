export type TenantRole = 'owner' | 'admin' | 'mailbox_user' | 'billing';
export type PlatformRole = 'none' | 'operations' | 'super_admin' | 'support' | 'custom';

export interface Me {
  csrfToken: string;
  mfaPending: boolean;
  mfaSetupRequired: boolean;
  user: { id: string; email: string; displayName: string; mfaEnabled: boolean; platformRole: PlatformRole; roleKey?: string | null; permissions?: string[]; timezone: string; locale: string };
  memberships: { tenantId: string; name: string; slug: string; role: TenantRole; tenantStatus: string }[];
}

export interface DnsRecord {
  type: string;
  name: string;
  value: string;
  priority?: number;
  purpose: string;
  required: boolean;
}

export interface DnsCheck {
  type: string;
  name: string;
  expected: string | null;
  observed: string | null;
  status: 'pass' | 'warning' | 'fail' | 'error' | 'pending';
  message: string | null;
  checkedAt: string;
}

export interface DomainSummary {
  id: string;
  name: string;
  unicodeName: string;
  status: string;
  ownershipStatus: string;
  inboundStatus: string;
  outboundStatus: string;
  provisioningStatus: string;
  mailboxCount?: number;
  lastDnsCheckAt: string | null;
}

export interface DomainDetail extends DomainSummary {
  verifiedAt: string | null;
  ownershipInstruction: { recordType: string; name: string; value: string; expiresAt: string; ttlGuidance: string } | null;
  expectedRecords: DnsRecord[] | null;
  checks: DnsCheck[];
  propagationNote: string;
}

export interface Mailbox {
  id: string;
  domainId: string;
  address: string;
  localPart: string;
  displayName: string | null;
  quotaBytes: number;
  usedBytes: number | null;
  usageCollectedAt: string | null;
  status: string;
  suspendedReason: string | null;
  suspendedBy: string | null;
  credentialsSet: boolean;
  deletionScheduledFor: string | null;
  createdAt: string;
}

export interface Alias {
  id: string;
  domainId: string;
  source: string;
  destinationType: 'mailbox' | 'external';
  destination: string;
  status: string;
  awaitingConfirmation: boolean;
}

export type WebmailFolderRole = 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'other';

export interface WebmailFolder {
  id: string;
  name: string;
  role: WebmailFolderRole;
  totalMessages: number;
  unreadMessages: number;
  parentId: string | null;
}

export interface WebmailAddress {
  name: string | null;
  email: string;
}

export interface WebmailMessageSummary {
  id: string;
  threadId: string | null;
  folderIds: string[];
  from: WebmailAddress[];
  to: WebmailAddress[];
  subject: string;
  preview: string;
  receivedAt: string;
  unread: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  size: number;
}

export interface WebmailAttachment {
  partId: string;
  blobId: string | null;
  name: string;
  type: string;
  size: number;
}

export interface WebmailMessage extends WebmailMessageSummary {
  cc: WebmailAddress[];
  bcc: WebmailAddress[];
  replyTo: WebmailAddress[];
  sentAt: string | null;
  html: string | null;
  text: string;
  attachments: WebmailAttachment[];
  remoteImagesBlocked: number;
}

export interface WebmailPreferences {
  signature: string;
  blockRemoteImages: boolean;
}

export interface AccessGrant {
  id: string;
  tenantId: string;
  tenantName: string | null;
  mailboxId: string;
  mailboxAddress: string | null;
  requestedBy: string;
  approvedBy: string | null;
  reason: string;
  scope: 'read';
  status: 'pending_approval' | 'active' | 'denied' | 'revoked' | 'expired';
  supportTicketId: string | null;
  requestedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  useCount: number;
}

export interface Usage {
  counts: { domains: number; mailboxes: number; aliases: number };
  limits: { domains: number; mailboxes: number; aliases: number; storageBytes: number; dailySendLimit: number; attachmentMaxBytes: number };
  storage: { allocatedBytes: number; usedBytes: number; allocatedPercent: number };
  mailboxes: { id: string; address: string; status: string; quotaBytes: number; usedBytes: number | null; percent: number | null; threshold: number | null }[];
  collectedAt: string | null;
  note: string;
}
