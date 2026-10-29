import { Bell, Globe, Inbox, LayoutDashboard, LifeBuoy, LogOut, Mail, Settings, Shield, Users, BarChart3, BookOpen, Forward, ShieldAlert, ListChecks, ScrollText, UserCog, Activity } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, NavLink, Navigate, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { get } from '../lib/api';
import { useAuth } from '../lib/auth';
import { useAsync } from '../lib/useAsync';
import { AdminLogin } from '../pages/public/AdminLogin';
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

export function AdminLayout() {
  const { me, loading } = useAuth();
  if (loading) return <div className="page"><Spinner label="Checking your session" /></div>;
  if (!me) return <AdminLogin />;
  return (
    <RequireAuth>
      {me?.user.platformRole === 'none' ? <Navigate to="/dashboard" replace /> : (
        <>
          <a className="skip-link" href="#main">Skip to content</a>
          <TopBar admin />
          <div className="shell">
            <nav className="side" aria-label="Admin">
              {item('/admin', <Activity size={16} />, 'Overview', true)}
              {item('/admin/tenants', <Users size={16} />, 'Tenants')}
              {item('/admin/access', <ShieldAlert size={16} />, 'Mailbox access')}
              {item('/admin/jobs', <ListChecks size={16} />, 'Provisioning')}
              {item('/admin/abuse', <ShieldAlert size={16} />, 'Abuse')}
              {item('/admin/support', <LifeBuoy size={16} />, 'Support')}
              {item('/admin/users', <UserCog size={16} />, 'Users & invites')}
              {item('/admin/settings', <Settings size={16} />, 'Settings')}
              {item('/admin/audit', <ScrollText size={16} />, 'Audit log')}
              <h4>Account</h4>
              {item('/dashboard/security', <Shield size={16} />, 'My security')}
              <NavLink to="/help"><BookOpen size={16} />Runbooks</NavLink>
            </nav>
            <main id="main">
              {me?.mfaSetupRequired ? <Navigate to="/dashboard/security" replace state={{ reason: 'admin-mfa' }} /> : <Outlet />}
            </main>
          </div>
        </>
      )}
    </RequireAuth>
  );
}
