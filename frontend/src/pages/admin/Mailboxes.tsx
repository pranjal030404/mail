import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, CopyButton, ErrorAlert, PageHeader, ProgressBar, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { get, patch, post } from '../../lib/api';
import { formatBytes, formatDate } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Pager, Table, qs, useFilters, usePermissions, useSensitive, useToast, type Row } from './kit';

export default function Mailboxes() {
  const f = useFilters({ q: '', status: '', tenantId: '' });
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('created');
  const { has } = usePermissions();
  const nav = useNavigate();
  const q = useAsync(() => get<{ mailboxes: Row[]; total: number }>(`/admin/mailboxes${qs({ ...f.applied, sort, dir: sort === 'address' ? 'asc' : 'desc', page, pageSize: 25 })}`), [f.applied, sort, page]);
  const attention = useAsync(() => (has('provisioning.read') ? get<{ mailboxes: Row[] }>('/admin/mailboxes-attention') : Promise.resolve({ mailboxes: [] })), []);
  return (
    <>
      <PageHeader title="Mailboxes" subtitle="Status reflects the mail server, not just the database." actions={has('mailboxes.create') ? <Button variant="primary" onClick={() => nav('/admin/mailboxes/new')}><Plus size={16} /> Create mailbox</Button> : undefined} />
      {attention.data && attention.data.mailboxes.length > 0 && (
        <Alert kind="warning" title={`${attention.data.mailboxes.length} mailbox(es) need attention`}>
          Failed or stalled provisioning, or drift between the database and the mail server:
          <ul>{attention.data.mailboxes.slice(0, 5).map((m) => <li key={m.id}><Link to={`/admin/mailboxes/${m.id}`}>{m.address}</Link> — {m.status.replace('_', ' ')}{m.last_error_message ? `: ${m.last_error_message}` : ''}</li>)}</ul>
        </Alert>
      )}
      <Card>
        <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); f.apply(); }}>
          <TextField label="Search address" value={f.draft.q} onChange={(e) => f.set('q', e.target.value)} />
          <SelectField label="Status" value={f.draft.status} onChange={(e) => f.set('status', e.target.value)}><option value="">Any</option>{['provisioning', 'provisioning_failed', 'active', 'suspended', 'deletion_scheduled'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</SelectField>
          <SelectField label="Sort" value={sort} onChange={(e) => { setPage(1); setSort(e.target.value); }}><option value="created">Newest</option><option value="address">Address</option><option value="usage">Storage used</option></SelectField>
          <div className="row"><Button type="submit" variant="primary">Apply</Button><Button type="button" onClick={() => { setPage(1); f.reset(); }}>Reset</Button></div>
        </form>
      </Card>
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Mailboxes" head={['Address', 'Owner', 'Workspace', 'Domain', 'Status', 'Storage', 'Sending limit', 'Created']} rows={q.data.mailboxes.map((m) => [
            <Link to={`/admin/mailboxes/${m.id}`}>{m.address}</Link>, m.owner_email ?? <span className="muted">unassigned</span>, m.workspace, m.domain,
            <span title={m.last_job_status ? `Last job: ${m.last_job_status}` : ''}><StatusBadge status={m.status} /></span>,
            <div style={{ minWidth: 120 }}>{formatBytes(m.used_bytes === null ? null : Number(m.used_bytes))} / {formatBytes(Number(m.quota_bytes))}{m.used_bytes !== null && <ProgressBar percent={(Number(m.used_bytes) / Math.max(1, Number(m.quota_bytes))) * 100} label="Storage used" />}</div>,
            `${m.daily_send_limit}/day · ${m.hourly_send_limit}/h`, formatDate(m.created_at),
          ])} empty="No mailboxes match." />
          <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}

export function CreateMailbox() {
  const nav = useNavigate();
  const tenants = useAsync(() => get<{ tenants: Row[] }>('/admin/tenants?pageSize=100'), []);
  const [tenantId, setTenantId] = useState('');
  const domains = useAsync(() => (tenantId ? get<Row>(`/admin/tenants/${tenantId}`).then((t) => t.domains as Row[]) : Promise.resolve([] as Row[])), [tenantId]);
  const [domainId, setDomainId] = useState('');
  const [localPart, setLocalPart] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const verified = (domains.data ?? []).filter((d) => d.ownership_status === 'verified' && d.provisioning_status === 'ready');
  const domain = verified.find((d) => d.id === domainId);
  return (
    <>
      <PageHeader title="Create mailbox" subtitle={<Link to="/admin/mailboxes">Back to mailboxes</Link>} />
      <Card>
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { const r = await post<{ mailbox: Row }>('/admin/mailboxes', { tenantId, domainId, localPart: localPart.trim(), ...(displayName.trim() ? { displayName: displayName.trim() } : {}) }); nav(`/admin/mailboxes/${r.mailbox.id}`); } catch (err) { setError(err); } finally { setBusy(false); } }}>
          <SelectField label="Workspace" value={tenantId} onChange={(e) => { setTenantId(e.target.value); setDomainId(''); }} required><option value="">Select…</option>{tenants.data?.tenants.filter((t) => t.status === 'active').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField>
          <SelectField label="Verified domain" value={domainId} onChange={(e) => setDomainId(e.target.value)} required hint="Only verified, provisioned domains of this workspace are offered.">
            <option value="">Select…</option>{verified.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
          </SelectField>
          <TextField label="Mailbox name" value={localPart} onChange={(e) => setLocalPart(e.target.value)} required hint={domain && localPart ? `Address: ${localPart.trim().toLowerCase()}@${domain.name}` : undefined} />
          <TextField label="Display name (optional)" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" busy={busy} disabled={!tenantId || !domainId || !localPart.trim()}>Create mailbox</Button>
        </form>
      </Card>
    </>
  );
}

export function MailboxDetail() {
  const { mailboxId } = useParams();
  const { has } = usePermissions();
  const toast = useToast();
  const s = useSensitive();
  const q = useAsync(() => get<Row>(`/admin/mailboxes/${mailboxId}`), [mailboxId]);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState<string | null>(null);
  const [quotaMb, setQuotaMb] = useState<string | null>(null);
  const d = q.data;
  if (q.loading && !d) return <Spinner />;
  if (!d) return <ErrorAlert error={q.error} />;
  const m = d.mailbox as Row;
  const cs = d.clientSettings as Row;
  const run = async (fn: () => Promise<unknown>, ok: string) => { setError(null); try { await fn(); toast.push(ok); await q.reload(); } catch (e) { setError(e); } };
  const failedJob = (d.jobs as Row[]).find((j) => ['failed', 'needs_manual_review'].includes(j.status));
  return (
    <>
      <PageHeader title={m.address} subtitle={<><Link to="/admin/mailboxes">All mailboxes</Link> · {d.tenant?.name}</>} actions={<StatusBadge status={m.status} />} />
      <ErrorAlert error={error} />
      {m.status === 'provisioning' && <Alert kind="info" title="Provisioning in progress">The mail server has not confirmed this mailbox yet. This page does not treat it as active until it does.</Alert>}
      {m.status === 'provisioning_failed' && <Alert kind="error" title="Provisioning failed">{failedJob?.last_error_message ?? 'The mail server could not create this mailbox.'} {has('provisioning.retry') && failedJob && <Link to="/admin/jobs">Retry from Provisioning jobs</Link>}</Alert>}
      {m.status === 'deletion_scheduled' && <Alert kind="warning" title="Scheduled for deletion">Data is removed on {formatDate(m.deletionScheduledFor)}. Access has already stopped.</Alert>}
      <div className="grid">
        <Card title="Overview">
          <dl className="kv">
            <dt>Owner</dt><dd>{d.owner ? <Link to={`/admin/users/${d.owner.id}`}>{d.owner.email}</Link> : 'unassigned'}</dd>
            <dt>Workspace</dt><dd><Link to={`/admin/tenants/${d.tenant?.id}`}>{d.tenant?.name}</Link></dd>
            <dt>Domain</dt><dd>{d.domain?.name} <StatusBadge status={d.domain?.ownership_status} /></dd>
            <dt>Display name</dt><dd>{m.displayName ?? '—'}</dd>
            <dt>Created</dt><dd>{formatDate(m.createdAt)}</dd>
            <dt>Password set</dt><dd>{m.credentialsSet ? 'yes' : 'no — owner must set one'}</dd>
            <dt>Sending limit</dt><dd>{d.limits.dailySendLimit}/day · {d.limits.hourlySendLimit}/hour</dd>
          </dl>
        </Card>
        <Card title="Storage">
          <div className="stat">{formatBytes(m.usedBytes)} <small className="muted">of {formatBytes(m.quotaBytes)}</small></div>
          {m.usedBytes !== null && <ProgressBar percent={(m.usedBytes / Math.max(1, m.quotaBytes)) * 100} label="Storage used" />}
          <small className="muted">Usage collected {formatDate(m.usageCollectedAt)}</small>
          {has('mailboxes.update') && (m.status === 'active' || m.status === 'suspended') && (
            <form className="row" style={{ alignItems: 'flex-end', marginTop: '1rem' }} onSubmit={(e) => { e.preventDefault(); void run(() => patch(`/admin/mailboxes/${mailboxId}`, { ...(name !== null ? { displayName: name } : {}), ...(quotaMb !== null && has('mailboxes.quota.update') ? { quotaBytes: Math.round(Number(quotaMb) * 1048576) } : {}) }), 'Mailbox updated.'); }}>
              <TextField label="Display name" value={name ?? m.displayName ?? ''} onChange={(e) => setName(e.target.value)} />
              {has('mailboxes.quota.update') && <TextField label="Quota (MB)" type="number" min={1} value={quotaMb ?? String(Math.round(m.quotaBytes / 1048576))} onChange={(e) => setQuotaMb(e.target.value)} />}
              <Button type="submit" disabled={name === null && quotaMb === null}>Save</Button>
            </form>
          )}
        </Card>
      </div>
      <Card title="Mail client settings" actions={<CopyButton value={m.address} label="Copy address" />}>
        <dl className="kv">
          <dt>Username</dt><dd>{cs.username}</dd><dt>Incoming (IMAP)</dt><dd>{cs.imap.host}:{cs.imap.port} · {cs.imap.security}</dd>
          <dt>Outgoing (SMTP)</dt><dd>{cs.smtp.host}:{cs.smtp.port} · {cs.smtp.security}</dd>
          {cs.smtpStarttls && <><dt>SMTP (STARTTLS)</dt><dd>{cs.smtpStarttls.host}:{cs.smtpStarttls.port}</dd></>}
          {cs.webmailUrl && <><dt>Webmail</dt><dd>{cs.webmailUrl}</dd></>}
        </dl>
        {cs.simulated && <Alert kind="warning">{cs.simulated}</Alert>}
      </Card>
      <Card title="Aliases & forwarding">
        <Table head={['Address', 'Type', 'Destination', 'Status']} rows={([...(d.aliases as Row[]), ...(d.forwarding as Row[]).map((f): Row => ({ ...f, source_address: m.address, destination_type: 'external' }))] as Row[]).map((a) => [a.source_address, a.destination_type === 'external' ? 'forward' : 'alias', a.destination_address, <StatusBadge status={a.status} />])} empty="No aliases or forwarding." />
      </Card>
      <Card title="Provisioning history">
        <Table head={['Operation', 'Status', 'Attempts', 'Error', 'Updated']} rows={(d.jobs as Row[]).map((j) => [j.operation, <StatusBadge status={j.status} />, `${j.attempts}/${j.max_attempts}`, j.last_error_message ? `${j.last_error_code}: ${j.last_error_message}` : j.needs_reconcile ? 'reconciliation requested' : '', formatDate(j.updated_at)])} empty="No jobs recorded." />
      </Card>
      {d.audit && <Card title="Audit events"><Table head={['When', 'Action', 'Outcome', 'Reason']} rows={(d.audit as Row[]).map((a) => [formatDate(a.occurred_at), a.action, <StatusBadge status={a.outcome === 'success' ? 'ok' : 'error'} label={a.outcome} />, a.reason ?? ''])} empty="No events." /></Card>}
      <Card title="Actions">
        <div className="row">
          {has('mailboxes.suspend') && m.status === 'active' && <Button variant="danger" onClick={() => s.setAction({ title: `Suspend ${m.address}`, label: 'Suspend mailbox', danger: true, run: (reason) => post(`/admin/mailboxes/${mailboxId}/suspend`, { reason, confirm: true }) })}>Suspend</Button>}
          {has('mailboxes.suspend') && m.status === 'suspended' && <Button onClick={() => s.setAction({ title: `Reactivate ${m.address}`, label: 'Reactivate', run: (reason) => post(`/admin/mailboxes/${mailboxId}/reactivate`, { reason, confirm: true }) })}>Reactivate</Button>}
          {has('mailboxes.credentials.reset') && (m.status === 'active' || m.status === 'suspended') && <Button onClick={() => s.setAction({ title: `Reset credentials for ${m.address}`, label: 'Reset credentials', danger: true, body: 'The old password stops working. The new one is never shown to you: the owner is emailed to set their own in the workspace.', run: (reason) => post(`/admin/mailboxes/${mailboxId}/reset-credentials`, { reason, confirm: true }) })}>Reset credentials</Button>}
          {has('mailboxes.delete') && ['active', 'suspended', 'provisioning_failed'].includes(m.status) && <Button variant="danger" onClick={() => s.setAction({ title: `Delete ${m.address}`, label: 'Schedule deletion', danger: true, typed: m.address, body: 'Access stops immediately; data is removed after the grace period and the deletion can be cancelled until then.', run: (reason) => post(`/admin/mailboxes/${mailboxId}/schedule-deletion`, { reason, confirm: true, confirmAddress: m.address }) })}>Schedule deletion</Button>}
          {has('mailboxes.delete') && m.status === 'deletion_scheduled' && <Button variant="primary" onClick={() => void run(() => post(`/admin/mailboxes/${mailboxId}/cancel-deletion`), 'Deletion cancelled.')}>Cancel deletion</Button>}
        </div>
      </Card>
      {s.dialog(() => void q.reload())}
    </>
  );
}
