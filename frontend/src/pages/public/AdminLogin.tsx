import { useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { Button, ErrorAlert, PasswordField, TextField } from '../../components/ui';
import { useAuth } from '../../lib/auth';

/** Sign-in page shown at /admin when there is no session. */
export function AdminLogin() {
  const { login, me } = useAuth();
  const nav = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  if (me?.mfaPending) return <Navigate to="/login/mfa" replace />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await login(email, password);
      if (r.mfaRequired) nav('/login/mfa', { replace: true });
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="page narrow">
      <h1>Administrator sign in</h1>
      <form onSubmit={submit}>
        <TextField label="Email" type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        <PasswordField label="Password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        <ErrorAlert error={error} />
        <Button type="submit" variant="primary" busy={busy}>Sign in</Button>
      </form>
    </div>
  );
}
