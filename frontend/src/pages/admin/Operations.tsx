import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { get, post } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Pager, Table, qs, useFilters, usePermissions, useToast, type Row } from './kit';

export function Notifications() {
  const { has } = usePermissions();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const q = useAsync(() => get<Row>(`/admin/notifications${qs({ status, page, pageSize: 25 })}`), [status, page]);
  const [to, setTo] = useState('');
  const [result, setResult] = useState<Row | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const test = async (send: boolean) => {
    setBusy(true); setError(null); setResult(null);
    try { setResult(await post<Row>('/admin/notifications/test', send && to ? { to } : {})); } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title="Email delivery" subtitle="Platform email (invitations, resets, notices) is queued, retried with backoff, and tracked here." />
      {q.data?.mailer.kind === 'dev' && <Alert kind="warning" title="Development mailer">Messages are written to a local outbox and are not delivered. Configure SMTP for production.</Alert>}
      {has('notifications.manage') && (
        <Card title="Configuration test">
          <p className="muted">Checks the SMTP connection and login without exposing credentials. Optionally sends a real test message.</p>
          <form className="row" style={{ alignItems: 'flex-end' }} onSubmit={(e) => { e.preventDefault(); void test(Boolean(to)); }}>
            <TextField label="Send test to (optional)" type="email" value={to} onChange={(e) => setTo(e.target.value)} />
            <Button type="submit" variant="primary" busy={busy}>{to ? 'Verify and send test' : 'Verify connection'}</Button>
          </form>
          <ErrorAlert error={error} />
          {result && <Alert kind={result.ok ? 'success' : 'error'} title={result.ok ? 'Email configuration works' : `Failed at the ${result.stage} step`}>{result.detail}</Alert>}
        </Card>
      )}
      <Card>
        <SelectField label="Status" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}><option value="">All</option>{['queued', 'sending', 'sent', 'failed', 'cancelled'].map((x) => <option key={x}>{x}</option>)}</SelectField>
      </Card>
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Outgoing email" head={['Created', 'Type', 'To', 'Status', 'Attempts', 'Next attempt / error', '']} rows={(q.data.emails as Row[]).map((m) => [
            timeAgo(m.created_at), m.kind.replace(/_/g, ' '), m.to_email, <StatusBadge status={m.status === 'sent' ? 'ok' : m.status} />, `${m.attempts}/${m.max_attempts}`,
            m.status === 'queued' ? (m.attempts > 0 ? `Retry ${formatDate(m.next_attempt_at)} — ${m.last_error ?? ''}` : 'Waiting for the worker') : m.last_error ?? (m.sent_at ? `Sent ${formatDate(m.sent_at)}` : ''),
            has('notifications.manage') && m.status === 'failed' ? <Button small onClick={async () => { try { await post(`/admin/notifications/${m.id}/retry`); toast.push('Message re-queued.'); await q.reload(); } catch (e) { setError(e); } }}>Retry</Button> : null,
          ])} empty="No messages." />
          <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}

export function Domains() {
  const f = useFilters({ q: '', status: '' });
  const [page, setPage] = useState(1);
  const { has } = usePermissions();
  const toast = useToast();
  const q = useAsync(() => get<{ domains: Row[]; total: number }>(`/admin/domains${qs({ ...f.applied, page, pageSize: 25 })}`), [f.applied, page]);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Domains" subtitle="All customer domains across workspaces." />
      <Card>
        <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); f.apply(); }}>
          <TextField label="Search domain" value={f.draft.q} onChange={(e) => f.set('q', e.target.value)} />
          <SelectField label="Ownership" value={f.draft.status} onChange={(e) => f.set('status', e.target.value)}><option value="">Any</option>{['pending', 'verified', 'failed', 'expired'].map((x) => <option key={x}>{x}</option>)}</SelectField>
          <div className="row"><Button type="submit" variant="primary">Apply</Button></div>
        </form>
      </Card>
      <ErrorAlert error={error} />
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Domains" head={['Domain', 'Workspace', 'Ownership', 'Inbound DNS', 'Outbound DNS', 'Mail server', 'Mailboxes', '']} rows={q.data.domains.map((d) => [
            d.name, <Link to={`/admin/tenants/${d.tenant_id}`}>{d.workspace}</Link>, <StatusBadge status={d.ownership_status} />, <StatusBadge status={d.inbound_status} />, <StatusBadge status={d.outbound_status} />, <StatusBadge status={d.provisioning_status} />, d.mailboxes,
            has('domains.verify') && d.ownership_status === 'verified' ? <Button small onClick={async () => { try { const r = await post<{ drift: unknown[] }>(`/admin/domains/${d.id}/reconcile`, { repair: false, reason: 'Operator drift check' }); toast.push(r.drift.length ? `${r.drift.length} difference(s) found with the mail server.` : 'In sync with the mail server.', r.drift.length ? 'error' : 'success'); } catch (e) { setError(e); } }}>Check sync</Button> : null,
          ])} empty="No domains." />
          <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}

export function Plans() {
  const q = useAsync(() => get<{ plans: Row[] }>('/admin/plans'), []);
  return (
    <>
      <PageHeader title="Plans & quotas" subtitle="Plan limits apply to every workspace. Per-workspace overrides are set on the tenant page." />
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Plans" head={['Plan', 'Domains', 'Mailboxes', 'Aliases', 'Default / max mailbox', 'Workspace storage', 'Sends per day / hour']} rows={q.data.plans.map((p) => [
            <div><strong>{p.name}</strong> {!p.is_active && <StatusBadge status="closed" label="inactive" />}<div className="muted"><small>{p.code}</small></div></div>,
            p.max_domains, `${p.max_mailboxes} (${p.max_mailboxes_per_domain}/domain)`, p.max_aliases, `${formatBytes(Number(p.mailbox_quota_default_bytes))} / ${formatBytes(Number(p.mailbox_quota_max_bytes))}`, formatBytes(Number(p.tenant_storage_max_bytes)), `${p.daily_send_limit} / ${p.hourly_send_limit}`,
          ])} />
        </Card>
      )}
    </>
  );
}

export function AuditLog() {
  const f = useFilters({ action: '', outcome: '', from: '', to: '' });
  const [page, setPage] = useState(1);
  const q = useAsync(() => get<{ entries: Row[]; total: number }>(`/admin/audit${qs({ ...f.applied, page, pageSize: 50 })}`), [f.applied, page]);
  return (
    <>
      <PageHeader title="Audit log" subtitle="Privileged and security-relevant events. Secrets, tokens and passwords are never recorded." />
      <Card>
        <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); f.apply(); }}>
          <TextField label="Action prefix" placeholder="e.g. user. or role." value={f.draft.action} onChange={(e) => f.set('action', e.target.value)} />
          <SelectField label="Outcome" value={f.draft.outcome} onChange={(e) => f.set('outcome', e.target.value)}><option value="">Any</option><option>success</option><option>failure</option><option>denied</option></SelectField>
          <TextField label="From" type="date" value={f.draft.from} onChange={(e) => f.set('from', e.target.value)} />
          <TextField label="To" type="date" value={f.draft.to} onChange={(e) => f.set('to', e.target.value)} />
          <div className="row"><Button type="submit" variant="primary">Filter</Button><Button type="button" onClick={() => { setPage(1); f.reset(); }}>Reset</Button></div>
        </form>
      </Card>
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Audit events" head={['When', 'Action', 'Outcome', 'Actor', 'Target', 'Reason', 'Correlation']} rows={q.data.entries.map((a) => [formatDate(a.occurred_at), a.action, <StatusBadge status={a.outcome === 'success' ? 'ok' : 'error'} label={a.outcome} />, `${a.actor_type}${a.actor_admin_id ? ` …${String(a.actor_admin_id).slice(-6)}` : a.actor_user_id ? ` …${String(a.actor_user_id).slice(-6)}` : ''}`, a.target_type ? `${a.target_type} …${String(a.target_id ?? '').slice(-6)}` : '', a.reason ?? '', <span className="mono">{String(a.correlation_id ?? '').slice(0, 8)}</span>])} empty="No events match." />
          <Pager page={page} pageSize={50} total={q.data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}
