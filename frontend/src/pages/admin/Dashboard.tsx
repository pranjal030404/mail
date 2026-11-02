import { Link } from 'react-router-dom';
import { Alert, Button, Card, DevBanner, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge } from '../../components/ui';
import { get } from '../../lib/api';
import { formatBytes, formatDate, timeAgo } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';
import { useState } from 'react';
import { Table, usePermissions, type Row } from './kit';

const Stat = ({ label, value, to, tone }: { label: string; value: string | number; to?: string; tone?: 'bad' | 'warn' }) => (
  <Card>
    <div className="stat" style={tone ? { color: `var(--${tone})` } : undefined}>{value}</div>
    <div className="stat-label">{to ? <Link to={to}>{label}</Link> : label}</div>
  </Card>
);

export default function Dashboard() {
  const [days, setDays] = useState('7');
  const { has } = usePermissions();
  const d = useAsync(() => get<Row>(`/admin/dashboard?days=${days}`), [days]);
  // Service health comes from a separate endpoint; it needs tenants.read-level visibility of operations data.
  const health = useAsync(() => get<Row>('/admin/metrics'), []);
  const c = d.data?.counts as Record<string, number> | undefined;
  const m = health.data;
  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle="Live figures from the platform database. Anything not collected is marked unavailable."
        actions={<>
          <SelectField label="Date range" value={days} onChange={(e) => setDays(e.target.value)}>
            <option value="1">Last 24 hours</option><option value="7">Last 7 days</option><option value="30">Last 30 days</option><option value="90">Last 90 days</option>
          </SelectField>
          <Button onClick={() => { void d.reload(); void health.reload(); }}>Refresh</Button>
        </>}
      />
      {m && <DevBanner simulated={m.platform.simulatedMail} />}
      {m && !m.services.workers.ok && <Alert kind="error" title="No worker heartbeat">Provisioning jobs and queued emails will not be processed until a worker is started.</Alert>}
      {m && !m.services.mailEngine.ok && <Alert kind="error" title="Mail engine unreachable">{m.services.mailEngine.detail}</Alert>}
      {m?.platform.maintenanceMode && <Alert kind="warning" title="Maintenance mode is ON">Customers are blocked.</Alert>}
      {d.loading && !c && <Spinner />}
      <ErrorAlert error={d.error} onRetry={d.reload} />
      {c && (
        <>
          <h2 className="section-title">People</h2>
          <div className="stat-grid">
            <Stat label="Registered users" value={c.users_total!} to={has('users.read') ? '/admin/users' : undefined} />
            <Stat label="Active users" value={c.users_active!} />
            <Stat label={`New users (${days === '1' ? '24 h' : `${days} d`})`} value={c.users_new!} />
            <Stat label="Pending invitations" value={c.invites_pending!} to={has('users.read') ? '/admin/invitations' : undefined} />
            <Stat label="Expired invitations" value={c.invites_expired!} tone={c.invites_expired! > 0 ? 'warn' : undefined} />
            <Stat label="Invitation emails failed" value={c.invites_failed!} tone={c.invites_failed! > 0 ? 'bad' : undefined} />
          </div>
          <h2 className="section-title">Infrastructure</h2>
          <div className="stat-grid">
            <Stat label="Tenants" value={c.tenants_total!} to="/admin/tenants" />
            <Stat label="Suspended tenants" value={c.tenants_suspended!} />
            <Stat label="Verified domains" value={`${c.domains_verified} / ${c.domains_total}`} />
            <Stat label="Active mailboxes" value={c.mb_active!} to="/admin/mailboxes" />
            <Stat label="Suspended mailboxes" value={c.mb_suspended!} />
            <Stat label="Pending mailboxes" value={c.mb_pending!} />
            <Stat label="Failed mailboxes" value={c.mb_failed!} tone={c.mb_failed! > 0 ? 'bad' : undefined} />
            <Stat label={`Storage used of ${formatBytes(c.storage_allocated!)}`} value={formatBytes(c.storage_used!)} />
          </div>
          <h2 className="section-title">Provisioning</h2>
          <div className="stat-grid">
            <Stat label={`Succeeded (${days} d)`} value={c.jobs_ok!} />
            <Stat label={`Failed (${days} d)`} value={c.jobs_failed!} tone={c.jobs_failed! > 0 ? 'bad' : undefined} to={has('provisioning.read') ? '/admin/jobs' : undefined} />
            <Stat label="Pending jobs" value={c.jobs_pending!} />
          </div>
        </>
      )}
      <div className="grid">
        <Card title="Service health">
          {health.loading && !m && <Spinner />}
          {health.error ? <Alert kind="warning" title="Health data unavailable">You may lack access to service status, or the request failed.</Alert> : null}
          {m && <Table head={['Service', 'Status', 'Detail']} rows={[
            ['Database', <StatusBadge status="ok" />, 'Reachable'],
            ['Mail engine', <StatusBadge status={m.services.mailEngine.ok ? 'ok' : 'error'} />, `${m.services.mailEngine.description}: ${m.services.mailEngine.detail}`],
            ['Workers', <StatusBadge status={m.services.workers.ok ? 'ok' : 'error'} />, `${m.services.workers.live} live`],
            ['Platform mailer', <StatusBadge status={m.services.mailer.kind === 'smtp' ? 'ok' : 'warning'} />, m.services.mailer.kind === 'smtp' ? 'SMTP' : 'Development outbox (not sent)'],
          ]} />}
          {d.data && <p className="muted"><small>{d.data.unavailable.mailQueue}</small></p>}
        </Card>
        <Card title="Email delivery" actions={has('notifications.read') ? <Link to="/admin/notifications">Open</Link> : undefined}>
          {d.data && <div className="chips">{Object.entries(d.data.emails as Record<string, number>).map(([k, v]) => <span key={k} className="chip"><StatusBadge status={k} /> {v}</span>)}{Object.keys(d.data.emails).length === 0 && <span className="muted">No messages in the last 30 days.</span>}</div>}
          {(d.data?.recentEmailFailures as Row[] | undefined)?.length ?  <Table head={['To', 'Kind', 'Error']} rows={(d.data!.recentEmailFailures as Row[]).map((f) => [f.to_email, f.kind, f.last_error ?? ''])} /> : null}
        </Card>
      </div>
      {d.data?.activity && (
        <Card title="Recent administrative activity" actions={has('audit.read') ? <Link to="/admin/audit">Audit log</Link> : undefined}>
          <Table head={['When', 'Action', 'Target', 'Outcome']} rows={d.data.activity.map((a: Row) => [timeAgo(a.occurred_at), a.action, a.target_type ? `${a.target_type} …${String(a.target_id ?? '').slice(-6)}` : '', <StatusBadge status={a.outcome === 'success' ? 'ok' : 'error'} label={a.outcome} />])} empty="No administrative activity yet." />
          <small className="muted">Latest event: {formatDate(d.data.activity[0]?.occurred_at)}</small>
        </Card>
      )}
    </>
  );
}
