import { Eye, KeyRound, Lock, ShieldCheck, ShieldX, X } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, Card, EmptyState, ErrorAlert, PageHeader, Spinner, StatusBadge, TextArea, TextField } from '../../components/ui';
import { get, post } from '../../lib/api';
import { formatDate } from '../../lib/format';
import type { AccessGrant, WebmailFolder, WebmailMessageSummary, WebmailMessage } from '../../lib/types';
import { useAsync } from '../../lib/useAsync';

interface MailboxOption {
  id: string;
  address: string;
  tenant_id: string;
  tenant_name: string;
  status: string;
}

const addressText = (list: { name: string | null; email: string }[]) => list.map((a) => (a.name ? `${a.name} <${a.email}>` : a.email)).join(', ');

function GrantViewer({ grant, onClose }: { grant: AccessGrant; onClose: () => void }) {
  const [folderId, setFolderId] = useState('');
  const [messageId, setMessageId] = useState('');
  const base = `/admin/access-grants/${grant.id}`;
  const folders = useAsync(() => get<{ folders: WebmailFolder[] }>(`${base}/folders`), [grant.id]);
  const activeFolder = folders.data?.folders.find((f) => f.id === folderId) ?? folders.data?.folders.find((f) => f.role === 'inbox') ?? null;
  const list = useAsync(
    () => (activeFolder ? get<{ messages: WebmailMessageSummary[]; total: number }>(`${base}/messages?folderId=${encodeURIComponent(activeFolder.id)}&pageSize=25`) : Promise.resolve({ messages: [], total: 0 })),
    [grant.id, activeFolder?.id],
  );
  const message = useAsync(() => (messageId ? get<WebmailMessage>(`${base}/messages/${encodeURIComponent(messageId)}`) : Promise.resolve(null)), [grant.id, messageId]);

  return (
    <Card title={`Reading ${grant.mailboxAddress} (grant expires ${formatDate(grant.expiresAt)})`} actions={<Button small onClick={onClose}><X size={14} /> Close viewer</Button>}>
      <Alert kind="warning" title="Every read is audited">
        Grant {grant.id.slice(-8)} · reason: {grant.reason}. Attachment and list reads are recorded with your operator identity. Do not copy content beyond the stated support purpose.
      </Alert>
      <div className="wm-access">
        <nav className="wm-folders" aria-label="Mailbox folders">
          {folders.loading && <Spinner label="Folders" />}
          <ErrorAlert error={folders.error} onRetry={folders.reload} />
          {folders.data?.folders.map((f) => (
            <button key={f.id} className={`wm-folder${activeFolder?.id === f.id ? ' active' : ''}`} onClick={() => { setFolderId(f.id); setMessageId(''); }}>
              <span>{f.name}</span><span className="wm-count muted-count">{f.totalMessages}</span>
            </button>
          ))}
        </nav>
        <section className="wm-list">
          {list.loading && !list.data && <Spinner label="Messages" />}
          <ErrorAlert error={list.error} onRetry={list.reload} />
          {list.data && list.data.messages.length === 0 && <p className="muted">No messages in this folder.</p>}
          <ul className="wm-items">
            {list.data?.messages.map((m) => (
              <li key={m.id}>
                <button className={`wm-item${messageId === m.id ? ' selected' : ''}`} onClick={() => setMessageId(m.id)}>
                  <span className="wm-item-top"><span className="wm-from">{m.from[0]?.email}</span><span className="wm-date">{formatDate(m.receivedAt)}</span></span>
                  <span className="wm-subject">{m.subject}</span>
                  <span className="wm-preview">{m.preview}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section className="wm-reader">
          {!messageId && <EmptyState title="Select a message">Content is fetched only when you open a message, and each fetch is logged.</EmptyState>}
          {message.loading && <Spinner label="Opening message" />}
          <ErrorAlert error={message.error} onRetry={message.reload} />
          {message.data && (
            <article>
              <h2>{message.data.subject}</h2>
              <dl className="wm-headers">
                <dt>From</dt><dd>{addressText(message.data.from)}</dd>
                <dt>To</dt><dd>{addressText(message.data.to)}</dd>
                <dt>Date</dt><dd>{formatDate(message.data.receivedAt)}</dd>
              </dl>
              {message.data.html ? (
                <iframe title="Message content" sandbox="allow-popups" srcDoc={message.data.html} className="wm-frame" />
              ) : <pre className="wm-text">{message.data.text}</pre>}
            </article>
          )}
        </section>
      </div>
    </Card>
  );
}

export default function Access() {
  const grants = useAsync(() => get<{ grants: AccessGrant[] }>('/admin/access-grants'), []);
  const [query, setQuery] = useState('');
  const [applied, setApplied] = useState('');
  const mailboxes = useAsync(() => get<{ mailboxes: MailboxOption[] }>(`/admin/mailboxes${applied ? `?q=${encodeURIComponent(applied)}` : ''}`), [applied]);
  const [mailboxId, setMailboxId] = useState('');
  const [reason, setReason] = useState('');
  const [ticket, setTicket] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [viewer, setViewer] = useState<AccessGrant | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const act = async (id: string, path: string, body: unknown, message: string) => {
    setBusy(id);
    setError(null);
    setNotice(null);
    try {
      await post(`/admin/access-grants/${id}/${path}`, body);
      setNotice(message);
      await grants.reload();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <PageHeader title="Exceptional mailbox access" subtitle="Temporary, reason-bound read access. Ordinary administrator privileges never include message content." />
      {notice && <Alert kind="success" onClose={() => setNotice(null)}>{notice}</Alert>}
      <ErrorAlert error={error} />

      <Card title="Request access">
        <p className="muted"><small>Access must be approved by a different super administrator. Grants expire within four hours (one hour by default). Only read scope is available; message changes and exports are not part of this workflow.</small></p>
        <form
          className="row"
          role="search"
          onSubmit={(e) => {
            e.preventDefault();
            setApplied(query);
          }}
          style={{ marginBottom: '.75rem' }}
        >
          <input aria-label="Find a mailbox" placeholder="Find a mailbox by address…" value={query} onChange={(e) => setQuery(e.target.value)} style={{ maxWidth: 320 }} />
          <Button type="submit" small>Search</Button>
        </form>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError(null);
            setNotice(null);
            try {
              await post('/admin/access-grants', { mailboxId, reason, scope: 'read', ...(ticket ? { supportTicketId: ticket } : {}) });
              setNotice('Request submitted. A second super administrator must approve it before any content can be read.');
              setReason('');
              setTicket('');
              await grants.reload();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <label className="field">
            <span>Target mailbox</span>
            <select aria-label="Target mailbox" required value={mailboxId} onChange={(e) => setMailboxId(e.target.value)}>
              <option value="">Select a mailbox…</option>
              {(mailboxes.data?.mailboxes ?? []).map((m) => <option key={m.id} value={m.id}>{m.address} — {m.tenant_name} ({m.status})</option>)}
            </select>
          </label>
          {mailboxes.error !== null && <ErrorAlert error={mailboxes.error} />}
          <TextArea label="Reason (required, recorded in the audit log)" required minLength={10} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} hint="Describe the support case and why the customer cannot provide the information themselves." />
          <TextField label="Related support ticket ID (optional)" value={ticket} onChange={(e) => setTicket(e.target.value)} hint="Must belong to the mailbox's workspace." />
          <Button type="submit" variant="primary" disabled={!mailboxId || reason.trim().length < 10}><KeyRound size={15} /> Request access</Button>
        </form>
      </Card>

      <Card title="Grants" actions={<Button small onClick={() => void grants.reload()}>Refresh</Button>}>
        {grants.loading && !grants.data && <Spinner label="Access grants" />}
        <ErrorAlert error={grants.error} onRetry={grants.reload} />
        {grants.data && grants.data.grants.length === 0 && <EmptyState title="No access grants">None have been requested. Content access is impossible without one.</EmptyState>}
        {grants.data && grants.data.grants.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead><tr><th>Mailbox</th><th>Operator</th><th>Reason</th><th>Status</th><th>Expires</th><th>Uses</th><th>Actions</th></tr></thead>
              <tbody>
                {grants.data.grants.map((g) => (
                  <tr key={g.id}>
                    <td>{g.mailboxAddress}<div className="muted"><small>{g.tenantName}</small></div></td>
                    <td>{g.requestedBy}<div className="muted"><small>approved by {g.approvedBy ?? '—'}</small></div></td>
                    <td style={{ maxWidth: 280 }}>{g.reason}{g.supportTicketId && <div className="muted"><small>ticket …{g.supportTicketId.slice(-6)}</small></div>}</td>
                    <td><StatusBadge status={g.status} /></td>
                    <td>{g.expiresAt ? formatDate(g.expiresAt) : '—'}</td>
                    <td>{g.useCount}</td>
                    <td>
                      <div className="row">
                        {g.status === 'pending_approval' && (
                          <>
                            <span title="A different super administrator must approve"><Button small variant="primary" busy={busy === g.id} onClick={() => act(g.id, 'approve', {}, 'Grant approved. It is now active for the requesting operator.')}><ShieldCheck size={14} /> Approve</Button></span>
                            <Button small variant="danger" busy={busy === g.id} onClick={() => act(g.id, 'deny', { reason: 'Denied by reviewer' }, 'Request denied.')}><ShieldX size={14} /> Deny</Button>
                          </>
                        )}
                        {g.status === 'active' && (
                          <>
                            <Button small variant="primary" onClick={() => setViewer(g)}><Eye size={14} /> Read</Button>
                            <Button small variant="danger" busy={busy === g.id} onClick={() => act(g.id, 'revoke', { reason: 'Revoked from admin console' }, 'Grant revoked.')}><Lock size={14} /> Revoke</Button>
                          </>
                        )}
                        {g.status === 'expired' && <span className="muted"><small>Request a new grant to read again.</small></span>}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {viewer && <GrantViewer grant={viewer} onClose={() => setViewer(null)} />}
    </>
  );
}
