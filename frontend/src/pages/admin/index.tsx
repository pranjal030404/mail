import { useState } from 'react';
import { Link, Navigate, Route, Routes, useParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextArea } from '../../components/ui';
import { get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import Access from './Access';
import CreateUser from './CreateUser';
import Dashboard from './Dashboard';
import { Can, Table, useSensitive, type Row } from './kit';
import Mailboxes, { CreateMailbox, MailboxDetail } from './Mailboxes';
import { AuditLog, Domains, Notifications, Plans } from './Operations';
import Roles, { Admins, RoleEditor } from './Roles';
import UserDetail from './UserDetail';
import Users, { Invitations } from './Users';

function Tenants() {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const list = useAsync(() => get<{ tenants: Row[] }>(`/admin/tenants${query ? `?q=${encodeURIComponent(query)}` : ''}`), [query]);
  return (
    <>
      <PageHeader title="Tenants" />
      <Card>
        <form className="row" role="search" onSubmit={(e) => { e.preventDefault(); setQuery(q); }}>
          <input aria-label="Search tenants or domains" placeholder="Name, slug or domain…" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 320 }} /><Button type="submit">Search</Button>
        </form>
      </Card>
      {list.loading && <Spinner />}<ErrorAlert error={list.error} onRetry={list.reload} />
      {list.data && <Card><Table head={['Tenant', 'Plan', 'Status', 'Domains', 'Mailboxes', 'Created']} rows={list.data.tenants.map((t) => [<Link to={`/admin/tenants/${t.id}`}>{t.name}</Link>, t.plan, <StatusBadge status={t.status} />, t.domains, t.mailboxes, timeAgo(t.created_at)])} /></Card>}
    </>
  );
}

function TenantDetail() {
  const { tenantId } = useParams();
  const { me } = useAuth();
  const q = useAsync(() => get<Row>(`/admin/tenants/${tenantId}`), [tenantId]);
  const s = useSensitive();
  const d = q.data;
  if (q.loading && !d) return <Spinner />;
  if (!d) return <ErrorAlert error={q.error} />;
  const t = d.tenant;
  return (
    <>
      <PageHeader title={t.name} subtitle={`${t.slug} · plan ${t.plan_code}`} actions={<>
        <StatusBadge status={t.status} />
        {t.status === 'active' ? <Button variant="danger" onClick={() => s.setAction({ title: `Suspend ${t.name}`, label: 'Suspend tenant', danger: true, body: 'All active mailboxes are blocked immediately (sending and sign-in). The tenant keeps read-only access to settings.', run: (reason) => post(`/admin/tenants/${t.id}/suspend`, { reason, confirm: true }) })}>Suspend tenant</Button>
          : t.status === 'suspended' && <Button onClick={() => s.setAction({ title: `Reactivate ${t.name}`, label: 'Reactivate', run: (reason) => post(`/admin/tenants/${t.id}/reactivate`, { reason, confirm: true }) })}>Reactivate</Button>}
      </>} />
      {t.suspended_reason && <Alert kind="warning" title="Suspension reason">{t.suspended_reason}</Alert>}
      <Alert kind="info">Staff see metadata only. Message content is not accessible from this screen.</Alert>
      <Card title="Domains"><Table head={['Domain', 'Status', 'Ownership', 'Inbound', 'Outbound', 'Mail server']} rows={d.domains.map((x: Row) => [x.name, <StatusBadge status={x.status} />, <StatusBadge status={x.ownership_status} />, <StatusBadge status={x.inbound_status} />, <StatusBadge status={x.outbound_status} />, <StatusBadge status={x.provisioning_status} />])} /></Card>
      <Card title="Mailboxes"><Table head={['Address', 'Status', 'Used', 'Quota', '']} rows={d.mailboxes.map((x: Row) => [x.address, <StatusBadge status={x.status} />, formatBytes(x.used_bytes === null ? null : Number(x.used_bytes)), formatBytes(Number(x.quota_bytes)),
        x.status === 'active' ? <Button small variant="danger" onClick={() => s.setAction({ title: `Suspend ${x.address}`, label: 'Suspend mailbox', danger: true, body: 'Platform suspensions cannot be lifted by the customer.', run: (reason) => post(`/admin/mailboxes/${x.id}/suspend`, { reason, confirm: true }) })}>Suspend</Button>
          : x.status === 'suspended' ? <Button small onClick={() => s.setAction({ title: `Reactivate ${x.address}`, label: 'Reactivate', run: (reason) => post(`/admin/mailboxes/${x.id}/reactivate`, { reason, confirm: true }) })}>Reactivate</Button> : null])} /></Card>
      <Card title="Members"><Table head={['Email', 'Role', 'Status']} rows={d.members.map((x: Row) => [x.email, x.role, <StatusBadge status={x.status} />])} /></Card>
      <Card title="Recent audit"><Table head={['When', 'Action', 'Outcome', 'Actor', 'Reason']} rows={d.recentAudit.map((a: Row) => [formatDate(a.occurred_at), a.action, <StatusBadge status={a.outcome === 'success' ? 'ok' : 'error'} label={a.outcome} />, a.actor_type, a.reason ?? ''])} /></Card>
      {me?.user.platformRole === 'super_admin' && <p><Link to="/admin/settings">Platform settings</Link></p>}
      {s.dialog(() => void q.reload())}
    </>
  );
}

function Jobs() {
  const [status, setStatus] = useState('');
  const q = useAsync(() => get<{ jobs: Row[] }>(`/admin/provisioning-jobs${status ? `?status=${status}` : ''}`), [status]);
  const s = useSensitive();
  return (
    <>
      <PageHeader title="Provisioning jobs" subtitle="Failed and stuck jobs need an operator. Retrying forces reconciliation with the mail server first." />
      <Card>
        <SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{['queued', 'running', 'retrying', 'failed', 'needs_manual_review', 'succeeded', 'cancelled'].map((x) => <option key={x}>{x}</option>)}</SelectField>
      </Card>
      {q.loading && <Spinner />}<ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && <Card><Table head={['Operation', 'Target', 'Status', 'Attempts', 'Error', 'Updated', '']} rows={q.data.jobs.map((j) => [j.operation, <span className="mono">{String(j.target_id ?? '').slice(-8)}</span>, <StatusBadge status={j.status} />, `${j.attempts}/${j.max_attempts}`, j.last_error_message ? `${j.last_error_code}: ${j.last_error_message}` : '', timeAgo(j.updated_at),
        ['failed', 'needs_manual_review'].includes(j.status) ? <span className="row"><Button small onClick={() => s.setAction({ title: 'Retry job', label: 'Retry', run: (reason) => post(`/admin/provisioning-jobs/${j.id}/retry`, { reason, confirm: true }) })}>Retry</Button><Button small variant="danger" onClick={() => s.setAction({ title: 'Cancel job', label: 'Cancel job', danger: true, run: (reason) => post(`/admin/provisioning-jobs/${j.id}/cancel`, { reason, confirm: true }) })}>Cancel</Button></span> : null])} empty="No jobs." /></Card>}
      {s.dialog(() => void q.reload())}
    </>
  );
}

function Abuse() {
  const [status, setStatus] = useState('open');
  const q = useAsync(() => get<{ reports: Row[] }>(`/admin/abuse-reports?status=${status}`), [status]);
  const [target, setTarget] = useState<Row | null>(null);
  const [next, setNext] = useState('investigating');
  const [notes, setNotes] = useState('');
  return (
    <>
      <PageHeader title="Abuse reports" subtitle="Evidence should be minimal. To contain a compromised mailbox, suspend it from the tenant page." />
      <Card><SelectField label="Status" value={status} onChange={(e) => setStatus(e.target.value)}>{['open', 'investigating', 'actioned', 'dismissed', 'closed'].map((x) => <option key={x}>{x}</option>)}</SelectField></Card>
      {q.loading && <Spinner />}<ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && <Card><Table head={['Reported', 'Category', 'Severity', 'Summary', 'Tenant', 'Received', '']} rows={q.data.reports.map((r) => [r.reported_address ?? '—', r.category.replace('_', ' '), <StatusBadge status={r.severity === 'critical' || r.severity === 'high' ? 'error' : 'warning'} label={r.severity} />, r.summary.slice(0, 160), r.tenant_id ? <Link to={`/admin/tenants/${r.tenant_id}`}>open</Link> : '—', timeAgo(r.created_at), <Button small onClick={() => { setTarget(r); setNotes(r.investigation_notes ?? ''); }}>Update</Button>])} empty="No reports with this status." /></Card>}
      {target && (
        <Card title={`Update report`}>
          <SelectField label="New status" value={next} onChange={(e) => setNext(e.target.value)}>{['investigating', 'actioned', 'dismissed', 'closed'].map((x) => <option key={x}>{x}</option>)}</SelectField>
          <TextArea label="Investigation notes (restricted to staff)" value={notes} onChange={(e) => setNotes(e.target.value)} />
          <div className="row"><Button variant="primary" onClick={async () => { await patch(`/admin/abuse-reports/${target.id}`, { status: next, notes, reason: `Status → ${next}` }); setTarget(null); await q.reload(); }}>Save</Button><Button onClick={() => setTarget(null)}>Cancel</Button></div>
        </Card>
      )}
    </>
  );
}

function SupportQueue() {
  const q = useAsync(() => get<{ tickets: Row[] }>('/admin/support-tickets'), []);
  const [t, setT] = useState<Row | null>(null);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Support queue" subtitle="Ticket text is written by customers. Do not ask for passwords or message contents." />
      {q.loading && <Spinner />}<ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && <Card><Table head={['Subject', 'Category', 'Urgency', 'Status', 'Tenant', 'Updated', '']} rows={q.data.tickets.map((x) => [x.subject, x.category, x.urgency, <StatusBadge status={x.status} />, <Link to={`/admin/tenants/${x.tenant_id}`}>open</Link>, timeAgo(x.updated_at), <Button small onClick={() => setT(x)}>Reply</Button>])} empty="No open tickets." /></Card>}
      {t && <Card title={`Reply: ${t.subject}`}><TextArea label="Message" value={msg} onChange={(e) => setMsg(e.target.value)} /><ErrorAlert error={error} /><div className="row"><Button variant="primary" onClick={async () => { try { await post(`/admin/support-tickets/${t.id}/reply`, { message: msg }); setT(null); setMsg(''); await q.reload(); } catch (e) { setError(e); } }}>Send</Button><Button onClick={() => setT(null)}>Cancel</Button></div></Card>}
    </>
  );
}

function Settings() {
  const q = useAsync(() => get<Row>('/admin/settings'), []);
  const s = useSensitive();
  const [error, setError] = useState<unknown>(null);
  const v = q.data;
  const change = (patchBody: Row, title: string) => s.setAction({ title, label: 'Apply', danger: true, run: async (reason) => { setError(null); try { await patch('/admin/settings', { reason, confirm: true, settings: patchBody }); } catch (e) { setError(e); throw e; } } });
  if (!v) return q.loading ? <Spinner /> : <ErrorAlert error={q.error} />;
  return (
    <>
      <PageHeader title="Platform settings" subtitle="Super-admin only. Every change is audited." />
      <ErrorAlert error={error} />
      {v.signup_mode === 'open' && <Alert kind="warning" title="Public sign-up is open">Keep it closed until every launch gate in the launch checklist has passed.</Alert>}
      <Card title="Sign-up">
        <div className="row">{(['closed', 'invite_only', 'open'] as const).map((m) => <Button key={m} variant={v.signup_mode === m ? 'primary' : 'secondary'} disabled={v.signup_mode === m} onClick={() => change({ signup_mode: m }, `Set sign-up to ${m.replace('_', ' ')}`)}>{m.replace('_', ' ')}</Button>)}</div>
      </Card>
      <Card title="Maintenance mode">
        <p>Currently <strong>{v.maintenance_mode ? 'ON' : 'off'}</strong>. When on, customers see a maintenance message; staff can still sign in.</p>
        <Button variant={v.maintenance_mode ? 'secondary' : 'danger'} onClick={() => change({ maintenance_mode: !v.maintenance_mode }, v.maintenance_mode ? 'Turn maintenance mode off' : 'Turn maintenance mode on')}>{v.maintenance_mode ? 'Turn off' : 'Turn on'}</Button>
      </Card>
      <Card title="Policies">
        <Table head={['Setting', 'Value']} rows={[['Default plan', v.default_plan_code], ['Mailbox deletion grace', `${v.mailbox_deletion_grace_days} days`], ['Max workspaces per user', v.max_tenants_per_user], ['Mailbox creation requires', v.mailbox_creation_requires.replace(/_/g, ' ')], ['Terms version', v.terms_version]]} />
        <div className="row"><Button onClick={() => change({ mailbox_creation_requires: v.mailbox_creation_requires === 'ownership' ? 'ownership_and_mx' : 'ownership' }, 'Toggle MX requirement for mailbox creation')}>Toggle “require MX”</Button></div>
      </Card>
      {s.dialog(() => void q.reload())}
    </>
  );
}

const guard = (perm: string, el: React.ReactNode) => <Can perm={perm}>{el}</Can>;

export default function Admin() {
  return (
    <Routes>
      <Route index element={guard('dashboard.read', <Dashboard />)} />
      <Route path="tenants" element={guard('tenants.read', <Tenants />)} />
      <Route path="tenants/:tenantId" element={guard('tenants.read', <TenantDetail />)} />
      <Route path="domains" element={guard('domains.read', <Domains />)} />
      <Route path="users" element={guard('users.read', <Users />)} />
      <Route path="users/new" element={guard('users.create', <CreateUser />)} />
      <Route path="users/:userId" element={guard('users.read', <UserDetail />)} />
      <Route path="invitations" element={guard('users.read', <Invitations />)} />
      <Route path="mailboxes" element={guard('mailboxes.read', <Mailboxes />)} />
      <Route path="mailboxes/new" element={guard('mailboxes.create', <CreateMailbox />)} />
      <Route path="mailboxes/:mailboxId" element={guard('mailboxes.read', <MailboxDetail />)} />
      <Route path="access" element={guard('mailbox_access.request', <Access />)} />
      <Route path="jobs" element={guard('provisioning.read', <Jobs />)} />
      <Route path="notifications" element={guard('notifications.read', <Notifications />)} />
      <Route path="abuse" element={guard('abuse.read', <Abuse />)} />
      <Route path="support" element={guard('support.read', <SupportQueue />)} />
      <Route path="roles" element={guard('roles.read', <Roles />)} />
      <Route path="roles/new" element={guard('roles.create', <RoleEditor />)} />
      <Route path="roles/:roleId" element={guard('roles.read', <RoleEditor />)} />
      <Route path="admins" element={guard('admins.manage', <Admins />)} />
      <Route path="plans" element={guard('plans.read', <Plans />)} />
      <Route path="settings" element={guard('settings.read', <Settings />)} />
      <Route path="audit" element={guard('audit.read', <AuditLog />)} />
      <Route path="*" element={<Navigate to="/admin" replace />} />
    </Routes>
  );
}
