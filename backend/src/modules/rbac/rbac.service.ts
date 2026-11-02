import { ALL_PERMISSION_IDS, customRoleKey, escalation, isKnownPermission, PERMISSION_CATALOG, SYSTEM_ROLES, type PermissionId } from '../../core/permissions.js';
import type { Db, Queryable } from '../../db/pool.js';
import { exec, isDuplicateKey, one, rows, tx } from '../../db/pool.js';
import { AppError, conflict, forbidden, notFound, unprocessable } from '../../shared/errors.js';
import { newId } from '../../shared/ids.js';

export interface RoleSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  isSystem: boolean;
  permissions: string[];
  assignedCount: number;
  createdAt: Date;
  updatedAt: Date;
}

const systemRoleId = (key: string) => `SYSROLE${key.toUpperCase().replace(/[^A-Z0-9]/g, '')}`.padEnd(26, '0').slice(0, 26);

/**
 * Idempotently aligns `rbac_permissions` and the built-in roles with the code catalog, so a newly
 * shipped permission reaches existing databases at start-up. Custom roles are never touched, and
 * system roles are only ever extended with permissions the code defines for them.
 */
export async function syncPermissionCatalog(db: Db): Promise<void> {
  await tx(db, async (conn) => {
    for (const d of PERMISSION_CATALOG) {
      await exec(conn, 'INSERT INTO rbac_permissions (id, resource, action, description, is_sensitive) VALUES (?, ?, ?, ?, ?) ON DUPLICATE KEY UPDATE description = VALUES(description), is_sensitive = VALUES(is_sensitive)', [d.id, d.resource, d.action, d.description, d.sensitive ? 1 : 0]);
    }
    for (const r of SYSTEM_ROLES) {
      await exec(conn, 'INSERT INTO rbac_roles (id, role_key, name, description, is_system) VALUES (?, ?, ?, ?, 1) ON DUPLICATE KEY UPDATE description = VALUES(description), is_system = 1', [systemRoleId(r.key), r.key, r.name, r.description]);
      const role = (await one<{ id: string }>(conn, 'SELECT id FROM rbac_roles WHERE role_key = ?', [r.key]))!;
      for (const pid of r.permissions) await exec(conn, 'INSERT IGNORE INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)', [role.id, pid]);
    }
  });
}

export interface AdminAuthority {
  roleId: string | null;
  roleKey: string | null;
  permissions: Set<string>;
}

/** Permissions are read from the database on every request, so role changes apply immediately. */
export async function loadAdminAuthority(db: Queryable, adminId: string): Promise<AdminAuthority> {
  const a = await one<{ role: string; role_id: string | null }>(db, 'SELECT role, role_id FROM platform_admins WHERE id = ?', [adminId]);
  if (!a) return { roleId: null, roleKey: null, permissions: new Set() };
  // Rows created before role_id existed resolve through the legacy enum.
  const role = a.role_id ? await one<{ id: string; role_key: string }>(db, 'SELECT id, role_key FROM rbac_roles WHERE id = ?', [a.role_id]) : await one<{ id: string; role_key: string }>(db, 'SELECT id, role_key FROM rbac_roles WHERE role_key = ?', [a.role]);
  if (!role) return { roleId: null, roleKey: null, permissions: new Set() };
  const perms = await rows<{ permission_id: string }>(db, 'SELECT permission_id FROM rbac_role_permissions WHERE role_id = ?', [role.id]);
  return { roleId: role.id, roleKey: role.role_key, permissions: new Set(perms.map((p) => p.permission_id)) };
}

export async function listPermissions(db: Queryable) {
  return rows<{ id: string; resource: string; action: string; description: string; is_sensitive: number }>(db, 'SELECT id, resource, action, description, is_sensitive AS is_sensitive FROM rbac_permissions ORDER BY resource, action');
}

function present(r: { id: string; role_key: string; name: string; description: string; is_system: number; created_at: Date; updated_at: Date; assigned: number | string }, permissions: string[]): RoleSummary {
  return { id: r.id, key: r.role_key, name: r.name, description: r.description, isSystem: Boolean(r.is_system), permissions: permissions.sort(), assignedCount: Number(r.assigned), createdAt: r.created_at, updatedAt: r.updated_at };
}

const ROLE_SELECT = `SELECT r.id, r.role_key, r.name, r.description, r.is_system, r.created_at, r.updated_at,
  (SELECT COUNT(*) FROM platform_admins a WHERE COALESCE(a.role_id, (SELECT x.id FROM rbac_roles x WHERE x.role_key = a.role)) = r.id) AS assigned
  FROM rbac_roles r`;

export async function listRoles(db: Queryable): Promise<RoleSummary[]> {
  const list = await rows<Parameters<typeof present>[0]>(db, `${ROLE_SELECT} ORDER BY r.is_system DESC, r.name`);
  const links = await rows<{ role_id: string; permission_id: string }>(db, 'SELECT role_id, permission_id FROM rbac_role_permissions');
  const byRole = new Map<string, string[]>();
  for (const l of links) byRole.set(l.role_id, [...(byRole.get(l.role_id) ?? []), l.permission_id]);
  return list.map((r) => present(r, byRole.get(r.id) ?? []));
}

export async function getRole(db: Queryable, roleId: string): Promise<RoleSummary> {
  const r = await one<Parameters<typeof present>[0]>(db, `${ROLE_SELECT} WHERE r.id = ?`, [roleId]);
  if (!r) throw notFound('Role');
  const perms = await rows<{ permission_id: string }>(db, 'SELECT permission_id FROM rbac_role_permissions WHERE role_id = ?', [roleId]);
  return present(r, perms.map((p) => p.permission_id));
}

/** Validates a requested permission set against the catalog and the grantor's own authority. */
export function assertGrantable(grantor: ReadonlySet<string>, requested: readonly string[]): string[] {
  const unique = [...new Set(requested)];
  const unknown = unique.filter((id) => !isKnownPermission(id));
  if (unknown.length) throw unprocessable('unknown_permission', `Unknown permission: ${unknown.join(', ')}`);
  const missing = escalation(grantor, unique);
  if (missing.length) throw forbidden('privilege_escalation', `You cannot grant permissions you do not hold: ${missing.join(', ')}`);
  return unique;
}

export async function createRole(db: Db, grantor: ReadonlySet<string>, input: { name: string; description: string; permissions: string[] }, createdBy: string): Promise<RoleSummary> {
  const permissions = assertGrantable(grantor, input.permissions);
  const id = newId();
  try {
    await tx(db, async (conn) => {
      await exec(conn, 'INSERT INTO rbac_roles (id, role_key, name, description, is_system, created_by) VALUES (?, ?, ?, ?, 0, ?)', [id, customRoleKey(input.name), input.name, input.description, createdBy]);
      for (const pid of permissions) await exec(conn, 'INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)', [id, pid]);
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('role_exists', 'A role with that name already exists.');
    throw err;
  }
  return getRole(db, id);
}

export async function updateRole(db: Db, grantor: ReadonlySet<string>, roleId: string, input: { name?: string | undefined; description?: string | undefined; permissions?: string[] | undefined }): Promise<{ before: RoleSummary; after: RoleSummary }> {
  const before = await getRole(db, roleId);
  if (before.isSystem) throw forbidden('system_role', 'Built-in roles cannot be modified. Duplicate the role to customise it.');
  // Escalation applies only to permissions being ADDED; an editor may keep or remove what they cannot hold.
  const added = input.permissions ? input.permissions.filter((p) => !before.permissions.includes(p)) : [];
  if (input.permissions) assertGrantable(new Set([...grantor, ...before.permissions]), input.permissions);
  assertGrantable(grantor, added);
  try {
    await tx(db, async (conn) => {
      await exec(conn, 'UPDATE rbac_roles SET name = COALESCE(?, name), description = COALESCE(?, description) WHERE id = ?', [input.name ?? null, input.description ?? null, roleId]);
      if (input.permissions) {
        await exec(conn, 'DELETE FROM rbac_role_permissions WHERE role_id = ?', [roleId]);
        for (const pid of new Set(input.permissions)) await exec(conn, 'INSERT INTO rbac_role_permissions (role_id, permission_id) VALUES (?, ?)', [roleId, pid]);
      }
    });
  } catch (err) {
    if (isDuplicateKey(err)) throw conflict('role_exists', 'A role with that name already exists.');
    throw err;
  }
  return { before, after: await getRole(db, roleId) };
}

export async function deleteRole(db: Db, roleId: string): Promise<RoleSummary> {
  const role = await getRole(db, roleId);
  if (role.isSystem) throw forbidden('system_role', 'Built-in roles cannot be deleted.');
  if (role.assignedCount > 0) throw conflict('role_in_use', `This role is assigned to ${role.assignedCount} administrator(s). Reassign them first.`);
  await exec(db, 'DELETE FROM rbac_roles WHERE id = ? AND is_system = 0', [roleId]);
  return role;
}

export async function activeSuperAdminCount(db: Queryable, excludeAdminId?: string): Promise<number> {
  const n = await one<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM platform_admins a JOIN rbac_roles r ON r.id = COALESCE(a.role_id, (SELECT x.id FROM rbac_roles x WHERE x.role_key = a.role))
      WHERE r.role_key = 'super_admin' AND a.status = 'active' AND a.id <> ?`,
    [excludeAdminId ?? ''],
  );
  return Number(n?.n ?? 0);
}

/** Assigns a role to a platform administrator, enforcing escalation limits and the last-super-admin rule. */
export async function assignAdminRole(db: Db, grantor: ReadonlySet<string>, adminId: string, roleId: string): Promise<{ before: string | null; after: RoleSummary }> {
  const role = await getRole(db, roleId);
  assertGrantable(grantor, role.permissions);
  const current = await loadAdminAuthority(db, adminId);
  if (!(await one(db, 'SELECT id FROM platform_admins WHERE id = ?', [adminId]))) throw notFound('Administrator');
  if (current.roleKey === 'super_admin' && role.key !== 'super_admin' && (await activeSuperAdminCount(db, adminId)) === 0) {
    throw new AppError(409, 'last_super_admin', 'At least one active Super Administrator must remain.');
  }
  const legacy = role.key === 'super_admin' || role.key === 'operations' || role.key === 'support' ? role.key : 'custom';
  await exec(db, 'UPDATE platform_admins SET role = ?, role_id = ? WHERE id = ?', [legacy, roleId, adminId]);
  return { before: current.roleKey, after: role };
}

export async function roleMembers(db: Queryable, roleId: string) {
  return rows<{ id: string; email: string; display_name: string; status: string }>(
    db,
    `SELECT a.id, a.login_email AS email, a.display_name, a.status FROM platform_admins a
      WHERE COALESCE(a.role_id, (SELECT x.id FROM rbac_roles x WHERE x.role_key = a.role)) = ? ORDER BY a.display_name`,
    [roleId],
  );
}

export { ALL_PERMISSION_IDS };
export type { PermissionId };
