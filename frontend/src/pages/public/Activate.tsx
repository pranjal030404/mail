import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Alert, Button, ErrorAlert, PasswordField, Spinner } from '../../components/ui';
import { ApiError, fieldErrors, post } from '../../lib/api';

/** Account activation from an emailed invitation. The token travels in the URL fragment, never in a request URL. */
export default function Activate() {
  const nav = useNavigate();
  const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('token') ?? '';
  const [info, setInfo] = useState<{ email: string; displayName: string; workspaceName: string | null; mailboxAddress: string | null } | null>(null);
  const [invalid, setInvalid] = useState(!token);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [terms, setTerms] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!token) return;
    post<typeof info>('/auth/invitation-info', { token }).then(setInfo).catch((e) => { if (e instanceof ApiError && e.status === 400) setInvalid(true); else setError(e); });
  }, [token]);

  if (invalid) return <div className="page narrow"><h1>Invitation not valid</h1><Alert kind="error" title="This link is invalid, expired or already used">Ask your administrator to send a new invitation. If you already activated your account, <Link to="/login">sign in</Link>.</Alert></div>;
  if (done) return <div className="page narrow"><h1>Account activated</h1><Alert kind="success">Your password is set. You can sign in now.</Alert><Link className="btn btn-primary" to="/login">Sign in</Link></div>;
  if (!info) return <div className="page narrow">{error ? <ErrorAlert error={error} /> : <Spinner label="Checking your invitation" />}</div>;

  const mismatch = confirm.length > 0 && confirm !== password;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mismatch) return;
    setBusy(true); setError(null);
    try {
      await post('/auth/activate', { token, email: info.email, password, acceptTerms: terms });
      history.replaceState(null, '', '/activate'); // drop the spent token from the address bar
      setDone(true);
      setTimeout(() => nav('/login'), 4000);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_invitation') setInvalid(true); else setError(err);
    } finally { setBusy(false); }
  };
  const fe = fieldErrors(error);
  return (
    <div className="page narrow">
      <h1>Activate your account</h1>
      <p>Welcome, <strong>{info.displayName}</strong>. Choose a password for <strong>{info.email}</strong>.</p>
      {(info.workspaceName || info.mailboxAddress) && <p className="muted">{info.workspaceName && <>Workspace: {info.workspaceName}. </>}{info.mailboxAddress && <>Mailbox: {info.mailboxAddress}.</>}</p>}
      <form onSubmit={submit}>
        <input type="email" value={info.email} readOnly autoComplete="username" hidden aria-hidden />
        <PasswordField label="New password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" required minLength={12} hint="At least 12 characters." error={fe.password} />
        <PasswordField label="Confirm password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required error={mismatch ? 'Passwords do not match.' : undefined} />
        <label className="check"><input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} /> I accept the <Link to="/terms" target="_blank">terms</Link> and <Link to="/privacy" target="_blank">privacy notice</Link>.</label>
        <ErrorAlert error={error} />
        <Button type="submit" variant="primary" busy={busy} disabled={!password || mismatch || !terms}>Activate account</Button>
      </form>
    </div>
  );
}
