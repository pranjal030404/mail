import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Table, usePermissions, useSensitive, useToast, type Row } from './kit';

const ROLES = ['owner', 'admin', 'mailbox_user', 'billing'];

export default function UserDetail() {
  const { userId } = useParams();
  const { has } = usePermissions();
  const toast = useToast();
  const s = useSensitive();
  const q = useAsync(() => get<Row>(`/admin/users/${userId}`), [userId]);
  const tenants = useAsync(() => (has('tenants.read') ? get<{ tenants: Row[] }>('/admin/tenants?pageSize=100') : Promise.resolve({ tenants: [] })), []);
  const [name, setName] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [addTenant, setAddTenant] = useState('');
  const [addRole, setAddRole] = useState('mailbox_user');
  const [preview, setPreview] = useState<Row | null>(null);
  const d = q.data;
  if (q.loading && !d) return <Spinner />;
  if (!d) return <ErrorAlert error={q.error} />;
  const u = d.user as Row;
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setError(null);
    try { await fn(); toast.push(ok); await q.reload(); } catch (e) { setError(e); }
  };
  const pendingInv = (d.invitations as Row[]).find((i) => i.status === 'pending' && !i.is_expired);
  return (
    <>
      <PageHeader title={u.display_name} subtitle={<>{u.email} · <Link to="/admin/users">All users</Link></>} actions={<StatusBadge status={u.status} />} />
      <ErrorAlert error={error} />
      {u.suspended_reason && <Alert kind="warning" title="Suspended">{u.suspended_reason}</Alert>}
      {u.status === 'pending_verification' && <Alert kind="info" title="Waiting for activation">This account cannot sign in until the invitation link is used to choose a password.</Alert>}

      <div className="grid">
        <Card title="Profile">
          {has('users.update') ? (
            <form onSubmit={(e) => { e.preventDefault(); if (name !== null) void run(() => patch(`/admin/users/${userId}`, { displayName: name }), 'Profile updated.'); }}>
              <TextField label="Display name" value={name ?? u.display_name} onChange={(e) => setName(e.target.value)} />
              <Button type="submit" variant="primary" disabled={name === null || name === u.display_name}>Save</Button>
            </form>
          ) : <dl className="kv"><dt>Name</dt><dd>{u.display_name}</dd></dl>}
          <dl className="kv" style={{ marginTop: '1rem' }}>
            <dt>Created</dt><dd>{formatDate(u.created_at)}</dd><dt>Last login</dt><dd>{timeAgo(u.last_login_at)}</dd>
            <dt>Time zone</dt><dd>{u.timezone}</dd><dt>Locale</dt><dd>{u.locale}</dd>
          </dl>
        </Card>
        <Card title="Security">
          <dl className="kv">
            <dt>Email verified</dt><dd>{d.security.emailVerified ? 'yes' : 'no'}</dd><dt>MFA</dt><dd>{d.security.mfaEnabled ? 'enabled' : 'not enabled'}</dd>
            <dt>Active sessions</dt><dd>{d.security.activeSessions}</dd><dt>Locked</dt><dd>{d.security.locked ? 'yes' : 'no'}</dd>
          </dl>
          <div className="row" style={{ marginTop: '.8rem' }}>
            {has('users.sessions.revoke') && <Button small onClick={() => s.setAction({ title: `Sign ${u.email} out everywhere`, label: 'Revoke sessions', run: (reason) => post(`/admin/users/${userId}/revoke-sessions`, { reason, confirm: true }) })}>Revoke sessions</Button>}
            {has('users.password_reset') && u.status === 'active' && <Button small onClick={() => void run(() => post(`/admin/users/${userId}/password-reset`), 'Password-reset link queued for delivery.')}>Send password reset</Button>}
            {has('users.password_reset') && d.security.mfaEnabled && <Button small variant="danger" onClick={() => s.setAction({ title: 'Require MFA re-enrolment', label: 'Reset MFA', danger: true, body: 'Removes the authenticator and recovery codes and signs the user out everywhere.', run: (reason) => post(`/admin/users/${userId}/reset-mfa`, { reason, confirm: true }) })}>Reset MFA</Button>}
          </div>
        </Card>
      </div>

      <Card title="Workspace memberships">
        <Table head={['Workspace', 'Role', 'Status', '']} rows={(d.memberships as Row[]).map((m) => [
          <Link to={`/admin/tenants/${m.tenant_id}`}>{m.tenant_name}</Link>,
          has('users.update') ? <select aria-label={`Role in ${m.tenant_name}`} value={m.role} onChange={(e) => void run(() => patch(`/admin/users/${userId}/memberships/${m.id}`, { role: e.target.value }), 'Role updated.')} style={{ width: 'auto' }}>{ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</select> : m.role,
          <StatusBadge status={m.status} />,
          has('users.update') ? <Button small variant="danger" onClick={() => s.setAction({ title: `Remove from ${m.tenant_name}`, label: 'Remove', danger: true, noReason: true, body: 'The user loses access to this workspace. A workspace must keep at least one owner.', run: () => del(`/admin/users/${userId}/memberships/${m.id}`) })}>Remove</Button> : null,
        ])} empty="Not a member of any workspace." />
        {has('users.update') && (
          <form className="row" style={{ alignItems: 'flex-end', marginTop: '1rem' }} onSubmit={(e) => { e.preventDefault(); void run(() => post(`/admin/users/${userId}/memberships`, { tenantId: addTenant, role: addRole }), 'Membership added.'); }}>
            <SelectField label="Add to workspace" value={addTenant} onChange={(e) => setAddTenant(e.target.value)}><option value="">Select…</option>{tenants.data?.tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField>
            <SelectField label="Role" value={addRole} onChange={(e) => setAddRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}</SelectField>
            <Button type="submit" disabled={!addTenant}>Add</Button>
          </form>
        )}
      </Card>

      <Card title="Mailboxes">
        <Table head={['Address', 'Workspace', 'Status', 'Usage']} rows={(d.mailboxes as Row[]).map((m) => [has('mailboxes.read') ? <Link to={`/admin/mailboxes/${m.id}`}>{m.address}</Link> : m.address, m.tenant_name, <StatusBadge status={m.status} />, `${formatBytes(m.used_bytes === null ? null : Number(m.used_bytes))} / ${formatBytes(Number(m.quota_bytes))}`])} empty="No mailbox is linked to this user." />
      </Card>

      <Card title="Invitations">
        <Table head={['Created', 'Status', 'Email delivery', 'Sends', 'Expires', '']} rows={(d.invitations as Row[]).map((i) => [
          formatDate(i.created_at), <StatusBadge status={i.is_expired ? 'expired' : i.status} />, <span title={i.last_error ?? ''}><StatusBadge status={i.delivery === 'sent' ? 'ok' : i.delivery} label={i.delivery.replace('_', ' ')} /></span>, i.resend_count, formatDate(i.expires_at),
          has('users.update') && i.status !== 'consumed' ? <span className="row"><Button small onClick={() => void run(() => post(`/admin/invitations/${i.id}/resend`), 'Invitation queued.')}>Resend</Button>{i.status === 'pending' && !i.is_expired && <Button small variant="danger" onClick={() => s.setAction({ title: 'Revoke invitation', label: 'Revoke', danger: true, run: (reason) => post(`/admin/invitations/${i.id}/revoke`, { reason }) })}>Revoke</Button>}</span> : null,
        ])} empty="No invitations." />
        {has('users.create') && u.status === 'pending_verification' && !pendingInv && (d.invitations as Row[]).length === 0 && <Button variant="primary" onClick={() => void run(() => post(`/admin/users/${userId}/invitations`), 'Invitation queued.')}>Send invitation</Button>}
      </Card>

      {d.audit && <Card title="Audit history"><Table head={['When', 'Action', 'Outcome', 'Reason']} rows={(d.audit as Row[]).map((a) => [formatDate(a.occurred_at), a.action, <StatusBadge status={a.outcome === 'success' ? 'ok' : 'error'} label={a.outcome} />, a.reason ?? ''])} empty="No history." /></Card>}

      {(has('users.suspend') || has('users.delete')) && u.status !== 'closed' && (
        <Card title="Account actions">
          <div className="row">
            {has('users.suspend') && u.status === 'active' && <Button variant="danger" onClick={() => s.setAction({ title: `Suspend ${u.email}`, label: 'Suspend user', danger: true, body: 'The user is signed out everywhere and notified by email.', run: (reason) => post(`/admin/users/${userId}/suspend`, { reason, confirm: true }) })}>Suspend</Button>}
            {has('users.suspend') && u.status === 'suspended' && <Button onClick={() => s.setAction({ title: `Reactivate ${u.email}`, label: 'Reactivate', run: (reason) => post(`/admin/users/${userId}/reactivate`, { reason, confirm: true }) })}>Reactivate</Button>}
            {has('users.delete') && <Button variant="danger" onClick={async () => { setError(null); try { setPreview(await get<Row>(`/admin/users/${userId}/deletion-preview`)); } catch (e) { setError(e); } }}>Close account…</Button>}
          </div>
          {preview && (
            <div className="stack" style={{ marginTop: '1rem' }}>
              <Alert kind={preview.allowed ? 'warning' : 'error'} title={preview.allowed ? 'Impact of closing this account' : 'This account cannot be closed yet'}>
                {preview.impact.memberships} workspace membership(s) will be revoked and {preview.impact.activeSessions} session(s) ended.
                {(preview.blockers as Row[]).map((b) => <div key={b.tenantId}><strong>{b.name}:</strong> {b.reason}</div>)}
              </Alert>
              {preview.allowed && <Button variant="danger" onClick={() => s.setAction({ title: `Close ${u.email}`, label: 'Close account', danger: true, typed: u.email, body: 'The account is closed and its sign-in ends. Retention rules apply to data.', run: async (reason) => { await post(`/admin/users/${userId}/close`, { reason, confirm: true, confirmEmail: u.email }); setPreview(null); } })}>Continue to confirmation</Button>}
            </div>
          )}
        </Card>
      )}
      {s.dialog(() => void q.reload())}
    </>
  );
}
