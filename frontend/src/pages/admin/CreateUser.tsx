import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, Button, Card, ErrorAlert, PageHeader, SelectField, TextField } from '../../components/ui';
import { fieldErrors, get, post } from '../../lib/api';
import { useAsync } from '../../lib/useAsync';
import { usePermissions, type Row } from './kit';

type WorkspaceMode = 'personal' | 'company' | 'existing' | 'none';
interface Form {
  fullName: string; displayName: string; email: string;
  mode: WorkspaceMode; companyName: string; tenantId: string; membershipRole: string;
  mailboxOn: boolean; domainId: string; localPart: string;
  invitation: 'send_now' | 'send_later' | 'none'; sendMailboxInstructions: boolean;
}
const INITIAL: Form = { fullName: '', displayName: '', email: '', mode: 'personal', companyName: '', tenantId: '', membershipRole: 'mailbox_user', mailboxOn: false, domainId: '', localPart: '', invitation: 'send_now', sendMailboxInstructions: true };
const STEPS = ['Personal information', 'Workspace', 'Mailbox', 'Role', 'Invitation', 'Review'];
const ROLE_HELP: Record<string, string> = {
  owner: 'Full control of the workspace, including other owners and billing.',
  admin: 'Manages members, domains, mailboxes and aliases.',
  mailbox_user: 'Uses their own mailbox only.',
  billing: 'Views plan and usage; no mailbox or domain management.',
};
const emailOk = (v: string) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v.trim());

export default function CreateUser() {
  const { has } = usePermissions();
  const [step, setStep] = useState(0);
  const [f, setF] = useState<Form>(INITIAL);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Row | null>(null);
  const tenants = useAsync(() => (has('tenants.read') ? get<{ tenants: Row[] }>('/admin/tenants?pageSize=100') : Promise.resolve({ tenants: [] })), []);
  const wsId = f.mode === 'existing' ? f.tenantId : '';
  const domains = useAsync(() => (wsId ? get<Row>(`/admin/tenants/${wsId}`).then((t) => t.domains as Row[]) : Promise.resolve([] as Row[])), [wsId]);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setF((x) => ({ ...x, [k]: v }));
  const canMailbox = has('mailboxes.create') && f.mode === 'existing';
  const verified = (domains.data ?? []).filter((d) => d.ownership_status === 'verified' && d.provisioning_status === 'ready' && d.status !== 'suspended');
  const domain = verified.find((d) => d.id === f.domainId);
  const address = domain && f.localPart ? `${f.localPart.trim().toLowerCase()}@${domain.name}` : '';

  const validate = (s: number): Record<string, string> => {
    const e: Record<string, string> = {};
    if (s === 0) {
      if (!f.fullName.trim()) e.fullName = 'Enter the full name.';
      if (!emailOk(f.email)) e.email = 'Enter a valid email address.';
    }
    if (s === 1) {
      if (f.mode === 'company' && f.companyName.trim().length < 2) e.companyName = 'Enter the company name.';
      if (f.mode === 'existing' && !f.tenantId) e.tenantId = 'Select a workspace.';
    }
    if (s === 2 && f.mailboxOn) {
      if (!f.domainId) e.domainId = 'Select a verified domain.';
      if (!/^[a-z0-9][a-z0-9._+-]{0,63}$/i.test(f.localPart.trim())) e.localPart = 'Use letters, numbers and . _ + - only.';
    }
    return e;
  };
  const next = () => { const e = validate(step); setErrors(e); if (Object.keys(e).length === 0) setStep(step + 1); };

  const submit = async () => {
    setBusy(true); setError(null);
    try {
      const workspace = f.mode === 'company' ? { mode: 'company', name: f.companyName.trim() } : f.mode === 'existing' ? { mode: 'existing', tenantId: f.tenantId } : { mode: f.mode };
      const body = {
        fullName: f.fullName.trim(), email: f.email.trim(), ...(f.displayName.trim() ? { displayName: f.displayName.trim() } : {}), workspace, membershipRole: f.membershipRole,
        ...(f.mailboxOn && canMailbox ? { mailbox: { domainId: f.domainId, localPart: f.localPart.trim() } } : {}), invitation: f.invitation, sendMailboxInstructions: f.sendMailboxInstructions,
      };
      setResult(await post<Row>('/admin/users', body));
    } catch (e) {
      setError(e); const fe = fieldErrors(e); if (Object.keys(fe).length) setErrors(fe);
    } finally { setBusy(false); }
  };

  if (result) {
    return (
      <>
        <PageHeader title="User created" />
        <Alert kind="success" title={`${result.user.email} was created`}>
          {result.workspace ? <>Workspace: <strong>{result.workspace.name}</strong>. </> : null}
          {result.invitation ? (result.invitation.delivery === 'queued' ? 'The invitation email is queued; check its delivery state under Invitations.' : 'The invitation has been saved but not sent.') : 'No invitation was created.'}
        </Alert>
        {result.mailbox.state === 'provisioning' && <Alert kind="info" title={`Mailbox ${result.mailbox.address} is being provisioned`}>It becomes active only after the mail server confirms. Track it under Mailboxes or Provisioning jobs.</Alert>}
        {result.mailbox.state === 'failed' && <Alert kind="error" title="The account was created, but the mailbox was not">{result.mailbox.error} You can create the mailbox later from the Mailboxes page.</Alert>}
        <div className="row"><Link className="btn btn-primary" to={`/admin/users/${result.user.id}`}>Open user</Link><Button onClick={() => { setResult(null); setF(INITIAL); setStep(0); }}>Create another</Button></div>
      </>
    );
  }

  const roleHelp = ROLE_HELP[f.membershipRole];
  return (
    <>
      <PageHeader title="Create user" subtitle={<Link to="/admin/users">Back to users</Link>} />
      <ol className="steps" aria-label="Progress">{STEPS.map((s, i) => <li key={s} className={i < step ? 'done' : ''} {...(i === step ? { 'aria-current': 'step' as const } : {})}>{s}</li>)}</ol>
      <ErrorAlert error={error} />
      <Card>
        {step === 0 && (
          <>
            <TextField label="Full name" value={f.fullName} onChange={(e) => set('fullName', e.target.value)} error={errors.fullName} required autoFocus />
            <TextField label="Login email address" type="email" value={f.email} onChange={(e) => set('email', e.target.value)} error={errors.email} hint="Must be unique. The invitation is sent here." required />
            <TextField label="Display name (optional)" value={f.displayName} onChange={(e) => set('displayName', e.target.value)} hint="Defaults to the full name." />
          </>
        )}
        {step === 1 && (
          <>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><strong>Workspace</strong></legend>
              {has('tenants.create') && <label className="choice"><input type="radio" name="mode" checked={f.mode === 'personal'} onChange={() => set('mode', 'personal')} /><span>Create a personal workspace<small>The user owns a new workspace named after them.</small></span></label>}
              {has('tenants.create') && <label className="choice"><input type="radio" name="mode" checked={f.mode === 'company'} onChange={() => set('mode', 'company')} /><span>Create a company workspace<small>The user becomes its owner.</small></span></label>}
              <label className="choice"><input type="radio" name="mode" checked={f.mode === 'existing'} onChange={() => set('mode', 'existing')} /><span>Add to an existing workspace</span></label>
              <label className="choice"><input type="radio" name="mode" checked={f.mode === 'none'} onChange={() => set('mode', 'none')} /><span>No workspace yet<small>Mailboxes need a workspace.</small></span></label>
            </fieldset>
            {f.mode === 'company' && <TextField label="Company name" value={f.companyName} onChange={(e) => set('companyName', e.target.value)} error={errors.companyName} />}
            {f.mode === 'existing' && <SelectField label="Workspace" value={f.tenantId} error={errors.tenantId} onChange={(e) => setF((x) => ({ ...x, tenantId: e.target.value, domainId: '' }))}><option value="">Select…</option>{tenants.data?.tenants.filter((t) => t.status === 'active').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</SelectField>}
          </>
        )}
        {step === 2 && (
          <>
            <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend><strong>Email mailbox</strong></legend>
              <label className="choice"><input type="radio" name="mb" checked={!f.mailboxOn} onChange={() => set('mailboxOn', false)} /><span>Create the application account only<small>A mailbox can be added later.</small></span></label>
              <label className={`choice${canMailbox ? '' : ' muted'}`}><input type="radio" name="mb" disabled={!canMailbox} checked={f.mailboxOn} onChange={() => set('mailboxOn', true)} /><span>Create the account and a mailbox<small>{canMailbox ? 'Uses the workspace plan’s quota and limits.' : f.mode !== 'existing' ? 'Choose an existing workspace in the previous step first.' : 'Requires the mailboxes.create permission.'}</small></span></label>
            </fieldset>
            {f.mailboxOn && canMailbox && (
              <>
                <SelectField label="Verified domain" value={f.domainId} error={errors.domainId} onChange={(e) => set('domainId', e.target.value)} hint={verified.length === 0 && !domains.loading ? 'This workspace has no verified, provisioned domain. Mailboxes cannot be created on unverified domains.' : undefined}>
                  <option value="">Select…</option>{verified.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </SelectField>
                <TextField label="Mailbox name" value={f.localPart} onChange={(e) => set('localPart', e.target.value)} error={errors.localPart} hint={address ? `Address: ${address}` : 'The part before the @'} />
              </>
            )}
          </>
        )}
        {step === 3 && (
          <>
            <SelectField label="Workspace role" value={f.membershipRole} disabled={f.mode === 'none' || f.mode === 'personal' || f.mode === 'company'} onChange={(e) => set('membershipRole', e.target.value)} hint={f.mode === 'personal' || f.mode === 'company' ? 'The creator of a new workspace is always its owner.' : f.mode === 'none' ? 'No workspace selected.' : undefined}>
              {['owner', 'admin', 'mailbox_user', 'billing'].filter((r) => r !== 'owner' || has('tenants.update') || f.mode !== 'existing').map((r) => <option key={r} value={r}>{r.replace('_', ' ')}</option>)}
            </SelectField>
            {f.mode === 'existing' && roleHelp && <Alert kind="info">{roleHelp}</Alert>}
            <p className="muted"><small>Platform-level roles are separate and cannot be granted here. You can only assign roles within your own authority.</small></p>
          </>
        )}
        {step === 4 && (
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend><strong>Invitation</strong></legend>
            <label className="choice"><input type="radio" name="inv" checked={f.invitation === 'send_now'} onChange={() => set('invitation', 'send_now')} /><span>Send an invitation now<small>The user receives a one-time link to choose their own password. No password is ever emailed.</small></span></label>
            <label className="choice"><input type="radio" name="inv" checked={f.invitation === 'send_later'} onChange={() => set('invitation', 'send_later')} /><span>Create the account and send the invitation later</span></label>
            <label className="choice"><input type="radio" name="inv" checked={f.invitation === 'none'} onChange={() => set('invitation', 'none')} /><span>Create the account without an invitation<small>It stays inactive until you send one.</small></span></label>
            {f.mailboxOn && f.invitation !== 'none' && <label className="check"><input type="checkbox" checked={f.sendMailboxInstructions} onChange={(e) => set('sendMailboxInstructions', e.target.checked)} /> Send mail-app setup instructions once the mailbox is provisioned and the account is active</label>}
          </fieldset>
        )}
        {step === 5 && (
          <>
            <h2>Review</h2>
            <dl className="kv" style={{ margin: '1rem 0' }}>
              <dt>Name</dt><dd>{f.fullName}{f.displayName && ` (${f.displayName})`}</dd><dt>Login email</dt><dd>{f.email}</dd>
              <dt>Workspace</dt><dd>{f.mode === 'personal' ? 'New personal workspace' : f.mode === 'company' ? `New company workspace: ${f.companyName}` : f.mode === 'existing' ? tenants.data?.tenants.find((t) => t.id === f.tenantId)?.name : 'None'}</dd>
              <dt>Role</dt><dd>{f.mode === 'none' ? '—' : f.mode === 'existing' ? f.membershipRole.replace('_', ' ') : 'owner'}</dd>
              <dt>Mailbox</dt><dd>{f.mailboxOn ? address || '—' : 'None'}</dd>
              <dt>Invitation</dt><dd>{{ send_now: 'Send now', send_later: 'Create, send later', none: 'None' }[f.invitation]}</dd>
            </dl>
            <Alert kind="info">Nothing is reported as complete until it is: the mailbox shows “provisioning” until the mail server confirms it.</Alert>
          </>
        )}
        <div className="wizard-nav">
          <Button disabled={step === 0 || busy} onClick={() => setStep(step - 1)}>Back</Button>
          {step < STEPS.length - 1 ? <Button variant="primary" onClick={next}>Continue</Button> : <Button variant="primary" busy={busy} onClick={() => void submit()}>Create user</Button>}
        </div>
      </Card>
    </>
  );
}
