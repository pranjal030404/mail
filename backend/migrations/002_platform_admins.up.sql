-- Platform administrators are a separate principal type: they are NOT tenant users.
-- Customer accounts stay in `users`; platform staff live in `platform_admins` with their own
-- credentials, MFA, sessions and audit attribution.

CREATE TABLE platform_admins (
  id CHAR(26) NOT NULL PRIMARY KEY,
  login_email VARCHAR(254) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('operations','super_admin') NOT NULL DEFAULT 'operations',
  status ENUM('pending_verification','active','suspended','closed') NOT NULL DEFAULT 'active',
  mfa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  locale VARCHAR(16) NOT NULL DEFAULT 'en',
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  suspended_reason VARCHAR(500) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_platform_admins_email (login_email),
  KEY ix_platform_admins_status (status)
) ENGINE=InnoDB;

-- Admin MFA lives in its own tables so no admin credential can ever be confused with a user's.
CREATE TABLE admin_mfa_credentials (
  id CHAR(26) NOT NULL PRIMARY KEY,
  admin_id CHAR(26) NOT NULL,
  type ENUM('totp') NOT NULL DEFAULT 'totp',
  secret_encrypted VARCHAR(512) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  last_used_step BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_admin_mfa_admin_type (admin_id, type),
  CONSTRAINT fk_admin_mfa_admin FOREIGN KEY (admin_id) REFERENCES platform_admins(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE admin_mfa_recovery_codes (
  id CHAR(26) NOT NULL PRIMARY KEY,
  admin_id CHAR(26) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_admin_mrc_hash (code_hash),
  KEY ix_admin_mrc_admin (admin_id, used_at),
  CONSTRAINT fk_admin_mrc_admin FOREIGN KEY (admin_id) REFERENCES platform_admins(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Sessions can now belong to a user OR a platform admin (never both).
ALTER TABLE sessions
  ADD COLUMN admin_id CHAR(26) NULL AFTER user_id,
  MODIFY COLUMN user_id CHAR(26) NULL,
  ADD KEY ix_sessions_admin (admin_id, revoked_at, expires_at),
  ADD CONSTRAINT fk_sessions_admin FOREIGN KEY (admin_id) REFERENCES platform_admins(id) ON DELETE CASCADE;

-- Audit attribution for platform staff is separate from customer users.
ALTER TABLE audit_logs
  ADD COLUMN actor_admin_id CHAR(26) NULL AFTER actor_user_id,
  ADD KEY ix_audit_actor_admin_time (actor_admin_id, occurred_at);

-- Staff replies on support tickets are attributed to an admin, not a user.
ALTER TABLE support_ticket_messages
  ADD COLUMN author_admin_id CHAR(26) NULL AFTER author_user_id,
  ADD KEY ix_stm_author_admin (author_admin_id),
  ADD CONSTRAINT fk_stm_author_admin FOREIGN KEY (author_admin_id) REFERENCES platform_admins(id) ON DELETE SET NULL;

-- ---- Migrate existing platform staff out of the users table.
INSERT INTO platform_admins (id, login_email, display_name, password_hash, role, status, mfa_enabled, timezone, locale, failed_login_count, locked_until, last_login_at, created_at, updated_at)
SELECT id, login_email, display_name, password_hash, platform_role, status, mfa_enabled, timezone, locale, failed_login_count, locked_until, last_login_at, created_at, updated_at
  FROM users WHERE platform_role <> 'none';

INSERT INTO admin_mfa_credentials (id, admin_id, type, secret_encrypted, confirmed_at, last_used_step, created_at)
SELECT mc.id, mc.user_id, mc.type, mc.secret_encrypted, mc.confirmed_at, mc.last_used_step, mc.created_at
  FROM mfa_credentials mc JOIN platform_admins a ON a.id = mc.user_id;

INSERT INTO admin_mfa_recovery_codes (id, admin_id, code_hash, used_at, created_at)
SELECT rc.id, rc.user_id, rc.code_hash, rc.used_at, rc.created_at
  FROM mfa_recovery_codes rc JOIN platform_admins a ON a.id = rc.user_id;

-- Re-point live sessions and history to the admin principal before deleting the user rows.
UPDATE sessions s JOIN platform_admins a ON a.id = s.user_id
   SET s.admin_id = s.user_id, s.user_id = NULL;
UPDATE audit_logs al JOIN platform_admins a ON a.id = al.actor_user_id
   SET al.actor_admin_id = al.actor_user_id, al.actor_user_id = NULL;
UPDATE support_ticket_messages m JOIN platform_admins a ON a.id = m.author_user_id
   SET m.author_admin_id = m.author_user_id, m.author_user_id = NULL;

-- Admin accounts must no longer exist as customers. Membership/notification/token rows cascade.
DELETE FROM users WHERE platform_role <> 'none';

-- Enforce separation at the schema level.
ALTER TABLE users DROP COLUMN platform_role;
