import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, ConfirmDialog, EmptyState, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, post } from '../../lib/api';
import type { Alias, DomainSummary, Mailbox } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { useTenant } from './shared';

export default function Aliases() {
  const { tenantId, suspended } = useTenant();
  const aliases = useAsync(() => get<{ aliases: Alias[] }>(`/tenants/${tenantId}/aliases`), [tenantId]);
  const domains = useAsync(() => get<{ domains: DomainSummary[] }>(`/tenants/${tenantId}/domains`), [tenantId]);
  const mailboxes = useAsync(() => get<{ mailboxes: Mailbox[] }>(`/tenants/${tenantId}/mailboxes?pageSize=100`), [tenantId]);
  const [f, setF] = useState({ domainId: '', localPart: '', kind: 'mailbox', mailboxId: '', external: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [removing, setRemoving] = useState<Alias | null>(null);
  const verified = domains.data?.domains.filter((d) => d.ownershipStatus === 'verified') ?? [];
  const active = mailboxes.data?.mailboxes.filter((m) => m.status === 'active' || m.status === 'suspended' || m.status === 'provisioning') ?? [];
  const domainId = f.domainId || verified[0]?.id || '';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await post<Alias>(`/tenants/${tenantId}/domains/${domainId}/aliases`, { localPart: f.localPart, ...(f.kind === 'mailbox' ? { destinationMailboxId: f.mailboxId || active[0]?.id } : { externalAddress: f.external }) });
      setNotice(r.awaitingConfirmation ? `We emailed ${r.destination}. Forwarding starts only after the owner of that address confirms.` : 'Alias created.');
      setF({ ...f, localPart: '', external: '' });
      await aliases.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Aliases and forwarding" subtitle="An alias delivers mail for one address to a mailbox, or to an outside address that has confirmed." />
      <Card title="Create alias">
        {verified.length === 0 ? <Alert kind="info">Verify a domain first.</Alert> : (
          <form onSubmit={submit}>
            <div className="row" style={{ alignItems: 'flex-end' }}>
              <TextField label="Alias" required value={f.localPart} onChange={(e) => setF({ ...f, localPart: e.target.value })} />
              <SelectField label="Domain" value={domainId} onChange={(e) => setF({ ...f, domainId: e.target.value })}>{verified.map((d) => <option key={d.id} value={d.id}>@{d.name}</option>)}</SelectField>
              <SelectField label="Deliver to" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="mailbox">A mailbox in this workspace</option><option value="external">An outside address</option></SelectField>
              {f.kind === 'mailbox' ? <SelectField label="Mailbox" value={f.mailboxId || active[0]?.id || ''} onChange={(e) => setF({ ...f, mailboxId: e.target.value })}>{active.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</SelectField> : <TextField label="Outside address" type="email" required value={f.external} onChange={(e) => setF({ ...f, external: e.target.value })} />}
            </div>
            <ErrorAlert error={error} />
            {notice && <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>}
            <Button type="submit" variant="primary" busy={busy} disabled={suspended}>Create alias</Button>
          </form>
        )}
      </Card>
      {aliases.loading && <Spinner />}
      <ErrorAlert error={aliases.error} onRetry={aliases.reload} />
      {aliases.data && (aliases.data.aliases.length === 0 ? <Card><EmptyState title="No aliases yet" /></Card> : (
        <Card><div className="table-wrap"><table>
          <thead><tr><th>Alias</th><th>Delivers to</th><th>Status</th><th /></tr></thead>
          <tbody>{aliases.data.aliases.map((a) => (
            <tr key={a.id}><td>{a.source}</td><td>{a.destination}{a.destinationType === 'external' && <small className="muted"> (outside)</small>}</td><td><StatusBadge status={a.status} /></td><td><Button small variant="danger" onClick={() => setRemoving(a)}>Remove</Button></td></tr>
          ))}</tbody>
        </table></div></Card>
      ))}
      <ConfirmDialog open={!!removing} title="Remove alias" danger confirmLabel="Remove" onCancel={() => setRemoving(null)} onConfirm={async () => { await del(`/tenants/${tenantId}/aliases/${removing!.id}`); setRemoving(null); await aliases.reload(); }}>
        <p>Mail sent to <strong>{removing?.source}</strong> will no longer be delivered.</p>
      </ConfirmDialog>
    </>
  );
}
