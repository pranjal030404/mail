import { Link, useLocation } from 'react-router-dom';
import { useState, type FormEvent } from 'react';
import { Alert, Button, Card, ErrorAlert, SelectField, TextArea, TextField } from '../../components/ui';
import { post } from '../../lib/api';

function Page({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="page prose">
      <h1>{title}</h1>
      {children}
    </div>
  );
}

const Features = () => (
  <Page title="Features and supported protocols">
    <ul>
      <li>Custom domains with TXT-record ownership verification, then separate checks for inbound routing (MX) and outbound authentication (SPF, DKIM, DMARC).</li>
      <li>Mailboxes with hard storage quotas, suspension, and scheduled deletion with a grace period.</li>
      <li>Aliases, and forwarding to outside addresses only after the recipient confirms.</li>
      <li>Workspaces with roles: owner, admin, mailbox user, and billing contact.</li>
      <li>Access over IMAP with TLS and authenticated SMTP submission with TLS. Exact hostnames and ports are shown per mailbox in your dashboard because they depend on the deployment. Webmail availability depends on the deployment as well.</li>
      <li>Usage reports with warnings at 75%, 90% and 100% of quota. Usage figures are collected periodically and can lag by several minutes.</li>
    </ul>
    <p className="muted">Not included: calendars, video meetings, document editing, unlimited storage, unlimited sending, or guaranteed inbox placement.</p>
  </Page>
);

const SetupGuide = () => (
  <Page title="Setup guide: domain ownership and DNS">
    <p>You need a domain you control and access to its DNS settings at your registrar or DNS provider. ARTHVEX cannot change your DNS; you add the records yourself.</p>
    <ol>
      <li><strong>Add the domain</strong> in the dashboard. We generate a unique ownership token.</li>
      <li><strong>Publish the TXT record</strong> we show (host <code>_arthvex-verification</code>) and press Verify. Only the exact value at that name counts as proof.</li>
      <li><strong>Add the mail records</strong> we then display: MX (so mail reaches ARTHVEX), SPF and DKIM (so receivers trust mail you send), and DMARC. Values are generated from the live server configuration — never copy values from another source.</li>
      <li><strong>Run the DNS check.</strong> Inbound routing and outbound authentication are reported separately, with the expected and the observed values.</li>
      <li><strong>Create mailboxes</strong> and set a password. Test sending and receiving with addresses at other providers.</li>
    </ol>
    <h2>Propagation</h2>
    <p>DNS changes can take minutes to 48 hours to become visible. If a check fails right after you saved a record, wait and re-check. We re-check automatically in the background.</p>
    <h2>Reverse DNS</h2>
    <p>Receivers also look at the sending server’s reverse DNS. That is configured by ARTHVEX’s network provider, not by you.</p>
  </Page>
);

const Limitations = () => (
  <Page title="Plans, limits and service limitations">
    <Alert kind="info" title="Free for everyone">There is no charge to use the platform. Limits per workspace exist to keep shared servers, storage, bandwidth and IP reputation healthy, and are set by the platform administrator.</Alert>
    <ul>
      <li>Default limits (configurable by the platform administrator): one verified domain, two mailboxes, 100 MB per mailbox, a daily sending limit and a limited number of aliases.</li>
      <li>No SLA. No uptime figure is promised.</li>
      <li>No guarantee of delivery or inbox placement. “Accepted by our server” does not mean “delivered” or “not marked as spam”.</li>
      <li>Capacity is bounded by the resources of this deployment; no account-count commitment is made.</li>
      <li>Accounts that send spam or abuse are suspended immediately.</li>
    </ul>
  </Page>
);

const Security = () => (
  <Page title="Security and privacy practices">
    <ul>
      <li>Passwords are hashed with Argon2id. Mailbox passwords are never stored in our application database.</li>
      <li>Optional two-factor sign-in for customers; mandatory for ARTHVEX administrators.</li>
      <li>Every administrative action requires a reason and is recorded in an audit log.</li>
      <li>Support staff do not have routine access to message content.</li>
      <li>Mail protocols use TLS; authenticated submission is required, and open relaying is disabled.</li>
    </ul>
    <p>To report a vulnerability, contact the operator of this deployment through the support address published on the sign-in page. <Link to="/report-abuse">Report abuse</Link> if you received unwanted mail from an ARTHVEX-hosted address.</p>
  </Page>
);

const Privacy = () => (
  <Page title="Privacy notice">
    <p>We store account details (name, login email, hashed password), workspace and domain configuration, mailbox metadata (address, quota, status), usage counters, support requests and audit records. Message content is stored by the mail server, not in the control-plane database.</p>
    <p>Deleted mailboxes are removed from the mail server after a grace period (default 7 days). Backups are retained according to the operator’s backup policy. Contact the operator of this deployment for access, correction or deletion requests.</p>
  </Page>
);

const Aup = () => (
  <Page title="Acceptable use">
    <p>Do not use ARTHVEX to send spam, phishing or malware, to impersonate others, or to evade the limits of your plan. We suspend sending immediately when we detect or receive credible reports of abuse, and may remove accounts that repeat it.</p>
  </Page>
);

const Terms = () => (
  <Page title="Terms of service">
    <p>This service is provided as is, without warranty or service level. You are responsible for the domains you add, the content you send and compliance with the laws that apply to you. Accounts that send spam, phishing or malware, or that otherwise abuse the service, may be suspended or removed.</p>
    <p>The software is free and open source under the MIT licence. The operator of this deployment is responsible for its configuration, data and availability.</p>
  </Page>
);

const Help = () => (
  <Page title="Help centre">
    <Card title="DNS check fails">
      <ul>
        <li>Make sure the record is on the exact host name shown; many DNS panels append your domain automatically, so enter <code>_arthvex-verification</code>, not the full name, if so.</li>
        <li>Only one SPF record may exist. Merge them into one.</li>
        <li>Long DKIM values may need to be split into quoted chunks by some providers.</li>
        <li>Wait for propagation, then re-check.</li>
      </ul>
    </Card>
    <Card title="My email app cannot sign in">
      <ul>
        <li>Username is your full address. Use the password you set in the dashboard (reset it if unsure).</li>
        <li>Use the exact host and ports shown on the mailbox page; require SSL/TLS.</li>
        <li>A suspended or over-quota mailbox rejects sign-in or new mail.</li>
      </ul>
    </Card>
    <Card title="Mail is not arriving or lands in spam">
      <ul>
        <li>Check inbound readiness (MX) and outbound authentication (SPF/DKIM/DMARC) on your domain page.</li>
        <li>New senders often start in spam; reputation takes time. We cannot guarantee inbox placement.</li>
      </ul>
    </Card>
    <p>Still stuck? Sign in and open a support request. Never send passwords or message contents in a request.</p>
  </Page>
);

function ReportAbuse() {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle');
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState({ reportedAddress: '', reporterEmail: '', category: 'spam', summary: '' });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setState('busy');
    setError(null);
    try {
      await post('/abuse-reports', { ...(f.reportedAddress ? { reportedAddress: f.reportedAddress } : {}), ...(f.reporterEmail ? { reporterEmail: f.reporterEmail } : {}), category: f.category, summary: f.summary });
      setState('done');
    } catch (err) {
      setError(err);
      setState('idle');
    }
  };
  if (state === 'done') return <Page title="Report abuse"><Alert kind="success" title="Report received">Thank you. Our team will review it. We may not reply individually.</Alert></Page>;
  return (
    <Page title="Report abuse">
      <p>Use this form to report spam, phishing or malware from an ARTHVEX-hosted address. Do not paste full message bodies; include the sender address and a short description.</p>
      <form onSubmit={submit}>
        <TextField label="Reported address" type="email" value={f.reportedAddress} onChange={(e) => setF({ ...f, reportedAddress: e.target.value })} />
        <SelectField label="Category" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>
          {['spam', 'phishing', 'malware', 'compromised_account', 'unusual_sending', 'other'].map((c) => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
        </SelectField>
        <TextArea label="What happened?" required minLength={10} maxLength={3000} value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        <TextField label="Your email (optional, for follow-up)" type="email" value={f.reporterEmail} onChange={(e) => setF({ ...f, reporterEmail: e.target.value })} />
        <ErrorAlert error={error} />
        <Button type="submit" variant="primary" busy={state === 'busy'}>Send report</Button>
      </form>
    </Page>
  );
}

const PAGES: Record<string, () => React.ReactElement> = {
  '/features': Features, '/setup-guide': SetupGuide, '/limitations': Limitations, '/security': Security, '/privacy': Privacy,
  '/acceptable-use': Aup, '/terms': Terms, '/help': Help, '/report-abuse': ReportAbuse,
};

export default function Info() {
  const { pathname } = useLocation();
  const P = PAGES[pathname.replace(/\/$/, '')];
  if (P) return <P />;
  return <Page title="Page not found"><p>That page does not exist. <Link to="/">Go to the home page</Link>.</p></Page>;
}
