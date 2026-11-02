import { Copy, Plus, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextArea, TextField } from '../../components/ui';
import { del, get, patch, post, put } from '../../lib/api';
import { formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { Table, usePermissions, useSensitive, useToast, type Row } from './kit';

interface Perm { id: string; resource: string; action: string; description: string; sensitive: boolean }
interface Role { id: string; key: string; name: string; description: string; isSystem: boolean; permissions: string[]; assignedCount: number; createdAt: string; updatedAt: string }

const RESOURCE_LABELS: Record<string, string> = { dashboard: 'Dashboard', users: 'Users', tenants: 'Tenants', mailboxes: 'Mailboxes', domains: 'Domains', provisioning: 'Provisioning', notifications: 'Email delivery', support: 'Support', abuse: 'Abuse', settings: 'Settings', plans: 'Plans', roles: 'Roles', permissions: 'Permissions', admins: 'Administrators', audit: 'Audit log', mailbox_access: 'Mailbox content access' };
const CORE = ['read', 'create', 'update', 'delete'];

export default function Roles() {
  const { has } = usePermissions();
  const nav = useNavigate();
  const toast = useToast();
  const s = useSensitive();
  const q = useAsync(() => get<{ roles: Role[] }>('/admin/roles'), []);
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState('');
  const [error, setError] = useState<unknown>(null);
  const roles = (q.data?.roles ?? []).filter((r) => (!search || `${r.name} ${r.description}`.toLowerCase().includes(search.toLowerCase())) && (!kind || (kind === 'system') === r.isSystem));
  return (
    <>
      <PageHeader title="Roles & permissions" subtitle="Platform roles control what administrators can do. Workspace roles (owner, admin, mailbox user) never grant platform access." actions={has('roles.create') ? <Button variant="primary" onClick={() => nav('/admin/roles/new')}><Plus size={16} /> Create role</Button> : undefined} />
      <Card>
        <div className="filters">
          <TextField label="Search roles" value={search} onChange={(e) => setSearch(e.target.value)} />
          <SelectField label="Type" value={kind} onChange={(e) => setKind(e.target.value)}><option value="">All</option><option value="system">System</option><option value="custom">Custom</option></SelectField>
        </div>
      </Card>
      <ErrorAlert error={error} />
      {q.loading && !q.data && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (
        <Card>
          <Table caption="Roles" head={['Role', 'Type', 'Administrators', 'Permissions', 'Updated', '']} rows={roles.map((r) => [
            <div><Link to={`/admin/roles/${r.id}`}><strong>{r.name}</strong></Link><div className="muted"><small>{r.description}</small></div></div>,
            <StatusBadge status={r.isSystem ? 'info' : 'ok'} label={r.isSystem ? 'System' : 'Custom'} />, r.assignedCount,
            <span title={r.permissions.join(', ')}>{r.permissions.length} granted</span>, timeAgo(r.updatedAt),
            <span className="row">
              <Link className="btn btn-sm" to={`/admin/roles/${r.id}`}>{r.isSystem || !has('roles.update') ? 'View' : 'Edit'}</Link>
              {has('roles.create') && <Button small aria-label={`Duplicate ${r.name}`} onClick={() => s.setAction({ title: `Duplicate ${r.name}`, label: 'Duplicate', noReason: true, body: <DuplicateName roleName={r.name} />, run: async () => { const res = await post<{ role: Role }>(`/admin/roles/${r.id}/duplicate`, { name: dupName.current.trim() }); toast.push(`Created ${res.role.name}.`); nav(`/admin/roles/${res.role.id}`); } })}><Copy size={14} /></Button>}
              {has('roles.delete') && !r.isSystem && <Button small variant="danger" aria-label={`Delete ${r.name}`} disabled={r.assignedCount > 0} title={r.assignedCount > 0 ? 'Reassign its administrators first' : ''} onClick={() => s.setAction({ title: `Delete ${r.name}`, label: 'Delete role', danger: true, noReason: true, typed: r.name, run: async () => { try { await del(`/admin/roles/${r.id}`); toast.push('Role deleted.'); } catch (e) { setError(e); throw e; } } })}><Trash2 size={14} /></Button>}
            </span>,
          ])} empty="No roles match." />
        </Card>
      )}
      {s.dialog(() => void q.reload())}
    </>
  );
}

const dupName = { current: '' };
function DuplicateName({ roleName }: { roleName: string }) {
  const [v, setV] = useState(`${roleName} copy`);
  dupName.current = v;
  return <TextField label="Name for the copy" value={v} onChange={(e) => setV(e.target.value)} />;
}

export function RoleEditor() {
  const { roleId } = useParams();
  const isNew = !roleId || roleId === 'new';
  const { has, set: mine } = usePermissions();
  const nav = useNavigate();
  const toast = useToast();
  const catalog = useAsync(() => get<{ permissions: Perm[] }>('/admin/permissions'), []);
  const existing = useAsync(() => (isNew ? Promise.resolve(null) : get<{ role: Role; members: Row[] }>(`/admin/roles/${roleId}`)), [roleId]);
  const [name, setName] = useState<string | null>(null);
  const [description, setDescription] = useState<string | null>(null);
  const [granted, setGranted] = useState<Set<string> | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const role = existing.data?.role;
  const readOnly = !isNew && (role?.isSystem || !has('roles.update'));
  const current = granted ?? new Set(role?.permissions ?? []);
  const perms = useMemo(() => catalog.data?.permissions ?? [], [catalog.data]);
  const byResource = useMemo(() => { const m = new Map<string, Perm[]>(); for (const p of perms) m.set(p.resource, [...(m.get(p.resource) ?? []), p]); return m; }, [perms]);
  if ((catalog.loading && !catalog.data) || (existing.loading && !existing.data && !isNew)) return <Spinner />;
  if (catalog.error || existing.error) return <ErrorAlert error={catalog.error ?? existing.error} />;
  const added = perms.filter((p) => current.has(p.id) && !(role?.permissions ?? []).includes(p.id));
  const removed = (role?.permissions ?? []).filter((id) => !current.has(id));
  const highPriv = perms.filter((p) => current.has(p.id) && p.sensitive);
  const toggle = (id: string) => { const n = new Set(current); if (n.has(id)) n.delete(id); else n.add(id); setGranted(n); };
  const save = async () => {
    setBusy(true); setError(null);
    try {
      const body = { name: (name ?? role?.name ?? '').trim(), description: (description ?? role?.description ?? '').trim(), permissions: [...current] };
      if (isNew) { const r = await post<{ role: Role }>('/admin/roles', body); toast.push('Role created.'); nav(`/admin/roles/${r.role.id}`); }
      else { await patch(`/admin/roles/${roleId}`, body); toast.push('Role saved. Changes apply to administrators on their next request.'); setReviewing(false); setGranted(null); await existing.reload(); }
    } catch (e) { setError(e); } finally { setBusy(false); }
  };
  return (
    <>
      <PageHeader title={isNew ? 'Create role' : role!.name} subtitle={<><Link to="/admin/roles">All roles</Link>{role?.isSystem ? ' · built-in role (read-only)' : ''}</>} actions={role ? <StatusBadge status={role.isSystem ? 'info' : 'ok'} label={role.isSystem ? 'System' : 'Custom'} /> : undefined} />
      <ErrorAlert error={error} />
      {role?.isSystem && <Alert kind="info">Built-in roles cannot be changed. Duplicate this role from the roles list to customise it.</Alert>}
      <Card title="Details">
        <TextField label="Role name" value={name ?? role?.name ?? ''} onChange={(e) => setName(e.target.value)} disabled={readOnly} maxLength={80} />
        <TextArea label="Description" value={description ?? role?.description ?? ''} onChange={(e) => setDescription(e.target.value)} disabled={readOnly} rows={2} maxLength={300} />
      </Card>
      <Card title="Permissions" actions={<span className="muted">{current.size} of {perms.length} selected</span>}>
        {!readOnly && <p className="muted"><small>You can only grant permissions you hold yourself. Permissions marked <span className="perm-sensitive">● high privilege</span> are sensitive.</small></p>}
        <div className="table-wrap">
          <table className="matrix">
            <thead><tr><th scope="col">Resource</th>{CORE.map((a) => <th key={a} scope="col">{a[0]!.toUpperCase() + a.slice(1)}</th>)}<th scope="col">Special actions</th></tr></thead>
            <tbody>
              {[...byResource.entries()].map(([resource, list]) => {
                const special = list.filter((p) => !CORE.includes(p.action));
                return (
                  <tr key={resource}>
                    <th scope="row" style={{ textTransform: 'none', letterSpacing: 0, color: 'var(--text)', fontSize: '.9rem' }}>{RESOURCE_LABELS[resource] ?? resource}</th>
                    {CORE.map((a) => { const p = list.find((x) => x.action === a); return <td key={a} data-label={a}>{p ? <PermBox p={p} checked={current.has(p.id)} disabled={readOnly || !mine.has(p.id)} onChange={() => toggle(p.id)} /> : <span aria-hidden className="muted">—</span>}</td>; })}
                    <td data-label="Special actions"><span className="row" style={{ justifyContent: 'center' }}>{special.map((p) => <PermBox key={p.id} p={p} checked={current.has(p.id)} disabled={readOnly || !mine.has(p.id)} onChange={() => toggle(p.id)} text={p.action.replace(/[._]/g, ' ')} />)}{special.length === 0 && <span aria-hidden className="muted">—</span>}</span></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Card>
      {!readOnly && !reviewing && <div className="row"><Button variant="primary" disabled={!(name ?? role?.name ?? '').trim() || (!isNew && !granted && name === null && description === null)} onClick={() => setReviewing(true)}>Review changes</Button><Button onClick={() => nav('/admin/roles')}>Cancel</Button></div>}
      {reviewing && (
        <Card title="Review before saving">
          {highPriv.length > 0 && <Alert kind="warning" title="This role includes high-privilege permissions">{highPriv.map((p) => p.id).join(', ')}. Administrators with this role can make significant changes to the platform.</Alert>}
          {current.size === 0 && <Alert kind="info">This role grants no permissions; holders can only view the dashboard shell.</Alert>}
          {!isNew && <p><strong>{added.length}</strong> added{added.length ? `: ${added.map((p) => p.id).join(', ')}` : ''} · <strong>{removed.length}</strong> removed{removed.length ? `: ${removed.join(', ')}` : ''}</p>}
          {isNew && <p>Grants <strong>{current.size}</strong> permission(s).</p>}
          <div className="row"><Button variant="primary" busy={busy} onClick={() => void save()}>{isNew ? 'Create role' : 'Save role'}</Button><Button onClick={() => setReviewing(false)}>Keep editing</Button></div>
        </Card>
      )}
      {!isNew && existing.data && (
        <Card title={`Administrators with this role (${existing.data.members.length})`}>
          <Table head={['Name', 'Email', 'Status']} rows={existing.data.members.map((m) => [m.display_name, m.email, <StatusBadge status={m.status} />])} empty="No administrators hold this role." />
        </Card>
      )}
    </>
  );
}

function PermBox({ p, checked, disabled, onChange, text }: { p: Perm; checked: boolean; disabled: boolean; onChange: () => void; text?: string }) {
  return (
    <label title={`${p.id} — ${p.description}${disabled && !checked ? ' (you do not hold this permission)' : ''}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={onChange} aria-label={`${p.id}: ${p.description}`} />
      {text && <small>{text}</small>}
      {p.sensitive && <span className="perm-sensitive" aria-hidden>●</span>}
    </label>
  );
}

export function Admins() {
  const toast = useToast();
  const s = useSensitive();
  const admins = useAsync(() => get<{ admins: Row[] }>('/admin/admins'), []);
  const roles = useAsync(() => get<{ roles: Role[] }>('/admin/roles').catch(() => ({ roles: [] as Role[] })), []);
  const { has } = usePermissions();
  const [roleFor, setRoleFor] = useState<{ id: string; email: string } | null>(null);
  const [pick, setPick] = useState('');
  return (
    <>
      <PageHeader title="Administrators" subtitle="Platform staff are separate from customer accounts. Create them with the operator command npm run admin:create, then assign a role here." />
      {admins.loading && !admins.data && <Spinner />}
      <ErrorAlert error={admins.error} onRetry={admins.reload} />
      {admins.data && (
        <Card>
          <Table caption="Platform administrators" head={['Name', 'Email', 'Role', 'Status', 'MFA', 'Last sign-in', '']} rows={admins.data.admins.map((a) => [
            a.display_name, a.email, a.role_name ?? a.platform_role, <StatusBadge status={a.status} />, a.mfa_enabled ? 'on' : 'off', timeAgo(a.last_login_at),
            <span className="row">
              {has('admins.manage') && <Button small onClick={() => { setRoleFor({ id: a.id, email: a.email }); setPick(a.role_id ?? ''); }}>Change role</Button>}
              <Button small onClick={() => s.setAction({ title: `Sign ${a.email} out everywhere`, label: 'Revoke sessions', run: (reason) => post(`/admin/admins/${a.id}/revoke-sessions`, { reason, confirm: true }) })}>Revoke sessions</Button>
              {a.status === 'active' && <Button small variant="danger" onClick={() => s.setAction({ title: `Suspend ${a.email}`, label: 'Suspend', danger: true, body: 'The last active Super Administrator cannot be suspended.', run: (reason) => post(`/admin/admins/${a.id}/suspend`, { reason, confirm: true }) })}>Suspend</Button>}
            </span>,
          ])} />
        </Card>
      )}
      {roleFor && (
        <Card title={`Change role for ${roleFor.email}`}>
          <SelectField label="Role" value={pick} onChange={(e) => setPick(e.target.value)}><option value="">Select…</option>{roles.data?.roles.map((r) => <option key={r.id} value={r.id}>{r.name}{r.isSystem ? ' (system)' : ''}</option>)}</SelectField>
          <p className="muted"><small>Their sessions end immediately so the new privileges apply cleanly. You can only assign roles whose permissions you hold.</small></p>
          <div className="row"><Button variant="primary" disabled={!pick} onClick={() => s.setAction({ title: `Assign role to ${roleFor.email}`, label: 'Assign role', danger: true, run: async (reason) => { await put(`/admin/admins/${roleFor.id}/role`, { roleId: pick, reason, confirm: true }); toast.push('Role assigned.'); setRoleFor(null); } })}>Continue</Button><Button onClick={() => setRoleFor(null)}>Cancel</Button></div>
        </Card>
      )}
      <p className="muted"><small>Last updated {formatDate(new Date().toISOString())}</small></p>
      {s.dialog(() => void admins.reload())}
    </>
  );
}
