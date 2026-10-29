import { Globe, Inbox, Lock, MailCheck } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Alert, Card } from '../../components/ui';

export default function Landing() {
  return (
    <div className="page">
      <section className="hero">
        <h1>Professional email on the domain you already own</h1>
        <p>ARTHVEX Email Hosting lets small businesses connect their own domain, create mailboxes such as <code>hello@yourcompany.com</code>, read mail in the browser, and use standard email apps on desktop and phone.</p>
        <div className="row">
          <Link className="btn btn-primary" to="/register">Request access</Link>
          <Link className="btn" to="/setup-guide">How setup works</Link>
        </div>
      </section>
      <Alert kind="info" title="Free and open source">
        Free for companies and individuals — bring your own domain and create mailboxes on it. This is community software: there is no uptime guarantee (SLA) and we cannot promise that any message reaches the recipient’s inbox.
      </Alert>
      <div className="grid">
        <Card title={<><Globe size={16} /> Your domain</>}>You prove ownership with a DNS record, then add the mail records we show you. ARTHVEX never changes your DNS for you.</Card>
        <Card title={<><Inbox size={16} /> Mailboxes &amp; aliases</>}>Create mailboxes with fixed storage quotas, aliases, and approved forwarding that the recipient must confirm.</Card>
        <Card title={<><MailCheck size={16} /> Webmail &amp; email apps</>}>Use webmail or connect any app that supports IMAP and authenticated SMTP over TLS.</Card>
        <Card title={<><Lock size={16} /> Security first</>}>Two-factor sign-in, audited administration, strict tenant isolation, and hard limits on storage and sending.</Card>
      </div>
    </div>
  );
}
