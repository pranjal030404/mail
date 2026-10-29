import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, ConfirmDialog, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { formatDate, titleCase } from '../../lib/format';
import type { Mailbox, TenantRole } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

interface Member { id: string; email: string | null; displayName: string | null; role: TenantRole; status: string; invitationExpiresAt: string | null }

export default function Members() {
  const { tenantId, role: myRole } = useTenant();
  const q = useAsync(() => get<{ members: Member[] }>(`/tenants/${tenantId}/members`), [tenantId]);
  const boxes = useAsync(() => get<{ mailboxes: Mailbox[] }>(`/tenants/${tenantId}/mailboxes?pageSize=100`), [tenantId]);
  const [f, setF] = useState({ email: '', role: 'admin' as TenantRole, mailboxId: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Member | null>(null);
  const roles: TenantRole[] = myRole === 'owner' ? ['owner', 'admin', 'mailbox_user', 'billing'] : ['admin', 'mailbox_user', 'billing'];
  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/tenants/${tenantId}/members`, { email: f.email, role: f.role, ...(f.role === 'mailbox_user' && f.mailboxId ? { mailboxId: f.mailboxId } : {}) });
      setNotice(`Invitation sent to ${f.email}. It is valid for 7 days.`);
      setF({ ...f, email: '' });
      await q.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Members" subtitle="People who can access this workspace." />
      <Card title="Invite someone">
        <form onSubmit={invite}>
          <div className="row" style={{ alignItems: 'flex-end' }}>
            <TextField label="Email" type="email" required value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
            <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value as TenantRole })}>{roles.map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</SelectField>
            {f.role === 'mailbox_user' && <SelectField label="Their mailbox" value={f.mailboxId} onChange={(e) => setF({ ...f, mailboxId: e.target.value })}><option value="">— none —</option>{boxes.data?.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</SelectField>}
          </div>
          <p className="muted"><small>Owners manage everything incl. other owners. Admins manage domains, mailboxes and aliases. Mailbox users see only their own mailbox. Billing contacts see plan and usage only.</small></p>
          <ErrorAlert error={error} />
          {notice && <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>}
          <Button type="submit" variant="primary" busy={busy}>Send invitation</Button>
        </form>
      </Card>
      {q.loading && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card><div className="table-wrap"><table>
          <thead><tr><th>Person</th><th>Role</th><th>Status</th><th /></tr></thead>
          <tbody>{q.data.members.map((m) => (
            <tr key={m.id}>
              <td>{m.displayName ?? m.email}{m.displayName && <div className="muted"><small>{m.email}</small></div>}</td>
              <td><select aria-label={`Role for ${m.email}`} value={m.role} onChange={async (e) => { try { await patch(`/tenants/${tenantId}/members/${m.id}`, { role: e.target.value }); await q.reload(); } catch (err) { setError(err); } }} style={{ minWidth: 150 }}>{(['owner', 'admin', 'mailbox_user', 'billing'] as TenantRole[]).map((r) => <option key={r} value={r}>{titleCase(r)}</option>)}</select></td>
              <td><StatusBadge status={m.status} />{m.invitationExpiresAt && <small className="muted"> expires {formatDate(m.invitationExpiresAt)}</small>}</td>
              <td><Button small variant="danger" onClick={() => setRemoving(m)}>Remove</Button></td>
            </tr>
          ))}</tbody>
        </table></div></Card>
      )}
      <ConfirmDialog open={!!removing} danger title="Remove member" confirmLabel="Remove" onCancel={() => setRemoving(null)} onConfirm={async () => { await del(`/tenants/${tenantId}/members/${removing!.id}`); setRemoving(null); await q.reload(); }}>
        <p>{removing?.email} will lose access to this workspace. Their mailbox, if any, is not deleted.</p>
      </ConfirmDialog>
    </>
  );
}
