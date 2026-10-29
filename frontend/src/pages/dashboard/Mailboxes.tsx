import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, PageHeader, ProgressBar, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, post } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import type { DomainSummary, Mailbox } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

interface ClientSettings {
  username: string;
  note: string;
  imap: { host: string; port: number; security: string };
  smtp: { host: string; port: number; security: string; authentication: string };
  smtpStarttls: { host: string; port: number; security: string } | null;
  jmap: { url: string } | null;
  webmailUrl: string | null;
  simulated: string | null;
}

export function ClientSettingsCard({ s }: { s: ClientSettings }) {
  const row = (k: string, v: string) => (
    <tr><th>{k}</th><td className="mono">{v}</td><td><CopyButton value={v} label="Copy" /></td></tr>
  );
  return (
    <Card title="Email app settings">
      {s.simulated && <Alert kind="warning" title="Simulation">{s.simulated}</Alert>}
      <div className="table-wrap"><table><tbody>
        {row('Username', s.username)}
        {row('Incoming (IMAP) server', s.imap.host)}{row('IMAP port', `${s.imap.port} (${s.imap.security})`)}
        {row('Outgoing (SMTP) server', s.smtp.host)}{row('SMTP port', `${s.smtp.port} (${s.smtp.security}, authentication required)`)}
        {s.smtpStarttls && row('SMTP alternative', `${s.smtpStarttls.port} (${s.smtpStarttls.security})`)}
        {s.jmap && row('JMAP', s.jmap.url)}
      </tbody></table></div>
      <p className="muted"><small>{s.note}</small></p>
      {s.webmailUrl && <p><a className="btn" href={s.webmailUrl} target="_blank" rel="noreferrer noopener">Open webmail</a></p>}
    </Card>
  );
}

function List() {
  const { tenantId, canManage, suspended } = useTenant();
  const [sp, setSp] = useSearchParams();
  const [q, setQ] = useState(sp.get('q') ?? '');
  const status = sp.get('status') ?? '';
  const sort = sp.get('sort') ?? 'created';
  const order = sp.get('order') ?? 'desc';
  const page = Number(sp.get('page') ?? '1');
  const domainFilter = sp.get('domain') ?? '';
  const qs = new URLSearchParams({ ...(sp.get('q') ? { q: sp.get('q')! } : {}), ...(status ? { status } : {}), ...(domainFilter ? { domainId: domainFilter } : {}), sort, order, page: String(page), pageSize: '20' }).toString();
  const list = useAsync(() => get<{ mailboxes: Mailbox[]; total: number; pageSize: number }>(`/tenants/${tenantId}/mailboxes?${qs}`), [tenantId, qs]);
  const domains = useAsync(() => (canManage ? get<{ domains: DomainSummary[] }>(`/tenants/${tenantId}/domains`) : Promise.resolve(null)), [tenantId, canManage]);
  const [creating, setCreating] = useState(false);
  const set = (k: string, v: string) => {
    const n = new URLSearchParams(sp);
    if (v) n.set(k, v);
    else n.delete(k);
    if (k !== 'page') n.delete('page');
    setSp(n);
  };
  return (
    <>
      <PageHeader title="Mailboxes" actions={canManage && <Button variant="primary" disabled={suspended || !domains.data?.domains.some((d) => d.ownershipStatus === 'verified')} onClick={() => setCreating(true)}>Create mailbox</Button>} />
      {canManage && domains.data && !domains.data.domains.some((d) => d.ownershipStatus === 'verified') && <Alert kind="info" title="Verify a domain first">Mailboxes can be created once a domain’s ownership is verified. <Link to="/dashboard/domains">Go to domains</Link></Alert>}
      <Card>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); set('q', q); }}>
          <input aria-label="Search by address" placeholder="Search address…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 260 }} />
          <select aria-label="Status filter" value={status} onChange={(e) => set('status', e.target.value)} style={{ maxWidth: 200 }}>
            <option value="">All statuses</option>
            {['active', 'suspended', 'provisioning', 'provisioning_failed', 'deletion_scheduled'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          {domains.data && <select aria-label="Domain filter" value={domainFilter} onChange={(e) => set('domain', e.target.value)} style={{ maxWidth: 220 }}><option value="">All domains</option>{domains.data.domains.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select>}
          <select aria-label="Sort" value={`${sort}:${order}`} onChange={(e) => { const [s, o] = e.target.value.split(':'); const n = new URLSearchParams(sp); n.set('sort', s!); n.set('order', o!); setSp(n); }} style={{ maxWidth: 200 }}>
            <option value="created:desc">Newest first</option><option value="created:asc">Oldest first</option><option value="address:asc">Address A–Z</option><option value="usage:desc">Most used</option>
          </select>
          <Button type="submit">Search</Button>
        </form>
      </Card>
      {list.loading && <Spinner />}
      <ErrorAlert error={list.error} onRetry={list.reload} />
      {list.data && list.data.mailboxes.length === 0 && <Card><EmptyState title="No mailboxes found">{canManage ? 'Create your first mailbox once a domain is verified.' : 'No mailbox is linked to your account yet.'}</EmptyState></Card>}
      {list.data && list.data.mailboxes.length > 0 && (
        <Card>
          <div className="table-wrap"><table>
            <thead><tr><th>Address</th><th>Status</th><th>Usage</th><th>Created</th></tr></thead>
            <tbody>
              {list.data.mailboxes.map((m) => (
                <tr key={m.id}>
                  <td><Link to={`/dashboard/mailboxes/${m.id}`}>{m.address}</Link>{m.displayName && <div className="muted"><small>{m.displayName}</small></div>}</td>
                  <td><StatusBadge status={m.status} /></td>
                  <td style={{ minWidth: 160 }}>{formatBytes(m.usedBytes)} / {formatBytes(m.quotaBytes)}<ProgressBar percent={m.usedBytes ? (m.usedBytes / m.quotaBytes) * 100 : 0} label={`${m.address} usage`} /></td>
                  <td>{timeAgo(m.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
          <div className="row spread"><small className="muted">{list.data.total} mailbox(es)</small>
            <span className="row"><Button small disabled={page <= 1} onClick={() => set('page', String(page - 1))}>Previous</Button><Button small disabled={page * list.data.pageSize >= list.data.total} onClick={() => set('page', String(page + 1))}>Next</Button></span></div>
        </Card>
      )}
      {creating && domains.data && <CreateDialog tenantId={tenantId!} domains={domains.data.domains.filter((d) => d.ownershipStatus === 'verified')} initialDomain={domainFilter} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); void list.reload(); }} />}
    </>
  );
}

function CreateDialog({ tenantId, domains, initialDomain, onClose, onCreated }: { tenantId: string; domains: DomainSummary[]; initialDomain: string; onClose: () => void; onCreated: () => void }) {
  const [domainId, setDomainId] = useState(domains.find((d) => d.id === initialDomain)?.id ?? domains[0]?.id ?? '');
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [quotaMb, setQuotaMb] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/tenants/${tenantId}/domains/${domainId}/mailboxes`, { localPart, ...(displayName ? { displayName } : {}), ...(quotaMb ? { quotaBytes: Math.round(Number(quotaMb) * 1024 * 1024) } : {}) });
      onCreated();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Create mailbox">
      <form onSubmit={submit}>
        <div className="row" style={{ alignItems: 'flex-end' }}>
          <TextField label="Mailbox name" required value={localPart} onChange={(e) => setLocalPart(e.target.value)} hint="Letters, numbers, dot, hyphen, underscore." style={{ minWidth: 180 }} />
          <SelectField label="Domain" value={domainId} onChange={(e) => setDomainId(e.target.value)}>{domains.map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}</SelectField>
        </div>
        <TextField label="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        <TextField label="Quota in MB (optional)" type="number" min={1} value={quotaMb} onChange={(e) => setQuotaMb(e.target.value)} hint="Leave blank for the plan default. Quotas are hard limits." />
        <ErrorAlert error={error} />
        <div className="row"><Button type="submit" variant="primary" busy={busy}>Create</Button><Button type="button" onClick={onClose}>Cancel</Button></div>
      </form>
    </Card>
  );
}

function Detail() {
  const { mailboxId } = useParams();
  const { tenantId, canManage } = useTenant();
  const nav = useNavigate();
  const q = useAsync(() => get<Mailbox>(`/tenants/${tenantId}/mailboxes/${mailboxId}`), [tenantId, mailboxId]);
  const cs = useAsync(() => get<ClientSettings>(`/tenants/${tenantId}/mailboxes/${mailboxId}/client-settings`), [tenantId, mailboxId]);
  const [password, setPassword] = useState('');
  const [generated, setGenerated] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'suspend' | 'delete' | null>(null);
  const m = q.data;

  // Poll while the mailbox is still being created.
  const provisioning = m?.status === 'provisioning';
  const reload = q.reload;
  useEffect(() => {
    if (!provisioning) return;
    const t = setInterval(() => void reload(), 3000);
    return () => clearInterval(t);
  }, [provisioning, reload]);

  if (q.loading && !m) return <Spinner />;
  if (!m) return <ErrorAlert error={q.error} onRetry={q.reload} />;
  const base = `/tenants/${tenantId}/mailboxes/${m.id}`;
  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name);
    setError(null);
    setNotice(null);
    try {
      await fn();
      await q.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };
  const usable = m.status === 'active' || m.status === 'suspended';
  const pct = m.usedBytes !== null ? (m.usedBytes / m.quotaBytes) * 100 : 0;
  return (
    <>
      <PageHeader title={m.address} subtitle={m.displayName ?? undefined} actions={<StatusBadge status={m.status} />} />
      <ErrorAlert error={error} />
      {notice && <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>}
      {m.status === 'provisioning' && <Alert kind="info" title="Creating your mailbox"><Spinner label="Setting up on the mail server" /></Alert>}
      {m.status === 'provisioning_failed' && <Alert kind="error" title="Setup did not complete">ARTHVEX operations have been alerted and will recover this automatically or contact you. You can delete this mailbox and try again.</Alert>}
      {m.status === 'suspended' && <Alert kind="warning" title="Suspended">{m.suspendedReason ?? 'This mailbox cannot sign in or send.'}</Alert>}
      {m.status === 'deletion_scheduled' && <Alert kind="warning" title={`Scheduled for deletion on ${formatDate(m.deletionScheduledFor)}`}>Access is already blocked. After that date the mailbox and its messages are permanently removed.{canManage && <div><Button small onClick={() => act('cancel', () => post(`${base}/cancel-deletion`))}>Cancel deletion</Button></div>}</Alert>}

      <Card title="Storage">
        <div>{formatBytes(m.usedBytes)} of {formatBytes(m.quotaBytes)} used {m.usedBytes === null && <span className="muted">(not collected yet)</span>}</div>
        <ProgressBar percent={pct} label="Mailbox storage" />
        <p className="muted"><small>Usage collected {timeAgo(m.usageCollectedAt)}; figures can lag by several minutes. Quota is a hard limit — mail is refused when full.</small></p>
      </Card>

      {usable && (
        <Card title="Password">
          {!m.credentialsSet && <Alert kind="info" title="No password set yet">Set a password so you can sign in to webmail or an email app.</Alert>}
          {generated && <Alert kind="success" title="New password — copy it now">It is shown only once and is not stored by ARTHVEX.<div className="dns-value mono">{generated}<CopyButton value={generated} /></div></Alert>}
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <TextField label="Choose a password (optional)" type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)} hint="Leave blank to generate a strong one." />
            <Button busy={busy === 'pw'} onClick={() => act('pw', async () => { const r = await post<{ generatedPassword?: string }>(`${base}/reset-credentials`, password ? { password } : {}); setGenerated(r.generatedPassword ?? null); setPassword(''); if (!r.generatedPassword) setNotice('Password updated.'); })}>{m.credentialsSet ? 'Reset password' : 'Set password'}</Button>
          </div>
        </Card>
      )}

      {cs.data && usable && <ClientSettingsCard s={cs.data} />}

      {canManage && (
        <Card title="Manage">
          <div className="row">
            {m.status === 'active' && <Button onClick={() => setDialog('suspend')}>Suspend</Button>}
            {m.status === 'suspended' && <Button variant="primary" busy={busy === 'react'} onClick={() => act('react', () => post(`${base}/reactivate`))}>Reactivate</Button>}
            {m.status !== 'deletion_scheduled' && m.status !== 'provisioning' && <Button variant="danger" onClick={() => setDialog('delete')}>Delete…</Button>}
          </div>
        </Card>
      )}
      <ConfirmDialog open={dialog === 'suspend'} title="Suspend mailbox" confirmLabel="Suspend" askReason onCancel={() => setDialog(null)} onConfirm={async (reason) => { await post(`${base}/suspend`, { reason }); setDialog(null); await q.reload(); }}>
        <p>The mailbox will stop accepting sign-ins and sending. Incoming mail is still accepted unless the mailbox is full.</p>
      </ConfirmDialog>
      <ConfirmDialog open={dialog === 'delete'} title="Delete mailbox" danger confirmLabel="Schedule deletion" typeToConfirm={m.address} onCancel={() => setDialog(null)} onConfirm={async () => { await del(base, { confirmAddress: m.address }); setDialog(null); nav('/dashboard/mailboxes'); }}>
        <p>Access stops immediately. After the grace period all messages in this mailbox are <strong>permanently deleted</strong>. You can cancel during the grace period.</p>
      </ConfirmDialog>
    </>
  );
}

export default function Mailboxes() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path=":mailboxId" element={<Detail />} />
      <Route path="*" element={<Navigate to="/dashboard/mailboxes" replace />} />
    </Routes>
  );
}
