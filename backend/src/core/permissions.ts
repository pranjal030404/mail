/**
 * Platform permission catalog. Identifiers are stable API: they are persisted in `rbac_permissions`
 * and referenced by `rbac_role_permissions`. The database is authoritative at runtime; this file
 * seeds it (syncPermissionCatalog) and lets the code refer to permissions with compile-time safety.
 *
 * Workspace (tenant) roles are a separate scope — see roles.ts. Holding a workspace role never
 * grants any permission listed here.
 */
export interface PermissionDef {
  id: string;
  resource: string;
  action: string;
  description: string;
  /** High-privilege: the role editor warns before granting it. */
  sensitive?: boolean;
}

const p = (resource: string, action: string, description: string, sensitive = false): PermissionDef => ({ id: `${resource}.${action}`, resource, action, description, sensitive });

export const PERMISSION_CATALOG: readonly PermissionDef[] = [
  p('dashboard', 'read', 'View the admin dashboard and service health'),

  p('users', 'read', 'View customer users and their memberships'),
  p('users', 'create', 'Create customer users and send invitations'),
  p('users', 'update', 'Edit profiles, memberships and invitations'),
  p('users', 'suspend', 'Suspend and reactivate customer accounts', true),
  p('users', 'delete', 'Close customer accounts', true),
  p('users', 'sessions.revoke', 'Sign users out of all devices'),
  p('users', 'password_reset', 'Send password-reset links and require MFA re-enrolment'),

  p('tenants', 'read', 'View workspaces'),
  p('tenants', 'create', 'Create workspaces'),
  p('tenants', 'update', 'Edit workspaces'),
  p('tenants', 'suspend', 'Suspend and reactivate workspaces', true),
  p('tenants', 'delete', 'Delete workspaces', true),

  p('mailboxes', 'read', 'View mailboxes and their configuration'),
  p('mailboxes', 'create', 'Create mailboxes'),
  p('mailboxes', 'update', 'Edit mailbox details and schedule deletion'),
  p('mailboxes', 'suspend', 'Suspend and reactivate mailboxes', true),
  p('mailboxes', 'delete', 'Schedule mailbox deletion'),
  p('mailboxes', 'credentials.reset', 'Reset mailbox credentials', true),
  p('mailboxes', 'quota.update', 'Change mailbox quotas within plan limits'),

  p('domains', 'read', 'View domains and DNS status'),
  p('domains', 'create', 'Add domains'),
  p('domains', 'verify', 'Re-verify and reconcile domains'),
  p('domains', 'update', 'Edit domains'),
  p('domains', 'delete', 'Remove domains', true),

  p('provisioning', 'read', 'View provisioning jobs and drift'),
  p('provisioning', 'retry', 'Retry or cancel provisioning jobs'),

  p('notifications', 'read', 'View outgoing email delivery state'),
  p('notifications', 'manage', 'Retry failed emails and send configuration tests'),

  p('support', 'read', 'View support tickets'),
  p('support', 'respond', 'Reply to support tickets'),
  p('abuse', 'read', 'View abuse reports'),
  p('abuse', 'manage', 'Triage and resolve abuse reports'),

  p('settings', 'read', 'View platform settings'),
  p('settings', 'update', 'Change platform settings', true),
  p('plans', 'read', 'View plans'),
  p('plans', 'update', 'Change plans and tenant quotas', true),
  p('roles', 'read', 'View roles'),
  p('roles', 'create', 'Create custom roles', true),
  p('roles', 'update', 'Edit custom roles', true),
  p('roles', 'delete', 'Delete custom roles', true),
  p('permissions', 'read', 'View the permission catalog'),
  p('admins', 'manage', 'View, suspend and assign roles to platform administrators', true),
  p('audit', 'read', 'View the audit log'),
  p('mailbox_access', 'request', 'Request time-limited access to mailbox contents', true),
  p('mailbox_access', 'approve', 'Approve mailbox access requests', true),
] as const;

export type PermissionId = string;
export const ALL_PERMISSION_IDS: readonly PermissionId[] = PERMISSION_CATALOG.map((d) => d.id);
const KNOWN = new Set(ALL_PERMISSION_IDS);
export const isKnownPermission = (id: string): boolean => KNOWN.has(id);

export interface SystemRoleDef {
  key: string;
  name: string;
  description: string;
  permissions: readonly PermissionId[];
}

/** Built-in platform roles. System roles cannot be edited or deleted through the API. */
export const SYSTEM_ROLES: readonly SystemRoleDef[] = [
  {
    key: 'super_admin',
    name: 'Super Administrator',
    description: 'Full platform administration, including roles, settings and plans.',
    permissions: ALL_PERMISSION_IDS,
  },
  {
    key: 'operations',
    name: 'Operations Administrator',
    description: 'Monitors service health, provisioning and delivery. Cannot change security settings or grant privileges.',
    permissions: [
      'dashboard.read', 'users.read', 'users.suspend', 'users.sessions.revoke',
      'tenants.read', 'tenants.suspend', 'mailboxes.read', 'mailboxes.update', 'mailboxes.suspend',
      'domains.read', 'domains.verify', 'provisioning.read', 'provisioning.retry',
      'notifications.read', 'notifications.manage', 'support.read', 'support.respond',
      'abuse.read', 'abuse.manage', 'settings.read', 'plans.read', 'audit.read', 'mailbox_access.request',
    ],
  },
  {
    key: 'support',
    name: 'Support Administrator',
    description: 'Handles tickets and account recovery. No access to mailbox contents or credentials.',
    permissions: [
      'dashboard.read', 'users.read', 'users.password_reset', 'users.sessions.revoke',
      'tenants.read', 'mailboxes.read', 'domains.read', 'provisioning.read',
      'support.read', 'support.respond', 'abuse.read', 'notifications.read',
    ],
  },
];

export const SYSTEM_ROLE_KEYS = SYSTEM_ROLES.map((r) => r.key);

/** Safe role key for custom roles: lowercase slug, never colliding with a system key. */
export function customRoleKey(name: string): string {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || 'role';
  return SYSTEM_ROLE_KEYS.includes(base) ? `custom_${base}` : base;
}

/**
 * A grantor may only hand out permissions it holds itself. Returns the permissions it lacks.
 * This is the single rule behind both role creation/editing and role assignment.
 */
export function escalation(grantor: ReadonlySet<string>, granted: Iterable<string>): string[] {
  return [...granted].filter((id) => !grantor.has(id));
}

/** Permissions that let the holder manage other principals' privileges. */
export const PRIVILEGE_MANAGEMENT: readonly PermissionId[] = ['roles.create', 'roles.update', 'roles.delete', 'admins.manage'];
