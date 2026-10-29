import { generateKeyPairSync } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  MailServerError,
  markerFor,
  type CreateMailboxInput,
  type EngineAlias,
  type EngineMailbox,
  type EnsureAliasInput,
  type ExpectedDnsRecord,
  type MailServerAdapter,
  type MailServerErrorKind,
} from './mail-server.interface.js';

/**
 * DEVELOPMENT-ONLY simulated mail engine.
 *
 * It stores account metadata in a local JSON file so the API and worker
 * processes share state. It does NOT send, receive or store any email.
 * Configuration validation refuses to start production with this adapter.
 */
interface DevState {
  domains: Record<string, { name: string; catchAll: string | null; dkimPublicKey: string }>;
  accounts: Record<string, { domainId: string; localPart: string; address: string; quotaBytes: number; usedBytes: number; suspended: boolean; hasPassword: boolean; marker: string; webmailKeyId?: string; webmailKeySecret?: string }>;
  lists: Record<string, { domainId: string; address: string; recipients: string[]; marker: string }>;
  seq: number;
}

export interface DevAdapterOptions {
  /** File used to share state between processes. `null` keeps state in memory (tests). */
  statePath: string | null;
  mailHostname: string;
}

export class DevMailServerAdapter implements MailServerAdapter {
  readonly kind = 'dev' as const;
  readonly description = 'DEVELOPMENT simulation — no real mail is sent, received or stored';
  private memory: DevState = { domains: {}, accounts: {}, lists: {}, seq: 1 };
  private injected: { kind: MailServerErrorKind; remaining: number; applyBeforeFail: boolean } | null = null;
  private unavailable = false;

  constructor(private readonly opts: DevAdapterOptions) {}

  // ------------------------------------------------------- test hooks

  /** Make the next `count` operations fail. With `applyBeforeFail`, the change is applied and then reported as uncertain. */
  failNext(kind: MailServerErrorKind, count = 1, applyBeforeFail = false): void {
    this.injected = { kind, remaining: count, applyBeforeFail };
  }

  setUnavailable(value: boolean): void {
    this.unavailable = value;
  }

  setUsage(engineId: string, usedBytes: number): void {
    this.mutate((s) => {
      const a = s.accounts[engineId];
      if (a) a.usedBytes = usedBytes;
    });
  }

  snapshot(): DevState {
    return structuredClone(this.load());
  }

  // ------------------------------------------------------- state

  private load(): DevState {
    if (!this.opts.statePath) return this.memory;
    if (!existsSync(this.opts.statePath)) return { domains: {}, accounts: {}, lists: {}, seq: 1 };
    return JSON.parse(readFileSync(this.opts.statePath, 'utf8')) as DevState;
  }

  private save(state: DevState): void {
    if (!this.opts.statePath) {
      this.memory = state;
      return;
    }
    mkdirSync(dirname(this.opts.statePath), { recursive: true });
    const tmp = `${this.opts.statePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2));
    renameSync(tmp, this.opts.statePath);
  }

  private mutate<T>(fn: (s: DevState) => T): T {
    const state = this.load();
    const out = fn(state);
    this.save(state);
    return out;
  }

  private gate(mutating: boolean): { applyThenFail: MailServerErrorKind | null } {
    if (this.unavailable) throw new MailServerError('unavailable', 'Simulated mail engine is unavailable.');
    if (this.injected && this.injected.remaining > 0) {
      this.injected.remaining--;
      const { kind, applyBeforeFail } = this.injected;
      if (this.injected.remaining === 0) this.injected = null;
      if (applyBeforeFail && mutating) return { applyThenFail: kind };
      throw new MailServerError(kind, `Simulated ${kind} failure.`);
    }
    return { applyThenFail: null };
  }

  private async run<T>(mutating: boolean, fn: () => T): Promise<T> {
    const { applyThenFail } = this.gate(mutating);
    const result = fn();
    if (applyThenFail) throw new MailServerError(applyThenFail, `Simulated ${applyThenFail} failure after applying change.`);
    return result;
  }

  private nextId(s: DevState): string {
    return `dev${s.seq++}`;
  }

  // ------------------------------------------------------- adapter

  async healthCheck() {
    return this.unavailable ? { ok: false, detail: 'Simulated outage' } : { ok: true, detail: 'Development simulation (no real mail)' };
  }

  ensureDomain(domain: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        const found = Object.entries(s.domains).find(([, d]) => d.name === domain);
        if (found) return { engineDomainId: found[0] };
        const id = this.nextId(s);
        const { publicKey } = generateKeyPairSync('ed25519');
        const der = publicKey.export({ format: 'der', type: 'spki' });
        s.domains[id] = { name: domain, catchAll: null, dkimPublicKey: der.subarray(der.length - 32).toString('base64') };
        return { engineDomainId: id };
      }),
    );
  }

  getDomainDnsRecords(engineDomainId: string, domain: string): Promise<ExpectedDnsRecord[]> {
    return this.run(false, () => {
      const d = this.load().domains[engineDomainId];
      if (!d) throw new MailServerError('not_found', 'Domain not found.');
      const host = this.opts.mailHostname;
      return [
        { type: 'MX', name: domain, value: host, priority: 10, purpose: 'inbound', required: true },
        { type: 'TXT', name: domain, value: 'v=spf1 mx -all', purpose: 'spf', required: true },
        { type: 'TXT', name: `dev-ed25519._domainkey.${domain}`, value: `v=DKIM1; k=ed25519; h=sha256; p=${d.dkimPublicKey}`, purpose: 'dkim', required: true },
        { type: 'TXT', name: `_dmarc.${domain}`, value: `v=DMARC1; p=reject; rua=mailto:postmaster@${domain}`, purpose: 'dmarc', required: true },
        { type: 'SRV', name: `_imaps._tcp.${domain}`, value: `0 1 993 ${host}`, purpose: 'srv', required: false },
        { type: 'SRV', name: `_submissions._tcp.${domain}`, value: `0 1 465 ${host}`, purpose: 'srv', required: false },
      ];
    });
  }

  setCatchAll(engineDomainId: string, address: string | null) {
    return this.run(true, () =>
      this.mutate((s) => {
        const d = s.domains[engineDomainId];
        if (!d) throw new MailServerError('not_found', 'Domain not found.');
        d.catchAll = address;
      }),
    );
  }

  removeDomain(engineDomainId: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        if (!s.domains[engineDomainId]) return;
        const linked = Object.values(s.accounts).some((a) => a.domainId === engineDomainId) || Object.values(s.lists).some((l) => l.domainId === engineDomainId);
        if (linked) throw new MailServerError('conflict', 'Object is still referenced by other mail-server objects.', 'objectIsLinked');
        delete s.domains[engineDomainId];
      }),
    );
  }

  private toMailbox(id: string, a: DevState['accounts'][string]): EngineMailbox {
    return { engineId: id, address: a.address, usedBytes: a.usedBytes, quotaBytes: a.quotaBytes, suspended: a.suspended, marker: a.marker };
  }

  findMailbox(engineDomainId: string, localPart: string) {
    return this.run(false, () => {
      const found = Object.entries(this.load().accounts).find(([, a]) => a.domainId === engineDomainId && a.localPart === localPart);
      return found ? this.toMailbox(found[0], found[1]) : null;
    });
  }

  getMailbox(engineId: string) {
    return this.run(false, () => {
      const a = this.load().accounts[engineId];
      return a ? this.toMailbox(engineId, a) : null;
    });
  }

  listMailboxes(engineDomainId: string) {
    return this.run(false, () =>
      Object.entries(this.load().accounts)
        .filter(([, a]) => a.domainId === engineDomainId)
        .map(([id, a]) => this.toMailbox(id, a)),
    );
  }

  createMailbox(input: CreateMailboxInput) {
    return this.run(true, () =>
      this.mutate((s) => {
        if (!s.domains[input.engineDomainId]) throw new MailServerError('invalid', 'Unknown domain.');
        const marker = markerFor('mailbox', input.appMailboxId);
        const found = Object.entries(s.accounts).find(([, a]) => a.address === input.address);
        if (found) {
          if (found[1].marker !== marker) throw new MailServerError('conflict', 'Account already exists and is not owned by this mailbox.');
          return this.toMailbox(found[0], found[1]);
        }
        const id = this.nextId(s);
        s.accounts[id] = {
          domainId: input.engineDomainId,
          localPart: input.localPart,
          address: input.address,
          quotaBytes: input.quotaBytes,
          usedBytes: 0,
          suspended: false,
          hasPassword: false,
          marker,
        };
        return this.toMailbox(id, s.accounts[id]!);
      }),
    );
  }

  private updateAccount(engineId: string, fn: (a: DevState['accounts'][string]) => void) {
    return this.run(true, () =>
      this.mutate((s) => {
        const a = s.accounts[engineId];
        if (!a) throw new MailServerError('not_found', 'Account not found.');
        fn(a);
      }),
    );
  }

  updateMailboxQuota(engineId: string, quotaBytes: number) {
    return this.updateAccount(engineId, (a) => (a.quotaBytes = quotaBytes));
  }

  setMailboxPassword(engineId: string, password: string) {
    if (!password) throw new MailServerError('invalid', 'Empty password.');
    // The password is discarded; the simulation only records that one was set.
    return this.updateAccount(engineId, (a) => (a.hasPassword = true));
  }

  createMailboxWebmailKey(engineId: string, description: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        const a = s.accounts[engineId];
        if (!a) throw new MailServerError('not_found', 'Account not found.');
        if (a.webmailKeyId) throw new MailServerError('conflict', 'A webmail key already exists for this account.');
        a.webmailKeyId = `webbkey_${this.nextId(s)}`;
        a.webmailKeySecret = `dev_api_${this.nextId(s)}_${description}`;
        return { keyId: a.webmailKeyId, secret: a.webmailKeySecret };
      }),
    );
  }

  deleteMailboxWebmailKey(engineId: string, keyId: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        const a = s.accounts[engineId];
        if (!a) throw new MailServerError('not_found', 'Account not found.');
        if (a.webmailKeyId === keyId) {
          delete a.webmailKeyId;
          delete a.webmailKeySecret;
        }
      }),
    );
  }

  suspendMailbox(engineId: string) {
    return this.updateAccount(engineId, (a) => (a.suspended = true));
  }

  reactivateMailbox(engineId: string) {
    return this.updateAccount(engineId, (a) => (a.suspended = false));
  }

  deleteMailbox(engineId: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        delete s.accounts[engineId];
      }),
    );
  }

  getMailboxUsage(engineId: string) {
    return this.run(false, () => {
      const a = this.load().accounts[engineId];
      if (!a) throw new MailServerError('not_found', 'Account not found.');
      return { usedBytes: a.usedBytes, quotaBytes: a.quotaBytes };
    });
  }

  findAlias(address: string) {
    return this.run(false, () => {
      const found = Object.entries(this.load().lists).find(([, l]) => l.address === address);
      return found ? ({ engineRef: found[0], address, recipients: found[1].recipients, marker: found[1].marker } satisfies EngineAlias) : null;
    });
  }

  ensureAlias(input: EnsureAliasInput) {
    return this.run(true, () =>
      this.mutate((s) => {
        const marker = markerFor('alias', input.appAliasId);
        const found = Object.entries(s.lists).find(([, l]) => l.address === input.address);
        if (found) {
          if (found[1].marker !== marker) throw new MailServerError('conflict', 'Alias already exists.');
          found[1].recipients = [...input.recipients];
          return { engineRef: found[0], address: input.address, recipients: input.recipients, marker };
        }
        const id = this.nextId(s);
        s.lists[id] = { domainId: input.engineDomainId, address: input.address, recipients: [...input.recipients], marker };
        return { engineRef: id, address: input.address, recipients: input.recipients, marker };
      }),
    );
  }

  removeAlias(engineRef: string) {
    return this.run(true, () =>
      this.mutate((s) => {
        delete s.lists[engineRef];
      }),
    );
  }
}
