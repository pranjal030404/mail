import { useState, type FormEvent } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, Card, ConfirmDialog, CopyButton, EmptyState, ErrorAlert, PageHeader, Spinner, StatusBadge, TextField } from '../../components/ui';
import { del, get, patch, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { formatDate } from '../../lib/format';
import { useAsync } from '../../lib/useAsync';

interface SessionInfo { id: string; current: boolean; ip: string | null; userAgent: string | null; createdAt: string; lastSeenAt: string }

function Mfa() {
  const { me, refresh } = useAuth();
  const [password, setPassword] = useState('');
  const [setup, setSetup] = useState<{ secret: string; otpauthUri: string } | null>(null);
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState<string[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [disabling, setDisabling] = useState(false);
  const isAdmin = me?.user.platformRole !== 'none';
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Two-factor authentication">
      {me?.mfaSetupRequired && <Alert kind="warning" title="Required for administrators">Enable two-factor authentication to use the admin area.</Alert>}
      <ErrorAlert error={error} />
      {codes && (
        <Alert kind="success" title="Save your recovery codes">
          Each works once if you lose your authenticator. They will not be shown again.
          <div className="dns-value mono" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>{codes.map((c) => <span key={c}>{c}</span>)}</div>
          <CopyButton value={codes.join('\n')} label="Copy all" />
        </Alert>
      )}
      {me?.user.mfaEnabled ? (
        <>
          <p><StatusBadge status="active" label="enabled" /> Your account requires a code from your authenticator app at sign-in.</p>
          {!isAdmin && <Button variant="danger" onClick={() => setDisabling(true)}>Disable…</Button>}
          <DisableDialog open={disabling} onClose={() => setDisabling(false)} onDone={async () => { setDisabling(false); await refresh(); }} />
        </>
      ) : !setup ? (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => setSetup(await post('/auth/mfa/setup', { password }))); }}>
          <TextField label="Confirm your password to begin" type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
          <Button type="submit" variant="primary" busy={busy}>Set up authenticator</Button>
        </form>
      ) : (
        <form onSubmit={(e) => { e.preventDefault(); void run(async () => { const r = await post<{ recoveryCodes: string[] }>('/auth/mfa/confirm', { code }); setCodes(r.recoveryCodes); setSetup(null); setPassword(''); await refresh(); }); }}>
          <p>Add this key to an authenticator app (Aegis, 2FAS, Google Authenticator, …), then enter the 6-digit code.</p>
          <div className="dns-value mono">{setup.secret}<CopyButton value={setup.secret} /></div>
          <p className="muted"><small>Or open this link on your phone: <a href={setup.otpauthUri}>otpauth link</a></small></p>
          <TextField label="6-digit code" inputMode="numeric" autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
          <Button type="submit" variant="primary" busy={busy}>Verify and enable</Button>
        </form>
      )}
    </Card>
  );
}

function DisableDialog({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: () => Promise<void> }) {
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  return (
    <ConfirmDialog open={open} title="Disable two-factor authentication" danger confirmLabel="Disable" onCancel={onClose} onConfirm={async () => { await post('/auth/mfa/disable', { password, code }); setPassword(''); setCode(''); await onDone(); }}>
      <TextField label="Password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      <TextField label="Current 6-digit code" inputMode="numeric" value={code} onChange={(e) => setCode(e.target.value)} />
    </ConfirmDialog>
  );
}

function Password() {
  const [f, setF] = useState({ currentPassword: '', newPassword: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      await post('/auth/change-password', f);
      setDone(true);
      setF({ currentPassword: '', newPassword: '' });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card title="Change password">
      <form onSubmit={submit}>
        <TextField label="Current password" type="password" autoComplete="current-password" required value={f.currentPassword} onChange={(e) => setF({ ...f, currentPassword: e.target.value })} />
        <TextField label="New password" type="password" autoComplete="new-password" minLength={12} required value={f.newPassword} onChange={(e) => setF({ ...f, newPassword: e.target.value })} hint="At least 12 characters. All your other sessions are signed out." />
        <ErrorAlert error={error} />
        {done && <Alert kind="success">Password changed. Other sessions were signed out.</Alert>}
        <Button type="submit" variant="primary" busy={busy}>Change password</Button>
      </form>
    </Card>
  );
}

function Sessions() {
  const q = useAsync(() => get<{ sessions: SessionInfo[] }>('/auth/sessions'), []);
  const [error, setError] = useState<unknown>(null);
  return (
    <Card title="Active sessions" actions={<Button small onClick={async () => { try { await post('/auth/sessions/revoke-others'); await q.reload(); } catch (e) { setError(e); } }}>Sign out everywhere else</Button>}>
      {q.loading && <Spinner />}
      <ErrorAlert error={error ?? q.error} onRetry={q.reload} />
      {q.data && <div className="table-wrap"><table>
        <thead><tr><th>Device</th><th>IP</th><th>Signed in</th><th>Last active</th><th /></tr></thead>
        <tbody>{q.data.sessions.map((s) => (
          <tr key={s.id}><td>{(s.userAgent ?? 'Unknown').slice(0, 60)}{s.current && <> <StatusBadge status="active" label="this device" /></>}</td><td>{s.ip}</td><td>{formatDate(s.createdAt)}</td><td>{formatDate(s.lastSeenAt)}</td>
            <td>{!s.current && <Button small onClick={async () => { try { await del(`/auth/sessions/${s.id}`); await q.reload(); } catch (e) { setError(e); } }}>Revoke</Button>}</td></tr>
        ))}</tbody>
      </table></div>}
    </Card>
  );
}

export function Security() {
  const loc = useLocation();
  return (
    <>
      <PageHeader title="Security" subtitle="Protect your account." />
      {(loc.state as { reason?: string } | null)?.reason === 'admin-mfa' && <Alert kind="warning" title="Two-factor authentication is required for the admin area" />}
      <Mfa />
      <Password />
      <Sessions />
    </>
  );
}

export function Notifications() {
  const q = useAsync(() => get<{ notifications: { id: string; type: string; severity: string; title: string; body: string; link: string | null; read: boolean; createdAt: string }[] }>('/notifications'), []);
  const prefs = useAsync(() => get<{ quotaWarnings: boolean; dnsAlerts: boolean; productUpdates: boolean; maintenance: boolean; note: string }>('/notification-preferences'), []);
  const nav = useNavigate();
  const toggle = async (k: 'quotaWarnings' | 'dnsAlerts' | 'productUpdates' | 'maintenance', v: boolean) => {
    await patch('/notification-preferences', { [k]: v });
    await prefs.reload();
  };
  return (
    <>
      <PageHeader title="Notifications" actions={<Button onClick={async () => { await post('/notifications/read-all'); await q.reload(); }}>Mark all read</Button>} />
      <Card title="Email preferences">
        {prefs.data && (
          <>
            {([['quotaWarnings', 'Quota warnings'], ['dnsAlerts', 'DNS problems'], ['maintenance', 'Planned maintenance'], ['productUpdates', 'Product updates']] as const).map(([k, label]) => (
              <label key={k} className="check"><input type="checkbox" checked={prefs.data![k]} onChange={(e) => void toggle(k, e.target.checked)} /><span>{label}</span></label>
            ))}
            <p className="muted"><small>{prefs.data.note}</small></p>
          </>
        )}
      </Card>
      {q.loading && <Spinner />}
      <ErrorAlert error={q.error} onRetry={q.reload} />
      {q.data && (q.data.notifications.length === 0 ? <Card><EmptyState title="Nothing yet" /></Card> : q.data.notifications.map((n) => (
        <Alert key={n.id} kind={n.severity === 'critical' ? 'error' : n.severity === 'warning' ? 'warning' : 'info'} title={n.title}>
          {n.body} <small className="muted">{formatDate(n.createdAt)}</small>
          {n.link && <div><Button small onClick={() => nav(n.link!)}>Open</Button></div>}
        </Alert>
      )))}
    </>
  );
}

export function Profile() {
  const { me, refresh } = useAuth();
  const [name, setName] = useState(me?.user.displayName ?? '');
  const [tz, setTz] = useState(me?.user.timezone ?? 'UTC');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <>
      <PageHeader title="Profile" />
      <Card>
        <form onSubmit={async (e) => { e.preventDefault(); setError(null); try { await patch('/me', { displayName: name, timezone: tz }); await refresh(); setSaved(true); } catch (err) { setError(err); } }}>
          <TextField label="Login email" value={me?.user.email ?? ''} disabled readOnly hint="Your login email cannot be changed here. Contact support." />
          <TextField label="Display name" required value={name} onChange={(e) => { setName(e.target.value); setSaved(false); }} />
          <TextField label="Time zone" value={tz} onChange={(e) => { setTz(e.target.value); setSaved(false); }} hint="For example Asia/Kolkata" />
          <ErrorAlert error={error} />
          {saved && <Alert kind="success">Saved.</Alert>}
          <Button type="submit" variant="primary">Save</Button>
        </form>
      </Card>
    </>
  );
}
