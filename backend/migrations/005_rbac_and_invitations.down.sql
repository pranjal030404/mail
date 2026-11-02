DROP TABLE IF EXISTS email_outbox;
DROP TABLE IF EXISTS account_invitations;
-- Admins on support/custom roles fall back to the lowest built-in role before the enum shrinks.
UPDATE platform_admins SET role = 'operations' WHERE role IN ('support','custom');
ALTER TABLE platform_admins
  DROP FOREIGN KEY fk_platform_admins_role,
  DROP KEY ix_platform_admins_role_id,
  DROP COLUMN role_id,
  MODIFY COLUMN role ENUM('operations','super_admin') NOT NULL DEFAULT 'operations';
DROP TABLE IF EXISTS rbac_role_permissions;
DROP TABLE IF EXISTS rbac_roles;
DROP TABLE IF EXISTS rbac_permissions;
