/**
 * Transactional email templates: table-based, inline-styled HTML (works in common clients and
 * dark mode) with a plain-text twin. Every interpolated value is HTML-escaped. Templates never
 * receive passwords, hashes, MFA material or API secrets.
 */
export type EmailKind =
  | 'account_invitation'
  | 'account_activated'
  | 'password_reset_admin'
  | 'mailbox_created'
  | 'mailbox_instructions'
  | 'account_suspended'
  | 'account_reactivated'
  | 'security_notice'
  | 'config_test';

export interface ClientSettingsView {
  imapHost: string;
  imapPort: number;
  smtpHost: string;
  smtpPort: number;
  webmailUrl?: string | null | undefined;
}

export interface TemplateParams {
  name?: string;
  loginEmail?: string;
  workspaceName?: string | null;
  mailboxAddress?: string | null;
  actionUrl?: string;
  expiresAt?: string;
  expiresInMinutes?: number;
  invitedBy?: string | null;
  headline?: string;
  detail?: string;
  reason?: string | null;
  client?: ClientSettingsView;
  setupGuideUrl?: string;
  signInUrl?: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

export const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const BRAND = 'ARTHVEX Mail';
const SECURITY_NOTE = 'ARTHVEX will never ask for your password by email. If you did not expect this message, ignore it — nothing will change unless you open the link.';

interface Block {
  heading: string;
  preheader: string;
  paragraphs: string[];
  facts?: [string, string][];
  cta?: { label: string; url: string } | undefined;
  closing?: string[];
  footer?: string;
}

function layout(b: Block): { html: string; text: string } {
  const facts = b.facts?.length
    ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:16px 0;border:1px solid #e4e4e7;border-radius:8px;border-collapse:separate;">${b.facts
        .map(([k, v]) => `<tr><td style="padding:10px 14px;font-size:13px;color:#52525b;width:38%;border-bottom:1px solid #f4f4f5;">${esc(k)}</td><td style="padding:10px 14px;font-size:14px;color:#18181b;border-bottom:1px solid #f4f4f5;word-break:break-all;">${esc(v)}</td></tr>`)
        .join('')}</table>`
    : '';
  const cta = b.cta
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0;"><tr><td style="background:#4f46e5;border-radius:8px;"><a href="${esc(b.cta.url)}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">${esc(b.cta.label)}</a></td></tr></table><p style="margin:0 0 16px;font-size:12px;color:#71717a;line-height:1.5;">If the button does not work, copy this address into your browser:<br><a href="${esc(b.cta.url)}" style="color:#4f46e5;word-break:break-all;">${esc(b.cta.url)}</a></p>`
    : '';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${esc(b.heading)}</title></head>
<body style="margin:0;padding:0;background:#f4f4f5;"><span style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(b.preheader)}</span>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f5;"><tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:12px;border:1px solid #e4e4e7;">
<tr><td style="padding:24px 28px 0;font-family:Helvetica,Arial,sans-serif;font-size:14px;font-weight:700;letter-spacing:.04em;color:#4f46e5;">${BRAND}</td></tr>
<tr><td style="padding:12px 28px 28px;font-family:Helvetica,Arial,sans-serif;color:#18181b;">
<h1 style="margin:0 0 14px;font-size:21px;line-height:1.3;color:#18181b;">${esc(b.heading)}</h1>
${b.paragraphs.map((p) => `<p style="margin:0 0 12px;font-size:15px;line-height:1.55;color:#27272a;">${esc(p)}</p>`).join('')}${facts}${cta}
${(b.closing ?? []).map((p) => `<p style="margin:0 0 10px;font-size:14px;line-height:1.55;color:#3f3f46;">${esc(p)}</p>`).join('')}
<p style="margin:18px 0 0;padding-top:14px;border-top:1px solid #e4e4e7;font-size:12px;line-height:1.5;color:#71717a;">${esc(b.footer ?? SECURITY_NOTE)}</p>
</td></tr></table></td></tr></table></body></html>`;
  const text = [
    b.heading,
    '',
    ...b.paragraphs,
    ...(b.facts?.length ? ['', ...b.facts.map(([k, v]) => `${k}: ${v}`)] : []),
    ...(b.cta ? ['', `${b.cta.label}:`, b.cta.url] : []),
    ...(b.closing?.length ? ['', ...b.closing] : []),
    '',
    '--',
    b.footer ?? SECURITY_NOTE,
  ].join('\n');
  return { html, text };
}

const greeting = (p: TemplateParams) => (p.name ? `Hello ${p.name},` : 'Hello,');
const when = (iso?: string) => (iso ? new Date(iso).toUTCString() : '');

export function renderEmail(kind: EmailKind, p: TemplateParams): RenderedEmail {
  const mk = (subject: string, b: Block): RenderedEmail => ({ subject, ...layout(b) });
  switch (kind) {
    case 'account_invitation':
      return mk(`Set up your ${BRAND} account`, {
        heading: 'Your account is ready to activate',
        preheader: 'Choose a password to finish setting up your account.',
        paragraphs: [greeting(p), `${p.invitedBy ? `${p.invitedBy} has` : 'An administrator has'} created an ${BRAND} account for you. Choose your own password to activate it — no password has been set or sent.`],
        facts: [['Login email', p.loginEmail ?? ''], ...(p.workspaceName ? [['Workspace', p.workspaceName] as [string, string]] : []), ...(p.mailboxAddress ? [['Mailbox', p.mailboxAddress] as [string, string]] : []), ['Link expires', when(p.expiresAt)]],
        cta: { label: 'Activate your account', url: p.actionUrl ?? '' },
        closing: [...(p.mailboxAddress ? ['Your mailbox will be ready to use once your account is active. Instructions for connecting an email app are on the setup page.'] : []), ...(p.setupGuideUrl ? [`Email app setup guide: ${p.setupGuideUrl}`] : []), 'The link works once. If it expires, ask your administrator to send a new invitation.'],
      });
    case 'account_activated':
      return mk(`Your ${BRAND} account is active`, {
        heading: 'Welcome aboard',
        preheader: 'Your account is active.',
        paragraphs: [greeting(p), 'Your account has been activated. You can now sign in.'],
        cta: p.signInUrl ? { label: 'Sign in', url: p.signInUrl } : undefined,
        footer: 'If you did not activate this account, contact support immediately.',
      });
    case 'password_reset_admin':
      return mk(`Reset your ${BRAND} password`, {
        heading: 'Choose a new password',
        preheader: 'A password reset was started for your account.',
        paragraphs: [greeting(p), 'An administrator started a password reset for your account. Open the link to choose a new password. Your current password keeps working until you do.'],
        facts: [['Link valid for', `${p.expiresInMinutes ?? 30} minutes`]],
        cta: { label: 'Choose a new password', url: p.actionUrl ?? '' },
      });
    case 'mailbox_created':
      return mk('Your new mailbox is ready', {
        heading: 'Mailbox created',
        preheader: `${p.mailboxAddress ?? 'Your mailbox'} is ready.`,
        paragraphs: [greeting(p), 'A mailbox has been created for you. Sign in to your workspace to set the mailbox password — it is never sent by email.'],
        facts: [['Mailbox', p.mailboxAddress ?? ''], ...(p.workspaceName ? [['Workspace', p.workspaceName] as [string, string]] : [])],
        cta: p.signInUrl ? { label: 'Open your workspace', url: p.signInUrl } : undefined,
      });
    case 'mailbox_instructions': {
      const c = p.client;
      return mk('Connect your email app', {
        heading: 'Mail app settings',
        preheader: `Settings for ${p.mailboxAddress ?? 'your mailbox'}.`,
        paragraphs: [greeting(p), 'Use these settings to connect Thunderbird, Apple Mail, Outlook or your phone. Your username is your full address; use the mailbox password you set in your workspace (it is not included here).'],
        facts: [['Username', p.mailboxAddress ?? ''], ...(c ? ([['Incoming (IMAP)', `${c.imapHost}, port ${c.imapPort}, SSL/TLS`], ['Outgoing (SMTP)', `${c.smtpHost}, port ${c.smtpPort}, SSL/TLS`]] as [string, string][]) : []), ...(c?.webmailUrl ? ([['Webmail', c.webmailUrl]] as [string, string][]) : [])],
        cta: p.setupGuideUrl ? { label: 'Full setup guide', url: p.setupGuideUrl } : undefined,
      });
    }
    case 'account_suspended':
      return mk(`Your ${BRAND} account was suspended`, {
        heading: 'Account suspended',
        preheader: 'Access to your account has been paused.',
        paragraphs: [greeting(p), 'Access to your account has been suspended and you were signed out everywhere.', ...(p.reason ? [`Reason: ${p.reason}`] : []), 'Contact support if you think this is a mistake.'],
      });
    case 'account_reactivated':
      return mk(`Your ${BRAND} account was reactivated`, {
        heading: 'Account reactivated',
        preheader: 'You can sign in again.',
        paragraphs: [greeting(p), 'Your account has been reactivated. You can sign in again.'],
        cta: p.signInUrl ? { label: 'Sign in', url: p.signInUrl } : undefined,
      });
    case 'security_notice':
      return mk(`Security notice: ${p.headline ?? 'account change'}`, {
        heading: p.headline ?? 'Security notice',
        preheader: p.headline ?? 'A security change was made to your account.',
        paragraphs: [greeting(p), p.detail ?? 'A security-related change was made to your account.'],
        footer: 'If this was not you, reset your password and contact support right away.',
      });
    case 'config_test':
      return mk(`${BRAND} email delivery test`, {
        heading: 'Delivery test',
        preheader: 'Your email configuration works.',
        paragraphs: ['This is a test message sent from the ARTHVEX admin console. If you can read it, outgoing platform email is working.'],
        footer: 'No action is needed.',
      });
  }
}
