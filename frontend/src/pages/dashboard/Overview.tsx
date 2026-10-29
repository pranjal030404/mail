import { Globe, Inbox, PlusCircle } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, ProgressBar, Spinner, StatusBadge, TextField } from '../../components/ui';
import { get, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatBytes, timeAgo } from '../../lib/format';
import type { DomainSummary, Usage } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

function CreateWorkspace() {
  const { refresh, setTenantId } = useAuth();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const t = await post<{ id: string }>('/tenants', { name });
      await refresh();
      setTenantId(t.id);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Welcome to ARTHVEX" subtitle="Create a workspace for your company or yourself, then add your own domain." />
      <Card title="Create your workspace">
        <form onSubmit={submit}>
          <TextField label="Company or personal workspace name" required minLength={2} value={name} onChange={(e) => setName(e.target.value)} />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" busy={busy}><PlusCircle size={16} /> Create workspace</Button>
        </form>
      </Card>
    </>
  );
}

export default function Overview() {
  const { tenantId, tenant, canManage, role } = useTenant();
  const { me } = useAuth();
  const usage = useAsync(() => (tenantId && role !== 'mailbox_user' ? get<Usage>(`/tenants/${tenantId}/usage`) : Promise.resolve(null)), [tenantId, role]);
  const domains = useAsync(() => (tenantId && canManage ? get<{ domains: DomainSummary[] }>(`/tenants/${tenantId}/domains`) : Promise.resolve(null)), [tenantId, canManage]);
  if (!tenantId) return me && me.user.platformRole !== 'none' && me.memberships.length === 0 ? <Navigate to="/admin" replace /> : <CreateWorkspace />;
  const u = usage.data;
  return (
    <>
      <PageHeader title={tenant?.name ?? 'Overview'} subtitle={`Signed in as ${me?.user.email} · role: ${role?.replace('_', ' ')}`} />
      {tenant?.tenantStatus === 'suspended' && <Alert kind="error" title="This workspace is suspended">You can view your settings but cannot make changes. Contact support.</Alert>}
      {usage.loading ? <Spinner /> : <ErrorAlert error={usage.error} onRetry={usage.reload} />}
      {u && (
        <>
          <div className="grid">
            <Card><div className="stat">{u.counts.domains}<small className="muted"> / {u.limits.domains}</small></div><div className="stat-label">Domains</div></Card>
            <Card><div className="stat">{u.counts.mailboxes}<small className="muted"> / {u.limits.mailboxes}</small></div><div className="stat-label">Mailboxes</div></Card>
            <Card><div className="stat">{u.counts.aliases}<small className="muted"> / {u.limits.aliases}</small></div><div className="stat-label">Aliases</div></Card>
            <Card>
              <div className="stat">{formatBytes(u.storage.usedBytes)}</div>
              <div className="stat-label">Used of {formatBytes(u.storage.allocatedBytes)} allocated ({formatBytes(u.limits.storageBytes)} plan)</div>
              <ProgressBar percent={u.storage.allocatedPercent} label="Allocated storage" />
            </Card>
          </div>
          <p className="muted"><small>Usage updated {timeAgo(u.collectedAt)}. {u.note}</small></p>
          {u.mailboxes.some((m) => m.threshold) && <Alert kind="warning" title="Mailboxes near their limit">{u.mailboxes.filter((m) => m.threshold).map((m) => `${m.address} (${m.percent}%)`).join(', ')}. <Link to="/dashboard/usage">See usage</Link></Alert>}
        </>
      )}
      {canManage && (
        <Card title={<><Globe size={16} /> Domains</>} actions={<Link className="btn btn-primary btn-sm" to="/dashboard/domains/new">Add domain</Link>}>
          {domains.loading ? <Spinner /> : domains.data && domains.data.domains.length === 0 ? <p className="muted">No domains yet. Add the domain you own to start. <Link to="/setup-guide">How setup works</Link></p> : (
            <ul className="stack" style={{ listStyle: 'none', padding: 0 }}>
              {domains.data?.domains.map((d) => (
                <li key={d.id} className="row spread">
                  <Link to={`/dashboard/domains/${d.id}`}><strong>{d.name}</strong></Link>
                  <span className="row"><StatusBadge status={d.ownershipStatus} label={`ownership: ${d.ownershipStatus}`} /><StatusBadge status={d.inboundStatus} label={`inbound: ${d.inboundStatus}`} /><StatusBadge status={d.outboundStatus} label={`outbound: ${d.outboundStatus}`} /></span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
      <Card title={<><Inbox size={16} /> Mailboxes</>} actions={<Link className="btn btn-sm" to="/dashboard/mailboxes">Manage</Link>}>
        <p className="muted">Create mailboxes, reset passwords and see email-app settings.</p>
      </Card>
    </>
  );
}
