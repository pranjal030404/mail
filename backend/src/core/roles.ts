export const TENANT_ROLES = ['owner', 'admin', 'mailbox_user', 'billing'] as const;
export type TenantRole = (typeof TENANT_ROLES)[number];

export const PLATFORM_ROLES = ['none', 'operations', 'super_admin', 'support', 'custom'] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

export const TENANT_ROLE_LABELS: Record<TenantRole, string> = {
  owner: 'Owner',
  admin: 'Admin',
  mailbox_user: 'Mailbox user',
  billing: 'Billing contact',
};

export type TenantAction =
  | 'tenant.read'
  | 'tenant.update'
  | 'members.read'
  | 'members.manage'
  | 'owners.manage'
  | 'domains.read'
  | 'domains.manage'
  | 'mailboxes.read'
  | 'mailboxes.manage'
  | 'mailbox.self'
  | 'aliases.read'
  | 'aliases.manage'
  | 'usage.read'
  | 'billing.read'
  | 'audit.read'
  | 'support.use';

const ADMIN_ACTIONS: TenantAction[] = [
  'tenant.read',
  'tenant.update',
  'members.read',
  'members.manage',
  'domains.read',
  'domains.manage',
  'mailboxes.read',
  'mailboxes.manage',
  'mailbox.self',
  'aliases.read',
  'aliases.manage',
  'usage.read',
  'audit.read',
  'support.use',
];

/** Least-privilege permission matrix for tenant roles. */
export const TENANT_PERMISSIONS: Record<TenantRole, ReadonlySet<TenantAction>> = {
  owner: new Set<TenantAction>([...ADMIN_ACTIONS, 'owners.manage', 'billing.read']),
  admin: new Set<TenantAction>(ADMIN_ACTIONS),
  billing: new Set<TenantAction>(['tenant.read', 'billing.read', 'usage.read', 'support.use']),
  mailbox_user: new Set<TenantAction>(['tenant.read', 'mailbox.self', 'support.use']),
};

export function tenantCan(role: TenantRole | null | undefined, action: TenantAction): boolean {
  if (!role) return false;
  return TENANT_PERMISSIONS[role]?.has(action) ?? false;
}

export type PlatformAction =
  | 'admin.read'
  | 'admin.tenants.manage'
  | 'admin.mailboxes.manage'
  | 'admin.jobs.manage'
  | 'admin.abuse.manage'
  | 'admin.users.manage'
  | 'admin.plans.manage'
  | 'admin.settings.manage'
  | 'admin.roles.manage'
  | 'admin.access.request'
  | 'admin.access.approve';

const OPERATIONS_ACTIONS: PlatformAction[] = [
  'admin.read',
  'admin.tenants.manage',
  'admin.mailboxes.manage',
  'admin.jobs.manage',
  'admin.abuse.manage',
  'admin.users.manage',
  'admin.access.request',
];

export const PLATFORM_PERMISSIONS: Record<PlatformRole, ReadonlySet<PlatformAction>> = {
  none: new Set(),
  support: new Set<PlatformAction>(['admin.read']),
  custom: new Set(),
  operations: new Set(OPERATIONS_ACTIONS),
  super_admin: new Set<PlatformAction>([...OPERATIONS_ACTIONS, 'admin.plans.manage', 'admin.settings.manage', 'admin.roles.manage', 'admin.access.approve']),
};

export function platformCan(role: PlatformRole | null | undefined, action: PlatformAction): boolean {
  if (!role) return false;
  return PLATFORM_PERMISSIONS[role]?.has(action) ?? false;
}

/** Whether `actorRole` may assign or revoke `targetRole` within a tenant. */
export function canAssignRole(actorRole: TenantRole, targetRole: TenantRole): boolean {
  if (targetRole === 'owner') return actorRole === 'owner';
  return tenantCan(actorRole, 'members.manage');
}
