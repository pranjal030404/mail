import { Bell, Globe, Inbox, LayoutDashboard, LifeBuoy, LogOut, Mail, Settings, Shield, Users, BarChart3, Forward, ShieldAlert, ListChecks, ScrollText, UserCog, Activity, Building2, MailPlus, Send, KeyRound, Menu, Sun, Moon } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/useAsync';
import { AdminLogin } from '../pages/public/AdminLogin';
import { ToastProvider } from '../pages/admin/kit';
import { Spinner } from './ui';

export function PublicLayout() {
  const { me } = useAuth();
  return (
    <>
      <a className="skip-link" href="#main">Skip to content</a>
      <header className="topbar">
        <div className="topbar-in">
          <Link to="/" className="brand">ARTH<span>VEX</span> <small className="muted">Email</small></Link>
          <nav className="nav" aria-label="Main">
            <NavLink to="/features">Features</NavLink>
            <NavLink to="/setup-guide">Setup guide</NavLink>
            <NavLink to="/limitations">Plans &amp; limits</NavLink>
            <NavLink to="/security">Security</NavLink>
            <NavLink to="/help">Help</NavLink>
          </nav>
          {me ? <Link className="btn btn-primary" to="/dashboard">Dashboard</Link> : (<><Link className="btn" to="/login">Sign in</Link><Link className="btn btn-primary" to="/register">Register</Link></>)}
        </div>
      </header>
      <main id="main"><Outlet /></main>
      <footer className="footer">
        <div className="footer-in">
          <span>© ARTHVEX. Free and open source — no SLA, no delivery guarantee.</span>
          <Link to="/privacy">Privacy</Link><Link to="/acceptable-use">Acceptable use</Link><Link to="/terms">Terms</Link><Link to="/report-abuse">Report abuse</Link>
        </div>
      </footer>
    </>
  );
}

/** Redirects anonymous users to sign-in and unfinished-MFA sessions to the code prompt. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useAuth();
  const loc = useLocation();
  if (loading) return <div className="page"><Spinner label="Checking your session" /></div>;
  if (!me) return <Navigate to="/login" replace state={{ from: loc.pathname }} />;
  if (me.mfaPending) return <Navigate to="/login/mfa" replace />;
  return <>{children}</>;
}

function TopBar({ admin }: { admin?: boolean }) {
  const { me, logout } = useAuth();
  const nav = useNavigate();
  const notes = useAsync(() => get<{ notifications: { read: boolean }[] }>('/notifications'), []);
  const unread = notes.data?.notifications.filter((n) => !n.read).length ?? 0;
  return (
    <header className="topbar">
      <div className="topbar-in">
        <Link to={admin ? '/admin' : '/dashboard'} className="brand">ARTH<span>VEX</span> <small className="muted">{admin ? 'Admin' : 'Email'}</small></Link>
        <span style={{ flex: 1 }} />
        {me?.user.platformRole !== 'none' && (admin ? <Link className="btn btn-sm" to="/dashboard">Customer view</Link> : <Link className="btn btn-sm" to="/admin"><Shield size={14} /> Admin</Link>)}
        <Link to="/dashboard/notifications" className="btn btn-ghost btn-sm" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`}><Bell size={16} />{unread > 0 && <span className="badge badge-bad">{unread}</span>}</Link>
        <span className="muted" title={me?.user.email}>{me?.user.displayName}</span>
        <button className="btn btn-sm" onClick={async () => { await logout(); nav('/'); }}><LogOut size={14} /> Sign out</button>
      </div>
    </header>
  );
}

const item = (to: string, icon: ReactNode, label: string, end = false) => (
  <NavLink key={to} to={to} end={end}>{icon}{label}</NavLink>
);

export function DashboardLayout() {
  const { me, tenantId, setTenantId } = useAuth();
  const membership = me?.memberships.find((m) => m.tenantId === tenantId);
  const manage = membership?.role === 'owner' || membership?.role === 'admin';
  return (
    <RequireAuth>
      <a className="skip-link" href="#main">Skip to content</a>
      <TopBar />
      <div className="shell">
        <nav className="side" aria-label="Dashboard">
          {me && me.memberships.length > 1 && (
            <select aria-label="Workspace" value={tenantId ?? ''} onChange={(e) => setTenantId(e.target.value)} style={{ marginBottom: 8 }}>
              {me.memberships.map((m) => <option key={m.tenantId} value={m.tenantId}>{m.name}</option>)}
            </select>
          )}
          {item('/dashboard', <LayoutDashboard size={16} />, 'Overview', true)}
          {item('/dashboard/webmail', <Inbox size={16} />, 'Webmail')}
          {manage && item('/dashboard/domains', <Globe size={16} />, 'Domains')}
          {item('/dashboard/mailboxes', <Inbox size={16} />, 'Mailboxes')}
          {manage && item('/dashboard/aliases', <Forward size={16} />, 'Aliases')}
          {membership?.role !== 'mailbox_user' && item('/dashboard/usage', <BarChart3 size={16} />, 'Usage')}
          {manage && item('/dashboard/members', <Users size={16} />, 'Members')}
          <h4>Help</h4>
          {item('/dashboard/clients', <Mail size={16} />, 'Email client setup')}
          {item('/dashboard/support', <LifeBuoy size={16} />, 'Support')}
          <h4>Account</h4>
          {item('/dashboard/security', <Shield size={16} />, 'Security')}
          {item('/dashboard/notifications', <Bell size={16} />, 'Notifications')}
          {item('/dashboard/profile', <Settings size={16} />, 'Profile')}
        </nav>
        <main id="main"><Outlet /></main>
      </div>
    </RequireAuth>
  );
}

interface NavItem { to: string; label: string; icon: ReactNode; perm: string; end?: boolean }
const ADMIN_NAV: { group: string; items: NavItem[] }[] = [
  { group: 'Overview', items: [{ to: '/admin', label: 'Dashboard', icon: <Activity size={16} />, perm: 'dashboard.read', end: true }] },
  { group: 'Organization', items: [
    { to: '/admin/tenants', label: 'Tenants & workspaces', icon: <Building2 size={16} />, perm: 'tenants.read' },
    { to: '/admin/domains', label: 'Domains', icon: <Globe size={16} />, perm: 'domains.read' },
    { to: '/admin/users', label: 'Users', icon: <Users size={16} />, perm: 'users.read' },
    { to: '/admin/invitations', label: 'Invitations', icon: <MailPlus size={16} />, perm: 'users.read' },
    { to: '/admin/mailboxes', label: 'Mailboxes', icon: <Inbox size={16} />, perm: 'mailboxes.read' },
  ] },
  { group: 'Operations', items: [
    { to: '/admin/jobs', label: 'Provisioning jobs', icon: <ListChecks size={16} />, perm: 'provisioning.read' },
    { to: '/admin/notifications', label: 'Email delivery', icon: <Send size={16} />, perm: 'notifications.read' },
    { to: '/admin/support', label: 'Support tickets', icon: <LifeBuoy size={16} />, perm: 'support.read' },
    { to: '/admin/abuse', label: 'Abuse reports', icon: <ShieldAlert size={16} />, perm: 'abuse.read' },
    { to: '/admin/access', label: 'Mailbox access', icon: <KeyRound size={16} />, perm: 'mailbox_access.request' },
  ] },
  { group: 'Administration', items: [
    { to: '/admin/roles', label: 'Roles & permissions', icon: <UserCog size={16} />, perm: 'roles.read' },
    { to: '/admin/admins', label: 'Administrators', icon: <Shield size={16} />, perm: 'admins.manage' },
    { to: '/admin/plans', label: 'Plans & quotas', icon: <BarChart3 size={16} />, perm: 'plans.read' },
    { to: '/admin/settings', label: 'Platform settings', icon: <Settings size={16} />, perm: 'settings.read' },
    { to: '/admin/audit', label: 'Audit log', icon: <ScrollText size={16} />, perm: 'audit.read' },
  ] },
];

type Theme = 'dark' | 'light';
const readTheme = (): Theme => {
  try { return localStorage.getItem('arthvex.admin.theme') === 'light' ? 'light' : 'dark'; } catch { return 'dark'; }
};

export function AdminLayout() {
  const { me, loading, logout } = useAuth();
  const nav = useNavigate();
  const loc = useLocation();
  const [theme, setTheme] = useState<Theme>(readTheme);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => { delete document.documentElement.dataset.theme; };
  }, [theme]);
  useEffect(() => setOpen(false), [loc.pathname]);
  if (loading) return <div className="page"><Spinner label="Checking your session" /></div>;
  if (!me) return <AdminLogin />;
  const perms = new Set(me.user.permissions ?? []);
  const toggle = () => {
    const next: Theme = theme === 'dark' ? 'light' : 'dark';
    setTheme(next);
    try { localStorage.setItem('arthvex.admin.theme', next); } catch { /* preference is optional */ }
  };
  return (
    <RequireAuth>
      {me.user.platformRole === 'none' ? <Navigate to="/dashboard" replace /> : (
        <ToastProvider>
          <a className="skip-link" href="#main">Skip to content</a>
          <header className="topbar">
            <div className="topbar-in">
              <button className="btn btn-ghost btn-sm menu-btn" aria-label="Toggle navigation" aria-expanded={open} aria-controls="admin-nav" onClick={() => setOpen(!open)}><Menu size={18} /></button>
              <Link to="/admin" className="brand">ARTH<span>VEX</span> <small className="muted">Admin</small></Link>
              <span style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={toggle} aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}>{theme === 'dark' ? <Sun size={16} /> : <Moon size={16} />}</button>
              <span className="muted who" title={me.user.email}>{me.user.displayName}{me.user.roleKey ? <small> · {me.user.roleKey.replace(/_/g, ' ')}</small> : null}</span>
              <button className="btn btn-sm" onClick={async () => { await logout(); nav('/'); }}><LogOut size={14} /> Sign out</button>
            </div>
          </header>
          <div className="shell">
            <nav id="admin-nav" className={`side${open ? ' open' : ''}`} aria-label="Admin">
              {ADMIN_NAV.map((g) => {
                const items = g.items.filter((i) => perms.has(i.perm));
                if (items.length === 0) return null;
                return <div key={g.group} className="side-group"><h4>{g.group}</h4>{items.map((i) => item(i.to, i.icon, i.label, i.end))}</div>;
              })}
              <div className="side-group">
                <h4>My account</h4>
                {item('/dashboard/profile', <UserCog size={16} />, 'Profile')}
                {item('/dashboard/security', <Shield size={16} />, 'Security & MFA')}
                <NavLink to="/dashboard/security#sessions"><Activity size={16} />Active sessions</NavLink>
              </div>
            </nav>
            <main id="main">
              {me.mfaSetupRequired ? <Navigate to="/dashboard/security" replace state={{ reason: 'admin-mfa' }} /> : <Outlet />}
            </main>
          </div>
        </ToastProvider>
      )}
    </RequireAuth>
  );
}
