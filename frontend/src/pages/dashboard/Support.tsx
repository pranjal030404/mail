import { useState, type FormEvent } from 'react';
import { Link, Route, Routes, useParams } from 'react-router-dom';
import { Alert, Button, Card, EmptyState, ErrorAlert, PageHeader, SelectField, Spinner, StatusBadge, TextArea, TextField } from '../../components/ui';
import { get, post } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { Mailbox } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';
import { ClientSettingsCard } from './Mailboxes';
import { useTenant } from './shared';

interface Ticket { id: string; category: string; urgency: string; subject: string; status: string; updatedAt: string }

function List() {
  const { tenantId } = useTenant();
  const q = useAsync(() => get<{ tickets: Ticket[] }>(`/tenants/${tenantId}/support-tickets`), [tenantId]);
  const [f, setF] = useState({ category: 'other', urgency: 'normal', subject: '', message: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [sent, setSent] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post(`/tenants/${tenantId}/support-tickets`, f);
      setF({ ...f, subject: '', message: '' });
      setSent(true);
      await q.reload();
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <PageHeader title="Support" subtitle="Describe the problem. Never include passwords or full message contents." />
      <Card title="New request">
        <form onSubmit={submit}>
          <div className="row">
            <SelectField label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['dns', 'mailbox', 'delivery', 'client_setup', 'account', 'billing', 'abuse', 'other'].map((c) => <option key={c} value={c}>{c.replace('_', ' ')}</option>)}</SelectField>
            <SelectField label="Urgency" value={f.urgency} onChange={(e) => setF({ ...f, urgency: e.target.value })}>{['low', 'normal', 'high', 'urgent'].map((c) => <option key={c}>{c}</option>)}</SelectField>
          </div>
          <TextField label="Subject" required minLength={3} maxLength={200} value={f.subject} onChange={(e) => { setF({ ...f, subject: e.target.value }); setSent(false); }} />
          <TextArea label="Details" required minLength={10} maxLength={5000} value={f.message} onChange={(e) => setF({ ...f, message: e.target.value })} hint="Include the domain or mailbox address, what you expected, and what happened." />
          <ErrorAlert error={error} />
          {sent && <Alert kind="success">Request sent. We will reply here.</Alert>}
          <Button type="submit" variant="primary" busy={busy}>Send request</Button>
        </form>
      </Card>
      {q.loading && <Spinner />}
      {q.data && (q.data.tickets.length === 0 ? <Card><EmptyState title="No requests yet" /></Card> : (
        <Card title="Your requests"><div className="table-wrap"><table>
          <thead><tr><th>Subject</th><th>Status</th><th>Updated</th></tr></thead>
          <tbody>{q.data.tickets.map((t) => <tr key={t.id}><td><Link to={`/dashboard/support/${t.id}`}>{t.subject}</Link></td><td><StatusBadge status={t.status} /></td><td>{formatDate(t.updatedAt)}</td></tr>)}</tbody>
        </table></div></Card>
      ))}
    </>
  );
}

function Thread() {
  const { ticketId } = useParams();
  const { tenantId } = useTenant();
  const q = useAsync(() => get<Ticket & { messages: { fromStaff: boolean; body: string; createdAt: string }[] }>(`/tenants/${tenantId}/support-tickets/${ticketId}`), [tenantId, ticketId]);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState<unknown>(null);
  if (q.loading && !q.data) return <Spinner />;
  if (!q.data) return <ErrorAlert error={q.error} />;
  return (
    <>
      <PageHeader title={q.data.subject} actions={<StatusBadge status={q.data.status} />} />
      {q.data.messages.map((m, i) => (
        <Card key={i} title={m.fromStaff ? 'ARTHVEX support' : 'You'}><p style={{ whiteSpace: 'pre-wrap' }}>{m.body}</p><small className="muted">{formatDate(m.createdAt)}</small></Card>
      ))}
      <Card>
        <form onSubmit={async (e) => { e.preventDefault(); setError(null); try { await post(`/tenants/${tenantId}/support-tickets/${ticketId}/messages`, { message: msg }); setMsg(''); await q.reload(); } catch (err) { setError(err); } }}>
          <TextArea label="Reply" required value={msg} onChange={(e) => setMsg(e.target.value)} />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary">Send</Button>
        </form>
      </Card>
    </>
  );
}

export function SupportRoutes() {
  return <Routes><Route index element={<List />} /><Route path=":ticketId" element={<Thread />} /></Routes>;
}

export function Clients() {
  const { tenantId } = useTenant();
  const boxes = useAsync(() => get<{ mailboxes: Mailbox[] }>(`/tenants/${tenantId}/mailboxes?status=active&pageSize=100`), [tenantId]);
  const [id, setId] = useState('');
  const mailboxId = id || boxes.data?.mailboxes[0]?.id || '';
  const cs = useAsync(() => (mailboxId ? get<Parameters<typeof ClientSettingsCard>[0]['s']>(`/tenants/${tenantId}/mailboxes/${mailboxId}/client-settings`) : Promise.resolve(null)), [tenantId, mailboxId]);
  return (
    <>
      <PageHeader title="Email client setup" subtitle="Connect an app using standard IMAP and authenticated SMTP." />
      {boxes.data && boxes.data.mailboxes.length === 0 && <Alert kind="info">You have no active mailbox yet.</Alert>}
      {boxes.data && boxes.data.mailboxes.length > 1 && <SelectField label="Mailbox" value={mailboxId} onChange={(e) => setId(e.target.value)}>{boxes.data.mailboxes.map((m) => <option key={m.id} value={m.id}>{m.address}</option>)}</SelectField>}
      {cs.data && <ClientSettingsCard s={cs.data} />}
      <Card title="General steps (any app)">
        <ol>
          <li>Add a new account → choose “manual” or “IMAP” setup (not Gmail/Outlook presets).</li>
          <li>Enter the incoming and outgoing servers and ports above, with SSL/TLS.</li>
          <li>Username is your <strong>full email address</strong>; use the mailbox password from the dashboard.</li>
          <li>Outgoing server requires authentication with the same username and password.</li>
        </ol>
        <p className="muted"><small>These steps are generic: ARTHVEX has not tested every client, so we do not promise compatibility with a specific app version.</small></p>
      </Card>
      <Card title="Troubleshooting">
        <ul>
          <li><strong>Authentication failed:</strong> reset the password on the mailbox page; check the mailbox is not suspended.</li>
          <li><strong>Certificate warning:</strong> the server name must match the host shown. Do not accept mismatching certificates.</li>
          <li><strong>Cannot send:</strong> confirm outgoing authentication is on and the port matches the security type.</li>
          <li><strong>Mail rejected:</strong> the mailbox may be over quota.</li>
        </ul>
      </Card>
    </>
  );
}
