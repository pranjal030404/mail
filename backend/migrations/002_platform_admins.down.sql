-- Roll back the platform-admin split. Best effort: re-creates customer rows for admins.
ALTER TABLE users ADD COLUMN platform_role ENUM('none','operations','super_admin') NOT NULL DEFAULT 'none' AFTER status,
  ADD KEY ix_users_platform_role (platform_role);

INSERT IGNORE INTO users (id, login_email, display_name, password_hash, status, platform_role, mfa_enabled, timezone, locale, failed_login_count, locked_until, last_login_at, created_at, updated_at)
SELECT id, login_email, display_name, password_hash, status, role, mfa_enabled, timezone, locale, failed_login_count, locked_until, last_login_at, created_at, updated_at
  FROM platform_admins;

INSERT IGNORE INTO mfa_credentials (id, user_id, type, secret_encrypted, confirmed_at, last_used_step, created_at)
SELECT id, admin_id, type, secret_encrypted, confirmed_at, last_used_step, created_at FROM admin_mfa_credentials;

INSERT IGNORE INTO mfa_recovery_codes (id, user_id, code_hash, used_at, created_at)
SELECT id, admin_id, code_hash, used_at, created_at FROM admin_mfa_recovery_codes;

UPDATE sessions SET user_id = admin_id, admin_id = NULL WHERE admin_id IS NOT NULL;
UPDATE audit_logs SET actor_user_id = actor_admin_id, actor_admin_id = NULL WHERE actor_admin_id IS NOT NULL;
UPDATE support_ticket_messages SET author_user_id = author_admin_id, author_admin_id = NULL WHERE author_admin_id IS NOT NULL;

ALTER TABLE support_ticket_messages
  DROP FOREIGN KEY fk_stm_author_admin,
  DROP KEY ix_stm_author_admin,
  DROP COLUMN author_admin_id;

ALTER TABLE audit_logs
  DROP KEY ix_audit_actor_admin_time,
  DROP COLUMN actor_admin_id;

ALTER TABLE sessions
  DROP FOREIGN KEY fk_sessions_admin,
  DROP KEY ix_sessions_admin,
  DROP COLUMN admin_id,
  MODIFY COLUMN user_id CHAR(26) NOT NULL;

DROP TABLE IF EXISTS admin_mfa_recovery_codes;
DROP TABLE IF EXISTS admin_mfa_credentials;
DROP TABLE IF EXISTS platform_admins;
