import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { Alert, Button, ErrorAlert, PasswordField, Spinner, TextField } from '../../components/ui';
import { ApiError, fieldErrors, post } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const hashParam = (key: string) => new URLSearchParams(window.location.hash.replace(/^#/, '')).get(key) ?? '';

function Shell({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page narrow">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

function Login() {
  const { login, me } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (me && !me.mfaPending) return <Navigate to={me.user.platformRole !== 'none' ? '/admin' : '/dashboard'} replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email, password);
      nav(r.mfaRequired ? '/login/mfa' : ((loc.state as { from?: string } | null)?.from ?? '/dashboard'), { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Sign in">
      <form onSubmit={submit}>
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorAlert error={error} />
        {error instanceof ApiError && error.code === 'email_not_verified' && <ResendVerification email={email} />}
        <Button type="submit" variant="primary" busy={busy}>Sign in</Button>
      </form>
      <p><Link to="/forgot-password">Forgot your password?</Link></p>
      <p className="muted">New here? <Link to="/register">Create a free account</Link></p>
    </Shell>
  );
}

function ResendVerification({ email }: { email: string }) {
  const [sent, setSent] = useState(false);
  return sent ? <Alert kind="success">If the account needs verification, a new email is on its way.</Alert> : <p><Button small onClick={async () => { await post('/auth/resend-verification', { email }).catch(() => undefined); setSent(true); }}>Resend verification email</Button></p>;
}

function Mfa() {
  const { refresh, me } = useAuth();
  const nav = useNavigate();
  const [code, setCode] = useState('');
  const [recovery, setRecovery] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (!me) return <Navigate to="/login" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/mfa/verify', recovery ? { recoveryCode: code } : { code });
      const m = await refresh();
      nav(m && m.user.platformRole !== 'none' ? '/admin' : '/dashboard', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Shell title="Two-factor authentication">
      <form onSubmit={submit}>
        <TextField label={recovery ? 'Recovery code' : '6-digit code from your authenticator app'} inputMode={recovery ? 'text' : 'numeric'} autoComplete="one-time-code" required value={code} onChange={(e) => setCode(e.target.value)} />
        <ErrorAlert error={error} />
        <div className="row"><Button type="submit" variant="primary" busy={busy}>Verify</Button><Button type="button" variant="ghost" onClick={() => { setRecovery(!recovery); setCode(''); }}>{recovery ? 'Use authenticator code' : 'Use a recovery code'}</Button></div>
      </form>
    </Shell>
  );
}

function Register() {
  const nav = useNavigate();
  const [f, setF] = useState({ email: '', password: '', displayName: '', inviteToken: hashParam('invite'), acceptTerms: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [done, setDone] = useState(false);
  const fe = fieldErrors(error);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await post('/auth/register', { email: f.email, password: f.password, displayName: f.displayName, acceptTerms: f.acceptTerms, ...(f.inviteToken ? { inviteToken: f.inviteToken } : {}) });
      setDone(true);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  if (done) return <Shell title="Check your email"><Alert kind="success">If the address can be registered, we sent a verification link. It is valid for 24 hours.</Alert><Button onClick={() => nav('/login')}>Go to sign in</Button></Shell>;
  return (
    <Shell title="Create your account">
      <form onSubmit={submit}>
        <TextField label="Your name" required autoComplete="name" value={f.displayName} onChange={(e) => setF({ ...f, displayName: e.target.value })} error={fe.displayName} />
        <TextField label="Email" type="email" required autoComplete="username" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} error={fe.email} hint="If you were invited, use the address the invitation was sent to." />
        <PasswordField label="Password" required autoComplete="new-password" minLength={12} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} error={fe.password} hint="At least 12 characters." />
        {!hashParam('invite') && <TextField label="Invitation code (optional)" value={f.inviteToken} onChange={(e) => setF({ ...f, inviteToken: e.target.value })} hint="Only needed if the administrator has made registration invite-only." />}
        <label className="check"><input type="checkbox" checked={f.acceptTerms} onChange={(e) => setF({ ...f, acceptTerms: e.target.checked })} required /><span>I accept the <Link to="/terms" target="_blank">terms</Link>, <Link to="/privacy" target="_blank">privacy notice</Link> and <Link to="/acceptable-use" target="_blank">acceptable use policy</Link>.</span></label>
        <ErrorAlert error={error} />
        <Button type="submit" variant="primary" busy={busy}>Register</Button>
      </form>
    </Shell>
  );
}

/** Pages that consume a one-time token from the URL fragment (never sent to servers in the URL). */
function TokenAction({ title, endpoint, success }: { title: string; endpoint: string; success: string }) {
  const [state, setState] = useState<'busy' | 'ok' | 'error'>('busy');
  const [error, setError] = useState<unknown>(null);
  // Read the token once, and guard so StrictMode's double effect cannot consume the one-time token twice.
  const [token] = useState(() => hashParam('token'));
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    history.replaceState(null, '', window.location.pathname);
    if (!token) {
      setError(new ApiError(400, 'invalid_token', 'This link is missing its token.'));
      setState('error');
      return;
    }
    post(endpoint, { token })
      .then(() => setState('ok'))
      .catch((e) => (setError(e), setState('error')));
  }, [endpoint, token]);
  return (
    <Shell title={title}>
      {state === 'busy' && <Spinner />}
      {state === 'ok' && <Alert kind="success">{success} <Link to="/login">Sign in</Link></Alert>}
      {state === 'error' && <ErrorAlert error={error} />}
    </Shell>
  );
}

function Forgot() {
  const [email, setEmail] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  return (
    <Shell title="Reset your password">
      {done ? <Alert kind="success">If an account exists for that address, a reset link is on its way (valid for 30 minutes).</Alert> : (
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); try { await post('/auth/forgot-password', { email }); setDone(true); } catch (err) { setError(err); } finally { setBusy(false); } }}>
          <TextField label="Email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" busy={busy}>Send reset link</Button>
        </form>
      )}
    </Shell>
  );
}

function Reset() {
  const [password, setPassword] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const token = hashParam('token');
  return (
    <Shell title="Choose a new password">
      {done ? <Alert kind="success">Password changed and all sessions signed out. <Link to="/login">Sign in</Link></Alert> : (
        <form onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await post('/auth/reset-password', { token, password }); setDone(true); } catch (err) { setError(err); } finally { setBusy(false); } }}>
          <TextField label="New password" type="password" autoComplete="new-password" minLength={12} required value={password} onChange={(e) => setPassword(e.target.value)} hint="At least 12 characters." />
          <ErrorAlert error={error} />
          <Button type="submit" variant="primary" busy={busy} disabled={!token}>Change password</Button>
          {!token && <Alert kind="error">This link is missing its token.</Alert>}
        </form>
      )}
    </Shell>
  );
}

function AcceptInvitation() {
  const { me, loading } = useAuth();
  const token = hashParam('token');
  const [state, setState] = useState<'idle' | 'busy' | 'ok'>('idle');
  const [error, setError] = useState<unknown>(null);
  const { refresh } = useAuth();
  if (loading) return <Shell title="Workspace invitation"><Spinner /></Shell>;
  if (!me) return <Shell title="Workspace invitation"><p>Sign in or register with the invited email address, then return to this link.</p><div className="row"><Link className="btn btn-primary" to="/login" state={{ from: `/accept-invitation${window.location.hash}` }}>Sign in</Link></div></Shell>;
  return (
    <Shell title="Workspace invitation">
      {state === 'ok' ? <Alert kind="success">You have joined the workspace. <Link to="/dashboard">Open dashboard</Link></Alert> : (
        <>
          <p>Signed in as <strong>{me.user.email}</strong>. The invitation must have been sent to this address.</p>
          <ErrorAlert error={error} />
          <Button variant="primary" busy={state === 'busy'} disabled={!token} onClick={async () => { setState('busy'); setError(null); try { await post('/invitations/accept', { token }); await refresh(); setState('ok'); } catch (e) { setError(e); setState('idle'); } }}>Accept invitation</Button>
        </>
      )}
    </Shell>
  );
}

export default function Auth() {
  const { pathname } = useLocation();
  const p = pathname.replace(/\/$/, '');
  if (p === '/login/mfa') return <Mfa />;
  if (p === '/login') return <Login />;
  if (p === '/register') return <Register />;
  if (p === '/verify-email') return <TokenAction title="Verify your email" endpoint="/auth/verify-email" success="Email verified." />;
  if (p === '/confirm-forwarding') return <TokenAction title="Confirm forwarding" endpoint="/forwarding/confirm" success="Forwarding confirmed. Mail to the alias will now be forwarded to your address." />;
  if (p === '/forgot-password') return <Forgot />;
  if (p === '/reset-password') return <Reset />;
  if (p === '/accept-invitation') return <AcceptInvitation />;
  return <Navigate to="/login" replace />;
}
