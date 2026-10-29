import { CheckCircle2, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, PageHeader, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, post } from '../../lib/api';
import { formatDate, timeAgo } from '../../lib/format';
import type { DnsCheck, DnsRecord, DomainDetail, DomainSummary } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

function List() {
  const { tenantId, suspended } = useTenant();
  const q = useAsync(() => get<{ domains: DomainSummary[] }>(`/tenants/${tenantId}/domains`), [tenantId]);
  return (
    <>
      <PageHeader title="Domains" subtitle="Domains you own and have connected to ARTHVEX." actions={<Link className="btn btn-primary" to="/dashboard/domains/new" aria-disabled={suspended}>Add domain</Link>} />
      {q.loading && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && q.data.domains.length === 0 && <Card><EmptyState title="No domains yet">Add a domain you control. You will prove ownership with a DNS record.</EmptyState></Card>}
      {q.data && q.data.domains.length > 0 && (
        <Card>
          <div className="table-wrap">
            <table>
              <thead><tr><th>Domain</th><th>Ownership</th><th>Inbound (MX)</th><th>Outbound (SPF/DKIM/DMARC)</th><th>Mailboxes</th><th>Last check</th></tr></thead>
              <tbody>
                {q.data.domains.map((d) => (
                  <tr key={d.id}>
                    <td><Link to={`/dashboard/domains/${d.id}`}>{d.name}</Link></td>
                    <td><StatusBadge status={d.ownershipStatus} /></td>
                    <td><StatusBadge status={d.inboundStatus} /></td>
                    <td><StatusBadge status={d.outboundStatus} /></td>
                    <td>{d.mailboxCount}</td>
                    <td>{timeAgo(d.lastDnsCheckAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </>
  );
}

function AddDomain() {
  const { tenantId } = useTenant();
  const nav = useNavigate();
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const d = await post<DomainDetail>(`/tenants/${tenantId}/domains`, { name });
      nav(`/dashboard/domains/${d.id}`);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Add a domain" />
      <Wizard step={1} />
      <Card>
        <form onSubmit={submit}>
          <TextField label="Domain name" placeholder="company.com" required value={name} onChange={(e) => setName(e.target.value)} hint="Enter only the domain (no http://, no paths, no email address). You must own it and be able to edit its DNS." />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" busy={busy}>Continue</Button>
        </form>
      </Card>
    </>
  );
}

function Wizard({ step }: { step: number }) {
  const labels = ['Add domain', 'Verify ownership', 'Mail records', 'Diagnostics & readiness'];
  return (
    <ol className="steps" aria-label="Setup progress">
      {labels.map((l, i) => (
        <li key={l} className={i + 1 < step ? 'done' : ''} {...(i + 1 === step ? { 'aria-current': 'step' as const } : {})}>{l}</li>
      ))}
    </ol>
  );
}

function RecordTable({ records }: { records: DnsRecord[] }) {
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Type</th><th>Host / name</th><th>Value</th><th>Purpose</th></tr></thead>
        <tbody>
          {records.map((r, i) => (
            <tr key={i}>
              <td>{r.type}{r.priority !== undefined && <div className="muted"><small>priority {r.priority}</small></div>}</td>
              <td><div className="dns-value mono">{r.name}<CopyButton value={r.name} label="Copy name" /></div></td>
              <td><div className="dns-value mono">{r.value}<CopyButton value={r.value} label="Copy value" /></div></td>
              <td>{r.purpose}{r.required ? '' : ' (optional)'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Checks({ checks }: { checks: DnsCheck[] }) {
  if (!checks.length) return null;
  return (
    <div className="table-wrap">
      <table>
        <thead><tr><th>Check</th><th>Result</th><th>Expected</th><th>Observed</th><th>Checked</th></tr></thead>
        <tbody>
          {checks.map((c) => (
            <tr key={`${c.type}-${c.name}`}>
              <td>{c.type.toUpperCase()}<div className="muted mono"><small>{c.name}</small></div></td>
              <td><StatusBadge status={c.status} />{c.message && <div><small>{c.message}</small></div>}</td>
              <td className="mono">{c.expected ?? '—'}</td>
              <td className="mono">{c.observed ?? '—'}</td>
              <td>{timeAgo(c.checkedAt)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Detail() {
  const { domainId } = useParams();
  const { tenantId, canManage } = useTenant();
  const nav = useNavigate();
  const q = useAsync(() => get<DomainDetail>(`/tenants/${tenantId}/domains/${domainId}`), [tenantId, domainId]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const d = q.data;

  // While the domain is being provisioned on the mail server, poll until its records are available.
  useEffect(() => {
    if (!d || d.ownershipStatus !== 'verified' || d.expectedRecords) return;
    const t = setInterval(() => void q.reload(), 3000);
    return () => clearInterval(t);
  }, [d, q]);

  const run = async (name: string, path: string) => {
    setBusy(name);
    setError(null);
    try {
      q.setData(await post<DomainDetail>(`/tenants/${tenantId}/domains/${domainId}/${path}`));
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  if (q.loading && !d) return <Spinner />;
  if (!d) return <ErrorAlert error={q.error} onRetry={q.reload} />;
  const verified = d.ownershipStatus === 'verified';
  const step = !verified ? 2 : !d.expectedRecords ? 3 : 4;
  const ownershipChecks = d.checks.filter((c) => c.type === 'ownership');
  const mailChecks = d.checks.filter((c) => c.type !== 'ownership');
  return (
    <>
      <PageHeader title={d.name} subtitle={d.unicodeName !== d.name ? d.unicodeName : undefined} actions={canManage && <Button variant="danger" onClick={() => setConfirmRemove(true)}>Remove domain</Button>} />
      <Wizard step={step} />
      <ErrorAlert error={error} />

      <Card title="Status">
        <div className="row">
          <span>Ownership <StatusBadge status={d.ownershipStatus} /></span>
          <span>Inbound routing <StatusBadge status={d.inboundStatus} /></span>
          <span>Outbound authentication <StatusBadge status={d.outboundStatus} /></span>
          <span>Mail server setup <StatusBadge status={d.provisioningStatus} /></span>
        </div>
        <p className="muted"><small>Last DNS check: {formatDate(d.lastDnsCheckAt)}. {d.propagationNote}</small></p>
      </Card>

      {!verified && d.ownershipInstruction && (
        <Card title="1. Prove you own this domain" actions={canManage && <><Button busy={busy === 'verify'} variant="primary" onClick={() => run('verify', 'verify')}><RefreshCw size={14} /> Verify now</Button><Button busy={busy === 'rotate'} onClick={() => run('rotate', 'rotate-token')}>New token</Button></>}>
          <p>At your DNS provider, create this <strong>TXT</strong> record, then press Verify. We also re-check automatically every few minutes.</p>
          <div className="table-wrap"><table><tbody>
            <tr><th>Type</th><td>TXT</td></tr>
            <tr><th>Host / name</th><td><div className="dns-value mono">{d.ownershipInstruction.name}<CopyButton value={d.ownershipInstruction.name} label="Copy name" /></div></td></tr>
            <tr><th>Value</th><td><div className="dns-value mono">{d.ownershipInstruction.value}<CopyButton value={d.ownershipInstruction.value} label="Copy value" /></div></td></tr>
            <tr><th>TTL</th><td>{d.ownershipInstruction.ttlGuidance}</td></tr>
            <tr><th>Token expires</th><td>{formatDate(d.ownershipInstruction.expiresAt)}</td></tr>
          </tbody></table></div>
          <p className="muted"><small>Some DNS panels add the domain automatically: if so, enter only <code>_arthvex-verification</code> as the host. ARTHVEX does not change your DNS.</small></p>
          <Checks checks={ownershipChecks} />
          {ownershipChecks.some((c) => c.status === 'error') && <Alert kind="warning">The DNS lookup failed temporarily. This is not a verification failure — try again in a few minutes.</Alert>}
        </Card>
      )}

      {verified && (
        <Alert kind="success" title="Ownership verified"><CheckCircle2 size={14} /> Verified {formatDate(d.verifiedAt)}. You can remove the verification TXT record if you like.</Alert>
      )}

      {verified && !d.expectedRecords && <Card title="2. Setting up on the mail server"><Spinner label="Preparing your mail records" />{d.provisioningStatus === 'failed' && <Alert kind="error" title="Setup failed">ARTHVEX operations have been alerted. You do not need to retry.</Alert>}</Card>}

      {verified && d.expectedRecords && (
        <>
          <Card title="2. Publish these mail records" actions={canManage && <Button variant="primary" busy={busy === 'check'} onClick={() => run('check', 'dns-check')}><RefreshCw size={14} /> Run DNS check</Button>}>
            <p>Add these records at your DNS provider. <strong>Inbound</strong> (MX) decides whether mail reaches ARTHVEX; <strong>outbound</strong> (SPF, DKIM, DMARC) decides whether receivers trust mail you send. They are checked separately.</p>
            <RecordTable records={d.expectedRecords} />
            <p className="muted"><small>DMARC: start with <code>p=none</code> to monitor, then tighten to quarantine/reject once SPF and DKIM pass consistently. Reverse DNS (PTR) for the sending IP is managed by ARTHVEX’s network provider.</small></p>
          </Card>
          <Card title="3. DNS diagnostics">
            {mailChecks.length === 0 ? <p className="muted">No check yet. Run the DNS check after publishing records.</p> : <Checks checks={mailChecks} />}
          </Card>
          <Card title="4. Next step">
            {d.inboundStatus === 'ok' ? <p>Inbound routing is ready. <Link className="btn btn-primary btn-sm" to={`/dashboard/mailboxes?domain=${d.id}`}>Create mailboxes</Link></p> : <p className="muted">You can create mailboxes now; mail will arrive once inbound routing (MX) is ready.{' '}<Link className="btn btn-sm" to={`/dashboard/mailboxes?domain=${d.id}`}>Create mailboxes</Link></p>}
            {d.inboundStatus === 'ok' && d.outboundStatus !== 'ok' && <Alert kind="warning" title="Outbound authentication is not fully ready">Messages you send may be rejected or filed as spam until SPF, DKIM and DMARC pass.</Alert>}
          </Card>
        </>
      )}

      <RemoveDialog open={confirmRemove} tenantId={tenantId!} domain={d} onClose={() => setConfirmRemove(false)} onDone={() => nav('/dashboard/domains')} />
    </>
  );
}

function RemoveDialog({ open, tenantId, domain, onClose, onDone }: { open: boolean; tenantId: string; domain: DomainDetail; onClose: () => void; onDone: () => void }) {
  const impact = useAsync(() => (open ? get<{ mailboxes: { address: string; status: string }[]; aliases: string[]; consequences: string[]; canRemove: boolean }>(`/tenants/${tenantId}/domains/${domain.id}/removal-impact`) : Promise.resolve(null)), [open, tenantId, domain.id]);
  const i = impact.data;
  return (
    <ConfirmDialog open={open} title={`Remove ${domain.name}?`} danger confirmLabel="Remove domain" typeToConfirm={domain.name} onCancel={onClose} onConfirm={async () => { await del(`/tenants/${tenantId}/domains/${domain.id}`, { confirmName: domain.name }); onDone(); }}>
      {impact.loading && <Spinner />}
      {i && (
        <>
          <ul>{i.consequences.map((c) => <li key={c}>{c}</li>)}</ul>
          {!i.canRemove && <Alert kind="error" title="This domain still has content">Delete {i.mailboxes.length} mailbox(es) and {i.aliases.length} alias(es) first: {[...i.mailboxes.map((m) => m.address), ...i.aliases].join(', ')}</Alert>}
        </>
      )}
    </ConfirmDialog>
  );
}

export default function Domains() {
  return (
    <Routes>
      <Route index element={<List />} />
      <Route path="new" element={<AddDomain />} />
      <Route path=":domainId" element={<Detail />} />
      <Route path="*" element={<Navigate to="/dashboard/domains" replace />} />
    </Routes>
  );
}
