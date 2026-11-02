import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Button, Card, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { get, post } from '../../lib/api';
import { formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Pager, SortHead, Table, qs, useFilters, usePermissions, useSensitive, useToast, type Row } from './kit';

const EMPTY = { q: '', status: '', role: '', verified: '', mfa: '', tenantId: '', createdFrom: '', createdTo: '' };

export default function Users() {
  const f = useFilters(EMPTY);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState('created');
  const [dir, setDir] = useState<'asc' | 'desc'>('desc');
  const { has } = usePermissions();
  const nav = useNavigate();
  const q = useAsync(() => get<{ users: Row[]; total: number }>(`/admin/users${qs({ ...f.applied, sort, dir, page, pageSize: 25 })}`), [f.applied, sort, dir, page]);
  const tenants = useAsync(() => (has('tenants.read') ? get<{ tenants: Row[] }>('/admin/tenants?pageSize=100') : Promise.resolve({ tenants: [] })), []);
  const onSort = (field: string) => { setPage(1); if (sort === field) setDir(dir === 'asc' ? 'desc' : 'asc'); else { setSort(field); setDir('asc'); } };
  return (
    <>
      <PageHeader title="Users" subtitle="Customer accounts. Platform administrators are managed under Administrators." actions={has('users.create') ? <Button variant="primary" onClick={() => nav('/admin/users/new')}><Plus size={16} /> Create user</Button> : undefined} />
      <Card>
        <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); f.apply(); }}>
          <TextField label="Search" placeholder="Name or email" value={f.draft.q} onChange={(e) => f.set('q', e.target.value)} />
          <SelectField label="Status" value={f.draft.status} onChange={(e) => f.set('status', e.target.value)}><option value="">Any</option>{['pending_verification', 'active', 'suspended', 'closed'].map((s) => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}</SelectField>
          <SelectField label="Workspace role" value={f.draft.role} onChange={(e) => f.set('role', e.target.value)}><option value="">Any</option>{['owner', 'admin', 'mailbox_user', 'billing'].map((s) => <option key={s} value={s}>{s.replace('_', ' ')}</option>)}</SelectField>
          <SelectField label="Workspace" value={f.draft.tenantId} onChange={(e) => f.set('tenantId', e.target.value)}><option value="">Any</option>{tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField>
          <SelectField label="Email verified" value={f.draft.verified} onChange={(e) => f.set('verified', e.target.value)}><option value="">Any</option><option value="yes">Verified</option><option value="no">Not verified</option></SelectField>
          <SelectField label="MFA" value={f.draft.mfa} onChange={(e) => f.set('mfa', e.target.value)}><option value="">Any</option><option value="yes">Enabled</option><option value="no">Not enabled</option></SelectField>
          <TextField label="Created from" type="date" value={f.draft.createdFrom} onChange={(e) => f.set('createdFrom', e.target.value)} />
          <TextField label="Created to" type="date" value={f.draft.createdTo} onChange={(e) => f.set('createdTo', e.target.value)} />
          <div className="row"><Button type="submit" variant="primary">Apply</Button><Button type="button" onClick={() => { setPage(1); f.reset(); }}>Reset</Button></div>
        </form>
      </Card>
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Users" head={['Name', 'Email', 'Status', 'Workspaces & roles', 'MFA', 'Verified', 'Created', 'Last login', 'Invitation', '']} rows={q.data.users.map((u) => [
            <Link to={`/admin/users/${u.id}`}>{u.display_name}</Link>, u.email, <StatusBadge status={u.status} />,
            u.memberships.length ? <span className="chips">{u.memberships.map((m: Row) => <span className="chip" key={m.tenantId}>{m.name} · {String(m.role).replace('_', ' ')}</span>)}</span> : <span className="muted">none</span>,
            u.mfa_enabled ? 'on' : 'off', u.email_verified_at ? 'yes' : 'no', formatDate(u.created_at), timeAgo(u.last_login_at), u.invitation ? <StatusBadge status={u.invitation} /> : '—',
            <Link className="btn btn-sm" to={`/admin/users/${u.id}`}>View</Link>,
          ])} empty="No users match these filters." />
          <div className="row" aria-label="Sort"><small className="muted">Sort by</small>{[['created', 'Created'], ['name', 'Name'], ['email', 'Email'], ['last_login', 'Last login']].map(([k, l]) => <SortHead key={k} label={l!} field={k!} sort={sort} dir={dir} onSort={onSort} />)}</div>
          <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </Card>
      )}
    </>
  );
}

export function Invitations() {
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  const [page, setPage] = useState(1);
  const { has } = usePermissions();
  const toast = useToast();
  const s = useSensitive();
  const q = useAsync(() => get<{ invitations: Row[]; total: number }>(`/admin/invitations${qs({ status, q: applied, page, pageSize: 25 })}`), [status, applied, page]);
  const [error, setError] = useState<unknown>(null);
  const resend = async (id: string) => {
    setError(null);
    try { await post(`/admin/invitations/${id}/resend`); toast.push('A new invitation was queued. The previous link no longer works.'); await q.reload(); } catch (e) { setError(e); }
  };
  return (
    <>
      <PageHeader title="Invitations" subtitle="Account activation links. Only a hash of each link is stored; resending replaces the previous link." />
      <Card>
        <form role="search" className="filters" onSubmit={(e) => { e.preventDefault(); setPage(1); setApplied(search); }}>
          <TextField label="Email" value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectField label="Status" value={status} onChange={(e) => { setPage(1); setStatus(e.target.value); }}><option value="">Any</option>{['pending', 'consumed', 'revoked', 'expired'].map((x) => <option key={x}>{x}</option>)}</SelectField>
          <div className="row"><Button type="submit">Search</Button></div>
        </form>
      </Card>
      <ErrorAlert error={error} />
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Invitations" head={['Email', 'Workspace', 'Status', 'Email delivery', 'Sent', 'Expires', '']} rows={q.data.invitations.map((i) => [
            i.email, i.workspace ?? '—', <StatusBadge status={i.is_expired ? 'expired' : i.status} />,
            <span title={i.last_error ?? ''}><StatusBadge status={i.delivery === 'sent' ? 'ok' : i.delivery} label={i.delivery === 'queued' && i.attempts > 0 ? `retrying (${i.attempts})` : i.delivery.replace('_', ' ')} /></span>,
            `${i.resend_count}×`, formatDate(i.expires_at),
            has('users.update') && i.status !== 'consumed' ? <span className="row"><Button small onClick={() => void resend(i.id)}>{i.delivery === 'failed' ? 'Retry / resend' : 'Resend'}</Button>{i.status === 'pending' && !i.is_expired && <Button small variant="danger" onClick={() => s.setAction({ title: `Revoke invitation for ${i.email}`, label: 'Revoke', danger: true, body: 'The activation link stops working immediately.', run: (reason) => post(`/admin/invitations/${i.id}/revoke`, { reason }) })}>Revoke</Button>}</span> : null,
          ])} empty="No invitations match." />
          <Pager page={page} pageSize={25} total={q.data.total} onPage={setPage} />
        </Card>
      )}
      {s.dialog(() => void q.reload())}
    </>
  );
}
