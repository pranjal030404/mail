import { AlertCircle, CheckCircle2, Copy, Check, Eye, EyeOff, Info, Loader2, TriangleAlert, X } from 'lucide-react';
import { Component, useEffect, useId, useRef, useState, type ButtonHTMLAttributes, type ErrorInfo, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from 'react';
import { ApiError, errorText } from '../lib/api';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-live="polite">
      <Loader2 className="spin" size={18} aria-hidden /> <span>{label}…</span>
    </span>
  );
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'secondary' | 'danger' | 'ghost'; busy?: boolean; small?: boolean };
export function Button({ variant = 'secondary', busy, small, children, disabled, className = '', ...rest }: BtnProps) {
  return (
    <button {...rest} disabled={disabled || busy} aria-busy={busy || undefined} className={`btn btn-${variant}${small ? ' btn-sm' : ''} ${className}`}>
      {busy && <Loader2 className="spin" size={14} aria-hidden />}
      {children}
    </button>
  );
}

export function Alert({ kind = 'info', title, children, onClose }: { kind?: 'info' | 'success' | 'warning' | 'error'; title?: string; children?: ReactNode; onClose?: () => void }) {
  const Icon = { info: Info, success: CheckCircle2, warning: TriangleAlert, error: AlertCircle }[kind];
  return (
    <div className={`alert alert-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <Icon size={18} aria-hidden />
      <div className="alert-body">
        {title && <strong>{title}</strong>}
        {children && <div>{children}</div>}
      </div>
      {onClose && (
        <button className="icon-btn" onClick={onClose} aria-label="Dismiss">
          <X size={16} />
        </button>
      )}
    </div>
  );
}

export function ErrorAlert({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  if (!error) return null;
  return (
    <Alert kind="error" title={errorText(error)}>
      {error instanceof ApiError && error.correlationId && <small>Reference: {error.correlationId}</small>}
      {onRetry && (
        <div>
          <Button small onClick={onRetry}>
            Try again
          </Button>
        </div>
      )}
    </Alert>
  );
}

export function Field({ label, error, hint, children }: { label: string; error?: string | undefined; hint?: ReactNode; children: (p: { id: string; 'aria-describedby'?: string; 'aria-invalid'?: boolean }) => ReactNode }) {
  const id = useId();
  const desc = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      {children({ id, ...(desc ? { 'aria-describedby': desc } : {}), ...(error ? { 'aria-invalid': true } : {}) })}
      {hint && !error && (
        <small id={`${id}-hint`} className="muted">
          {hint}
        </small>
      )}
      {error && (
        <small id={`${id}-err`} className="field-error">
          {error}
        </small>
      )}
    </div>
  );
}

export function TextField({ label, error, hint, ...rest }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string | undefined; hint?: ReactNode }) {
  return <Field label={label} error={error} hint={hint}>{(p) => <input {...rest} {...p} />}</Field>;
}
/** Password input with a show/hide toggle. */
export function PasswordField({ label, error, hint, ...rest }: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & { label: string; error?: string | undefined; hint?: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <Field label={label} error={error} hint={hint}>
      {(p) => (
        <div className="pw-wrap">
          <input {...rest} {...p} type={shown ? 'text' : 'password'} />
          <button type="button" className="pw-toggle" onClick={() => setShown(!shown)} aria-label={shown ? 'Hide password' : 'Show password'} aria-pressed={shown}>
            {shown ? <EyeOff size={16} /> : <Eye size={16} />}
          </button>
        </div>
      )}
    </Field>
  );
}
export function TextArea({ label, error, hint, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: string; error?: string | undefined; hint?: ReactNode }) {
  return <Field label={label} error={error} hint={hint}>{(p) => <textarea rows={4} {...rest} {...p} />}</Field>;
}
export function SelectField({ label, error, hint, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement> & { label: string; error?: string | undefined; hint?: ReactNode }) {
  return <Field label={label} error={error} hint={hint}>{(p) => <select {...rest} {...p}>{children}</select>}</Field>;
}

export function Card({ title, actions, children, className = '' }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`card ${className}`}>
      {(title || actions) && (
        <header className="card-head">
          {title && <h2>{title}</h2>}
          {actions && <div className="card-actions">{actions}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

const TONES: Record<string, string> = {
  ok: 'good', pass: 'good', active: 'good', verified: 'good', ready: 'good', succeeded: 'good', resolved: 'good', info: 'neutral',
  warning: 'warn', pending: 'warn', provisioning: 'warn', pending_verification: 'warn', retrying: 'warn', queued: 'warn', suspended: 'warn', deletion_scheduled: 'warn', open: 'warn', investigating: 'warn', unknown: 'neutral',
  error: 'bad', fail: 'bad', failed: 'bad', provisioning_failed: 'bad', needs_manual_review: 'bad', critical: 'bad', expired: 'bad', closed: 'neutral', deleted: 'neutral', removal_scheduled: 'warn',
};
export function StatusBadge({ status, label }: { status: string; label?: string }) {
  return <span className={`badge badge-${TONES[status] ?? 'neutral'}`}>{label ?? status.replace(/_/g, ' ')}</span>;
}

export function CopyButton({ value, label = 'Copy' }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button
      small
      variant="ghost"
      aria-label={`${label} ${value.length > 40 ? 'value' : value}`}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked: user can still select the text */
        }
      }}
    >
      {done ? <Check size={14} /> : <Copy size={14} />} {done ? 'Copied' : label}
    </Button>
  );
}

export function EmptyState({ icon, title, children }: { icon?: ReactNode; title: string; children?: ReactNode }) {
  return (
    <div className="empty">
      {icon}
      <h3>{title}</h3>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

export function ProgressBar({ percent, label }: { percent: number; label: string }) {
  const tone = percent >= 100 ? 'bad' : percent >= 90 ? 'warn' : percent >= 75 ? 'caution' : 'good';
  return (
    <div className="progress" role="progressbar" aria-valuenow={Math.round(percent)} aria-valuemin={0} aria-valuemax={100} aria-label={label}>
      <div className={`progress-fill tone-${tone}`} style={{ width: `${Math.min(100, Math.max(0, percent))}%` }} />
    </div>
  );
}

/** Accessible modal; optional typed confirmation and reason for destructive actions. */
export function ConfirmDialog(props: {
  open: boolean;
  title: string;
  children?: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  /** The user must type this exact text to enable the confirm button. */
  typeToConfirm?: string;
  askReason?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => Promise<void>;
}) {
  const [typed, setTyped] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (props.open && !d.open) {
      setTyped('');
      setReason('');
      setError(null);
      if (typeof d.showModal === 'function') d.showModal();
      else d.setAttribute('open', '');
    } else if (!props.open && d.open) d.close?.();
  }, [props.open]);

  const ready = (!props.typeToConfirm || typed.trim().toLowerCase() === props.typeToConfirm.toLowerCase()) && (!props.askReason || reason.trim().length >= 5);
  return (
    <dialog ref={ref} className="dialog" onCancel={(e) => (e.preventDefault(), props.onCancel())} aria-labelledby="dlg-title">
      {props.open && (
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setBusy(true);
            setError(null);
            try {
              await props.onConfirm(reason.trim());
            } catch (err) {
              setError(err);
            } finally {
              setBusy(false);
            }
          }}
        >
          <h2 id="dlg-title">{props.title}</h2>
          <div className="dialog-body">{props.children}</div>
          {props.typeToConfirm && <TextField label={`Type “${props.typeToConfirm}” to confirm`} value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />}
          {props.askReason && <TextField label="Reason (recorded in the audit log)" value={reason} onChange={(e) => setReason(e.target.value)} hint="At least 5 characters." />}
          <ErrorAlert error={error} />
          <div className="dialog-actions">
            <Button type="button" onClick={props.onCancel}>
              Cancel
            </Button>
            <Button type="submit" variant={props.danger ? 'danger' : 'primary'} busy={busy} disabled={!ready}>
              {props.confirmLabel}
            </Button>
          </div>
        </form>
      )}
    </dialog>
  );
}

export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  override componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('UI error', error.message, info.componentStack);
  }
  override render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="page narrow">
        <Alert kind="error" title="This page hit an unexpected problem">
          Reload the page. If it keeps happening, contact support.
          <div>
            <Button onClick={() => location.reload()}>Reload</Button>
          </div>
        </Alert>
      </div>
    );
  }
}

export function PageHeader({ title, subtitle, actions }: { title: string; subtitle?: ReactNode; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </div>
  );
}

export function DevBanner({ simulated }: { simulated: boolean }) {
  if (!simulated) return null;
  return (
    <div className="dev-banner" role="note">
      DEVELOPMENT MODE — mailboxes are simulated. No real email is sent, received or stored.
    </div>
  );
}
