import { parseZoneFile } from '../dns/zone.js';
import { JmapClient, setResult, type JmapClientOptions } from './jmap-client.js';
import {
  MailServerError,
  markerFor,
  type CreateMailboxInput,
  type EngineAlias,
  type EngineMailbox,
  type EnsureAliasInput,
  type ExpectedDnsRecord,
  type MailServerAdapter,
} from './mail-server.interface.js';

/**
 * Adapter for Stalwart Mail Server v0.16.x using its JMAP management API
 * (`urn:stalwart:jmap`, objects `x:Domain`, `x:Account`, `x:MailingList`, `x:DkimSignature`).
 *
 * Verified against v0.16.27 in the local lab (see docs/mail-server-setup.md):
 *  - x:Account/query supports filters `name` + `domainId`; x:MailingList/query has no filters.
 *  - Suspension = permissions {"@type":"Merge","disabledPermissions":{"authenticate":true,"emailSend":true}}.
 *  - Disk quota = quotas.maxDiskQuota (bytes); usage = usedDiskQuota (bytes).
 *  - Domains with linked accounts/lists/DKIM keys cannot be destroyed (objectIsLinked).
 * Aliases are implemented as x:MailingList objects with explicit recipients.
 */
export class StalwartAdapter implements MailServerAdapter {
  readonly kind = 'stalwart' as const;
  readonly description = 'Stalwart Mail Server v0.16 (JMAP management API)';
  private readonly jmap: JmapClient;

  constructor(opts: JmapClientOptions) {
    this.jmap = new JmapClient(opts);
  }

  async healthCheck(): Promise<{ ok: boolean; detail: string }> {
    try {
      await this.jmap.one('x:Domain/query', { limit: 1 });
      return { ok: true, detail: 'Management API reachable' };
    } catch (err) {
      const e = err as MailServerError;
      return { ok: false, detail: e.kind === 'unauthorized' ? 'Management credentials rejected' : 'Management API unreachable' };
    }
  }

  // ---------------------------------------------------------------- domains

  private async findDomainId(domain: string): Promise<string | null> {
    const resp = await this.jmap.one('x:Domain/query', { filter: { name: domain } });
    const ids = (resp.ids as string[] | undefined) ?? [];
    return ids[0] ?? null;
  }

  async ensureDomain(domain: string): Promise<{ engineDomainId: string }> {
    const existing = await this.findDomainId(domain);
    if (existing) return { engineDomainId: existing };
    try {
      const resp = await this.jmap.one('x:Domain/set', { create: { d: { name: domain, description: 'Managed by ARTHVEX' } } }, true);
      const created = setResult(resp, 'd', 'created');
      return { engineDomainId: String(created?.id) };
    } catch (err) {
      // A concurrent or previous uncertain attempt may have created it: converge.
      if (err instanceof MailServerError && err.kind === 'conflict') {
        const id = await this.findDomainId(domain);
        if (id) return { engineDomainId: id };
      }
      throw err;
    }
  }

  async getDomainDnsRecords(engineDomainId: string, domain: string): Promise<ExpectedDnsRecord[]> {
    const resp = await this.jmap.one('x:Domain/get', { ids: [engineDomainId], properties: ['name', 'dnsZoneFile'] });
    const item = ((resp.list as Record<string, unknown>[]) ?? [])[0];
    if (!item) throw new MailServerError('not_found', 'Domain not found on the mail server.');
    return parseZoneFile(String(item.dnsZoneFile ?? ''), domain);
  }

  async setCatchAll(engineDomainId: string, address: string | null): Promise<void> {
    const resp = await this.jmap.one('x:Domain/set', { update: { [engineDomainId]: { catchAllAddress: address } } }, true);
    setResult(resp, engineDomainId, 'updated');
  }

  async removeDomain(engineDomainId: string): Promise<void> {
    const dkim = await this.jmap.one('x:DkimSignature/query', { filter: { domainId: engineDomainId } });
    const dkimIds = (dkim.ids as string[] | undefined) ?? [];
    if (dkimIds.length) {
      const r = await this.jmap.one('x:DkimSignature/set', { destroy: dkimIds }, true);
      for (const id of dkimIds) {
        try {
          setResult(r, id, 'destroyed');
        } catch (err) {
          if (!(err instanceof MailServerError && err.kind === 'not_found')) throw err;
        }
      }
    }
    const resp = await this.jmap.one('x:Domain/set', { destroy: [engineDomainId] }, true);
    try {
      setResult(resp, engineDomainId, 'destroyed');
    } catch (err) {
      if (err instanceof MailServerError && err.kind === 'not_found') return;
      throw err;
    }
  }

  // -------------------------------------------------------------- mailboxes

  private static readonly ACCOUNT_PROPS = ['name', 'domainId', 'emailAddress', 'usedDiskQuota', 'quotas', 'permissions', 'description'];

  private toMailbox(raw: Record<string, unknown>): EngineMailbox {
    const perms = raw.permissions as { '@type'?: string; disabledPermissions?: Record<string, boolean> } | undefined;
    const quotas = raw.quotas as Record<string, number> | undefined;
    return {
      engineId: String(raw.id),
      address: String(raw.emailAddress ?? ''),
      usedBytes: Number(raw.usedDiskQuota ?? 0),
      quotaBytes: quotas?.maxDiskQuota ?? null,
      suspended: Boolean(perms?.disabledPermissions?.authenticate),
      marker: typeof raw.description === 'string' ? raw.description : null,
    };
  }

  async findMailbox(engineDomainId: string, localPart: string): Promise<EngineMailbox | null> {
    const q = await this.jmap.one('x:Account/query', { filter: { name: localPart, domainId: engineDomainId } });
    const id = ((q.ids as string[] | undefined) ?? [])[0];
    return id ? this.getMailbox(id) : null;
  }

  async getMailbox(engineId: string): Promise<EngineMailbox | null> {
    const resp = await this.jmap.one('x:Account/get', { ids: [engineId], properties: StalwartAdapter.ACCOUNT_PROPS });
    const item = ((resp.list as Record<string, unknown>[]) ?? [])[0];
    return item ? this.toMailbox(item) : null;
  }

  async listMailboxes(engineDomainId: string): Promise<EngineMailbox[]> {
    const q = await this.jmap.one('x:Account/query', { filter: { domainId: engineDomainId } });
    const ids = (q.ids as string[] | undefined) ?? [];
    if (!ids.length) return [];
    const out: EngineMailbox[] = [];
    for (let i = 0; i < ids.length; i += 200) {
      const resp = await this.jmap.one('x:Account/get', { ids: ids.slice(i, i + 200), properties: StalwartAdapter.ACCOUNT_PROPS });
      for (const item of (resp.list as Record<string, unknown>[]) ?? []) out.push(this.toMailbox(item));
    }
    return out;
  }

  async createMailbox(input: CreateMailboxInput): Promise<EngineMailbox> {
    const marker = markerFor('mailbox', input.appMailboxId);
    const existing = await this.findMailbox(input.engineDomainId, input.localPart);
    if (existing) {
      if (existing.marker !== marker) {
        throw new MailServerError('conflict', 'An account with this address already exists on the mail server and is not owned by this mailbox.');
      }
      return existing;
    }
    const resp = await this.jmap.one(
      'x:Account/set',
      {
        create: {
          a: {
            '@type': 'User',
            name: input.localPart,
            domainId: input.engineDomainId,
            description: marker,
            quotas: { maxDiskQuota: input.quotaBytes },
          },
        },
      },
      true,
    );
    const created = setResult(resp, 'a', 'created');
    const mailbox = await this.getMailbox(String(created?.id));
    if (!mailbox) throw new MailServerError('uncertain', 'Mailbox was created but could not be read back.');
    return mailbox;
  }

  private async updateAccount(engineId: string, patch: Record<string, unknown>): Promise<void> {
    const resp = await this.jmap.one('x:Account/set', { update: { [engineId]: patch } }, true);
    setResult(resp, engineId, 'updated');
  }

  updateMailboxQuota(engineId: string, quotaBytes: number): Promise<void> {
    return this.updateAccount(engineId, { quotas: { maxDiskQuota: quotaBytes } });
  }

  setMailboxPassword(engineId: string, password: string): Promise<void> {
    return this.updateAccount(engineId, { credentials: { '0': { '@type': 'Password', secret: password } } });
  }

  /**
   * Creates a mailbox-scoped API key for the webmail proxy. The secret is generated by Stalwart and
   * returned exactly once, then encrypted locally. The key carries only the target mailbox's own
   * permissions (Inherit); it cannot call management methods unless that account could anyway.
   */
  async createMailboxWebmailKey(engineId: string, description: string): Promise<{ keyId: string; secret: string }> {
    const existing = await this.jmap.one('x:ApiKey/get', { ids: null }, false, { accountId: engineId });
    const keys = (existing.list as Record<string, unknown>[]) ?? [];
    for (const key of keys) {
      if (key.description !== description) continue;
      // An existing key's secret cannot be read back, so it cannot be adopted. Rotate it.
      await this.deleteMailboxWebmailKey(engineId, String(key.id));
    }
    const resp = await this.jmap.one(
      'x:ApiKey/set',
      { create: { k: { description, permissions: { '@type': 'Inherit' } } } },
      true,
      { accountId: engineId },
    );
    const created = setResult(resp, 'k', 'created');
    const secret = typeof created?.secret === 'string' ? created.secret : null;
    if (!created?.id || !secret) {
      throw new MailServerError('uncertain', 'Mail server created a webmail key but did not return its secret.');
    }
    return { keyId: String(created.id), secret };
  }

  async deleteMailboxWebmailKey(engineId: string, keyId: string): Promise<void> {
    const resp = await this.jmap.one('x:ApiKey/set', { destroy: [keyId] }, true, { accountId: engineId });
    try {
      setResult(resp, keyId, 'destroyed');
    } catch (err) {
      if (err instanceof MailServerError && err.kind === 'not_found') return;
      throw err;
    }
  }

  suspendMailbox(engineId: string): Promise<void> {
    return this.updateAccount(engineId, {
      permissions: { '@type': 'Merge', enabledPermissions: {}, disabledPermissions: { authenticate: true, emailSend: true } },
    });
  }

  reactivateMailbox(engineId: string): Promise<void> {
    return this.updateAccount(engineId, { permissions: { '@type': 'Inherit' } });
  }

  async deleteMailbox(engineId: string): Promise<void> {
    const resp = await this.jmap.one('x:Account/set', { destroy: [engineId] }, true);
    try {
      setResult(resp, engineId, 'destroyed');
    } catch (err) {
      if (err instanceof MailServerError && err.kind === 'not_found') return;
      throw err;
    }
  }

  async getMailboxUsage(engineId: string): Promise<{ usedBytes: number; quotaBytes: number | null }> {
    const mb = await this.getMailbox(engineId);
    if (!mb) throw new MailServerError('not_found', 'Mailbox not found on the mail server.');
    return { usedBytes: mb.usedBytes, quotaBytes: mb.quotaBytes };
  }

  // ---------------------------------------------------------------- aliases

  private async allLists(): Promise<EngineAlias[]> {
    const resp = await this.jmap.one('x:MailingList/get', { ids: null, properties: ['emailAddress', 'recipients', 'description'] });
    return ((resp.list as Record<string, unknown>[]) ?? []).map((r) => ({
      engineRef: String(r.id),
      address: String(r.emailAddress ?? ''),
      recipients: Object.keys((r.recipients as Record<string, boolean>) ?? {}),
      marker: typeof r.description === 'string' ? r.description : null,
    }));
  }

  async findAlias(address: string): Promise<EngineAlias | null> {
    return (await this.allLists()).find((l) => l.address.toLowerCase() === address) ?? null;
  }

  async ensureAlias(input: EnsureAliasInput): Promise<EngineAlias> {
    const marker = markerFor('alias', input.appAliasId);
    const recipients = Object.fromEntries(input.recipients.map((r) => [r, true]));
    const existing = await this.findAlias(input.address);
    if (existing) {
      if (existing.marker !== marker) throw new MailServerError('conflict', 'This alias address already exists on the mail server.');
      const resp = await this.jmap.one('x:MailingList/set', { update: { [existing.engineRef]: { recipients } } }, true);
      setResult(resp, existing.engineRef, 'updated');
      return { ...existing, recipients: input.recipients };
    }
    const resp = await this.jmap.one(
      'x:MailingList/set',
      { create: { l: { name: input.localPart, domainId: input.engineDomainId, description: marker, recipients } } },
      true,
    );
    const created = setResult(resp, 'l', 'created');
    return { engineRef: String(created?.id), address: input.address, recipients: input.recipients, marker };
  }

  async removeAlias(engineRef: string): Promise<void> {
    const resp = await this.jmap.one('x:MailingList/set', { destroy: [engineRef] }, true);
    try {
      setResult(resp, engineRef, 'destroyed');
    } catch (err) {
      if (err instanceof MailServerError && err.kind === 'not_found') return;
      throw err;
    }
  }
}
