/**
 * ARTHVEX application-level mail-engine operations.
 *
 * These are NOT native Stalwart method names. Each adapter implements them with
 * the real API of the engine version it targets. Every operation must be
 * idempotent: calling it again after an uncertain outcome must converge to the
 * same final state, never create a duplicate.
 */

export type ExpectedRecordPurpose = 'inbound' | 'spf' | 'dkim' | 'dmarc' | 'autoconfig' | 'mta_sts' | 'tls_rpt' | 'srv' | 'other';

export interface ExpectedDnsRecord {
  type: 'MX' | 'TXT' | 'CNAME' | 'SRV' | 'A' | 'AAAA';
  /** Fully-qualified owner name without trailing dot. */
  name: string;
  value: string;
  priority?: number;
  purpose: ExpectedRecordPurpose;
  required: boolean;
}

export interface EngineMailbox {
  engineId: string;
  address: string;
  usedBytes: number;
  quotaBytes: number | null;
  suspended: boolean;
  /** Ownership marker written by ARTHVEX when the account was created ("arthvex:<mailboxId>"). */
  marker: string | null;
}

export interface EngineAlias {
  engineRef: string;
  address: string;
  recipients: string[];
  marker: string | null;
}

export interface CreateMailboxInput {
  appMailboxId: string;
  engineDomainId: string;
  localPart: string;
  address: string;
  displayName: string | null;
  quotaBytes: number;
}

export interface EnsureAliasInput {
  appAliasId: string;
  engineDomainId: string;
  localPart: string;
  address: string;
  recipients: string[];
}

export interface MailServerAdapter {
  readonly kind: 'stalwart' | 'dev';
  /** Human label for admin screens, e.g. "Stalwart v0.16 (JMAP management API)". */
  readonly description: string;

  healthCheck(): Promise<{ ok: boolean; detail: string }>;

  ensureDomain(domain: string): Promise<{ engineDomainId: string }>;
  getDomainDnsRecords(engineDomainId: string, domain: string): Promise<ExpectedDnsRecord[]>;
  setCatchAll(engineDomainId: string, address: string | null): Promise<void>;
  /** Removes the domain and its DKIM keys. Must refuse if accounts still exist. Idempotent. */
  removeDomain(engineDomainId: string): Promise<void>;

  findMailbox(engineDomainId: string, localPart: string): Promise<EngineMailbox | null>;
  getMailbox(engineId: string): Promise<EngineMailbox | null>;
  listMailboxes(engineDomainId: string): Promise<EngineMailbox[]>;
  createMailbox(input: CreateMailboxInput): Promise<EngineMailbox>;
  updateMailboxQuota(engineId: string, quotaBytes: number): Promise<void>;
  /** The password is passed straight through to the engine and never persisted or logged. */
  setMailboxPassword(engineId: string, password: string): Promise<void>;
  /**
   * Creates a mailbox-scoped API key for the ARTHVEX webmail proxy. The secret is returned once by the
   * engine, is never shown to the customer, and carries only the mailbox account's own permissions.
   */
  createMailboxWebmailKey(engineId: string, description: string): Promise<{ keyId: string; secret: string }>;
  /** Revokes the webmail proxy key. Existing webmail requests fail closed. */
  deleteMailboxWebmailKey(engineId: string, keyId: string): Promise<void>;
  suspendMailbox(engineId: string): Promise<void>;
  reactivateMailbox(engineId: string): Promise<void>;
  deleteMailbox(engineId: string): Promise<void>;
  getMailboxUsage(engineId: string): Promise<{ usedBytes: number; quotaBytes: number | null }>;

  findAlias(address: string): Promise<EngineAlias | null>;
  ensureAlias(input: EnsureAliasInput): Promise<EngineAlias>;
  removeAlias(engineRef: string): Promise<void>;
}

export type MailServerErrorKind =
  /** Engine unreachable / 5xx before the request was processed: safe to retry. */
  | 'unavailable'
  /** Request may or may not have been applied: reconcile before retrying. */
  | 'uncertain'
  /** Engine rejected the input: retrying will not help. */
  | 'invalid'
  /** Object already exists in a conflicting state. */
  | 'conflict'
  | 'not_found'
  /** Credentials or permissions for the management API are wrong. */
  | 'unauthorized';

export class MailServerError extends Error {
  constructor(
    public readonly kind: MailServerErrorKind,
    /** Sanitized message. Must never contain credentials or passwords. */
    message: string,
    public readonly engineCode?: string,
  ) {
    super(message);
    this.name = 'MailServerError';
  }

  get retryable(): boolean {
    return this.kind === 'unavailable' || this.kind === 'uncertain';
  }
}

export const markerFor = (kind: 'mailbox' | 'alias', id: string) => `arthvex:${kind}:${id}`;
