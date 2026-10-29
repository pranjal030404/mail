-- ARTHVEX Email Hosting — initial schema (MySQL 8.x, InnoDB, utf8mb4).
-- All timestamps are UTC DATETIME(3); the application connection uses time_zone '+00:00'.
-- Primary keys for tenant-visible entities are opaque 26-character ULIDs (CHAR(26)).
-- Mailbox passwords, message bodies, attachments and private DKIM keys are never stored here.

CREATE TABLE plans (
  id CHAR(26) NOT NULL PRIMARY KEY,
  code VARCHAR(40) NOT NULL,
  name VARCHAR(100) NOT NULL,
  description VARCHAR(500) NULL,
  is_public TINYINT(1) NOT NULL DEFAULT 1,
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  max_domains INT UNSIGNED NOT NULL,
  max_mailboxes INT UNSIGNED NOT NULL,
  max_mailboxes_per_domain INT UNSIGNED NOT NULL,
  max_aliases INT UNSIGNED NOT NULL,
  mailbox_quota_default_bytes BIGINT UNSIGNED NOT NULL,
  mailbox_quota_max_bytes BIGINT UNSIGNED NOT NULL,
  tenant_storage_max_bytes BIGINT UNSIGNED NOT NULL,
  attachment_max_bytes BIGINT UNSIGNED NOT NULL,
  daily_send_limit INT UNSIGNED NOT NULL,
  hourly_send_limit INT UNSIGNED NOT NULL,
  allow_external_forwarding TINYINT(1) NOT NULL DEFAULT 0,
  allow_catch_all TINYINT(1) NOT NULL DEFAULT 0,
  warn_thresholds JSON NOT NULL,
  support_level VARCHAR(40) NOT NULL DEFAULT 'community',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_plans_code (code)
) ENGINE=InnoDB;

CREATE TABLE users (
  id CHAR(26) NOT NULL PRIMARY KEY,
  login_email VARCHAR(254) NOT NULL,
  display_name VARCHAR(120) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  status ENUM('pending_verification','active','suspended','closed') NOT NULL DEFAULT 'pending_verification',
  platform_role ENUM('none','operations','super_admin') NOT NULL DEFAULT 'none',
  email_verified_at DATETIME(3) NULL,
  mfa_enabled TINYINT(1) NOT NULL DEFAULT 0,
  timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
  locale VARCHAR(16) NOT NULL DEFAULT 'en',
  failed_login_count INT UNSIGNED NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  last_login_at DATETIME(3) NULL,
  suspended_reason VARCHAR(500) NULL,
  deletion_requested_at DATETIME(3) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_users_login_email (login_email),
  KEY ix_users_status (status),
  KEY ix_users_platform_role (platform_role)
) ENGINE=InnoDB;

CREATE TABLE tenants (
  id CHAR(26) NOT NULL PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  slug VARCHAR(80) NOT NULL,
  status ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  plan_id CHAR(26) NOT NULL,
  suspended_reason VARCHAR(500) NULL,
  suspended_at DATETIME(3) NULL,
  closure_requested_at DATETIME(3) NULL,
  created_by CHAR(26) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tenants_slug (slug),
  KEY ix_tenants_status (status),
  CONSTRAINT fk_tenants_plan FOREIGN KEY (plan_id) REFERENCES plans(id),
  CONSTRAINT fk_tenants_created_by FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE tenant_quotas (
  tenant_id CHAR(26) NOT NULL PRIMARY KEY,
  max_domains INT UNSIGNED NULL,
  max_mailboxes INT UNSIGNED NULL,
  max_mailboxes_per_domain INT UNSIGNED NULL,
  max_aliases INT UNSIGNED NULL,
  mailbox_quota_max_bytes BIGINT UNSIGNED NULL,
  tenant_storage_max_bytes BIGINT UNSIGNED NULL,
  attachment_max_bytes BIGINT UNSIGNED NULL,
  daily_send_limit INT UNSIGNED NULL,
  hourly_send_limit INT UNSIGNED NULL,
  allow_external_forwarding TINYINT(1) NULL,
  allow_catch_all TINYINT(1) NULL,
  reason VARCHAR(500) NULL,
  updated_by CHAR(26) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_tenant_quotas_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE subscriptions (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  plan_id CHAR(26) NOT NULL,
  status ENUM('trialing','active','past_due','cancelled','expired') NOT NULL DEFAULT 'active',
  started_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  trial_ends_at DATETIME(3) NULL,
  current_period_end DATETIME(3) NULL,
  cancelled_at DATETIME(3) NULL,
  billing_reference VARCHAR(120) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_subscriptions_tenant (tenant_id, status),
  CONSTRAINT fk_subscriptions_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_subscriptions_plan FOREIGN KEY (plan_id) REFERENCES plans(id)
) ENGINE=InnoDB;

CREATE TABLE sessions (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  mfa_verified TINYINT(1) NOT NULL DEFAULT 0,
  mfa_pending TINYINT(1) NOT NULL DEFAULT 0,
  ip VARCHAR(45) NULL,
  user_agent VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  revoked_reason VARCHAR(100) NULL,
  UNIQUE KEY uq_sessions_token_hash (token_hash),
  KEY ix_sessions_user (user_id, revoked_at, expires_at),
  CONSTRAINT fk_sessions_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE email_verification_tokens (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_evt_hash (token_hash),
  KEY ix_evt_user (user_id),
  CONSTRAINT fk_evt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_reset_tokens (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  requested_ip VARCHAR(45) NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_prt_hash (token_hash),
  KEY ix_prt_user (user_id),
  CONSTRAINT fk_prt_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- TOTP secrets are encrypted at rest with APP_ENCRYPTION_KEY (AES-256-GCM).
CREATE TABLE mfa_credentials (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  type ENUM('totp') NOT NULL DEFAULT 'totp',
  secret_encrypted VARCHAR(512) NOT NULL,
  confirmed_at DATETIME(3) NULL,
  last_used_step BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mfa_user_type (user_id, type),
  CONSTRAINT fk_mfa_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE mfa_recovery_codes (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  code_hash CHAR(64) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mrc_hash (code_hash),
  KEY ix_mrc_user (user_id),
  CONSTRAINT fk_mrc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE domains (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  name VARCHAR(253) NOT NULL,
  unicode_name VARCHAR(253) NOT NULL,
  -- Set to the name while the domain is claimed; NULL once removed so the name can be claimed again.
  claim_name VARCHAR(253) NULL,
  status ENUM('pending_verification','verified','active','suspended','removal_scheduled','removed') NOT NULL DEFAULT 'pending_verification',
  ownership_status ENUM('pending','verified','failed','expired') NOT NULL DEFAULT 'pending',
  inbound_status ENUM('unknown','ok','warning','error') NOT NULL DEFAULT 'unknown',
  outbound_status ENUM('unknown','ok','warning','error') NOT NULL DEFAULT 'unknown',
  provisioning_status ENUM('not_started','provisioning','ready','failed','removing','removed') NOT NULL DEFAULT 'not_started',
  mail_engine_domain_id VARCHAR(64) NULL,
  expected_records JSON NULL,
  expected_records_at DATETIME(3) NULL,
  catch_all_mailbox_id CHAR(26) NULL,
  verified_at DATETIME(3) NULL,
  last_dns_check_at DATETIME(3) NULL,
  suspended_reason VARCHAR(500) NULL,
  removed_at DATETIME(3) NULL,
  created_by CHAR(26) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_domains_claim_name (claim_name),
  KEY ix_domains_tenant_status (tenant_id, status),
  KEY ix_domains_name (name),
  KEY ix_domains_dns_check (status, last_dns_check_at),
  CONSTRAINT fk_domains_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

-- The ownership token is published publicly in DNS; we keep a hash for matching and an
-- encrypted copy so the customer can view the instruction again.
CREATE TABLE domain_verification_tokens (
  id CHAR(26) NOT NULL PRIMARY KEY,
  domain_id CHAR(26) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  token_encrypted VARCHAR(512) NOT NULL,
  status ENUM('active','used','rotated','expired') NOT NULL DEFAULT 'active',
  expires_at DATETIME(3) NOT NULL,
  verified_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_dvt_domain (domain_id, status),
  CONSTRAINT fk_dvt_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE domain_dns_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  domain_id CHAR(26) NOT NULL,
  check_type ENUM('ownership','mx','spf','dkim','dmarc','mail_host','ptr') NOT NULL,
  record_name VARCHAR(255) NOT NULL,
  expected_value TEXT NULL,
  observed_value TEXT NULL,
  status ENUM('pass','warning','fail','error','pending') NOT NULL,
  message VARCHAR(500) NULL,
  checked_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ddc_domain_type_time (domain_id, check_type, checked_at),
  CONSTRAINT fk_ddc_domain FOREIGN KEY (domain_id) REFERENCES domains(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Global namespace for hosted addresses (mailboxes and aliases share it).
CREATE TABLE address_claims (
  address VARCHAR(320) NOT NULL PRIMARY KEY,
  kind ENUM('mailbox','alias') NOT NULL,
  owner_id CHAR(26) NOT NULL,
  tenant_id CHAR(26) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_address_claims_owner (owner_id),
  CONSTRAINT fk_address_claims_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE mailboxes (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  domain_id CHAR(26) NOT NULL,
  local_part VARCHAR(64) NOT NULL,
  normalized_address VARCHAR(320) NOT NULL,
  claim_address VARCHAR(320) NULL,
  display_name VARCHAR(120) NULL,
  quota_bytes BIGINT UNSIGNED NOT NULL,
  status ENUM('draft','provisioning','provisioning_failed','active','suspended','deletion_scheduled','deleting','deleted','retained') NOT NULL DEFAULT 'draft',
  status_before_deletion ENUM('active','suspended') NULL,
  mail_engine_account_id VARCHAR(64) NULL,
  used_bytes BIGINT UNSIGNED NULL,
  usage_collected_at DATETIME(3) NULL,
  credentials_set_at DATETIME(3) NULL,
  suspended_reason VARCHAR(500) NULL,
  suspended_by ENUM('tenant','platform','tenant_suspension') NULL,
  deletion_scheduled_for DATETIME(3) NULL,
  deleted_at DATETIME(3) NULL,
  created_by CHAR(26) NULL,
  is_demo TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_mailboxes_claim_address (claim_address),
  KEY ix_mailboxes_tenant_status (tenant_id, status),
  KEY ix_mailboxes_domain_status (domain_id, status),
  KEY ix_mailboxes_address (normalized_address),
  KEY ix_mailboxes_deletion (status, deletion_scheduled_for),
  KEY ix_mailboxes_created (tenant_id, created_at),
  CONSTRAINT fk_mailboxes_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_mailboxes_domain FOREIGN KEY (domain_id) REFERENCES domains(id)
) ENGINE=InnoDB;

ALTER TABLE domains ADD CONSTRAINT fk_domains_catch_all FOREIGN KEY (catch_all_mailbox_id) REFERENCES mailboxes(id) ON DELETE SET NULL;

CREATE TABLE tenant_memberships (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  user_id CHAR(26) NULL,
  invited_email VARCHAR(254) NULL,
  role ENUM('owner','admin','mailbox_user','billing') NOT NULL,
  status ENUM('invited','active','revoked') NOT NULL DEFAULT 'active',
  mailbox_id CHAR(26) NULL,
  invitation_token_hash CHAR(64) NULL,
  invitation_expires_at DATETIME(3) NULL,
  invited_by CHAR(26) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tm_tenant_user (tenant_id, user_id),
  UNIQUE KEY uq_tm_invitation_token (invitation_token_hash),
  KEY ix_tm_user (user_id, status),
  KEY ix_tm_tenant_status (tenant_id, status),
  CONSTRAINT fk_tm_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_tm_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE aliases (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  domain_id CHAR(26) NOT NULL,
  local_part VARCHAR(64) NOT NULL,
  source_address VARCHAR(320) NOT NULL,
  claim_address VARCHAR(320) NULL,
  destination_type ENUM('mailbox','external') NOT NULL,
  destination_mailbox_id CHAR(26) NULL,
  destination_address VARCHAR(320) NOT NULL,
  status ENUM('pending_confirmation','provisioning','active','disabled','failed','deleting','deleted') NOT NULL DEFAULT 'provisioning',
  forwarding_token_hash CHAR(64) NULL,
  forwarding_token_expires_at DATETIME(3) NULL,
  forwarding_confirmed_at DATETIME(3) NULL,
  mail_engine_ref VARCHAR(64) NULL,
  created_by CHAR(26) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_aliases_claim_address (claim_address),
  UNIQUE KEY uq_aliases_forwarding_token (forwarding_token_hash),
  KEY ix_aliases_tenant_status (tenant_id, status),
  KEY ix_aliases_domain (domain_id, status),
  KEY ix_aliases_destination_mailbox (destination_mailbox_id),
  CONSTRAINT fk_aliases_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  CONSTRAINT fk_aliases_domain FOREIGN KEY (domain_id) REFERENCES domains(id),
  CONSTRAINT fk_aliases_mailbox FOREIGN KEY (destination_mailbox_id) REFERENCES mailboxes(id)
) ENGINE=InnoDB;

CREATE TABLE provisioning_jobs (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NULL,
  operation VARCHAR(64) NOT NULL,
  target_type ENUM('domain','mailbox','alias','tenant','platform') NOT NULL,
  target_id CHAR(26) NULL,
  idempotency_key VARCHAR(191) NOT NULL,
  -- Never contains secrets (passwords, keys, tokens).
  payload JSON NULL,
  status ENUM('queued','running','succeeded','retrying','failed','needs_manual_review','cancelled') NOT NULL DEFAULT 'queued',
  attempts INT UNSIGNED NOT NULL DEFAULT 0,
  max_attempts INT UNSIGNED NOT NULL DEFAULT 6,
  needs_reconcile TINYINT(1) NOT NULL DEFAULT 0,
  run_after DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  locked_by VARCHAR(100) NULL,
  locked_until DATETIME(3) NULL,
  last_error_code VARCHAR(64) NULL,
  last_error_message VARCHAR(500) NULL,
  result JSON NULL,
  created_by CHAR(26) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  started_at DATETIME(3) NULL,
  completed_at DATETIME(3) NULL,
  UNIQUE KEY uq_jobs_idempotency (idempotency_key),
  KEY ix_jobs_claim (status, run_after),
  KEY ix_jobs_lease (status, locked_until),
  KEY ix_jobs_tenant (tenant_id, created_at),
  KEY ix_jobs_target (target_type, target_id),
  CONSTRAINT fk_jobs_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id)
) ENGINE=InnoDB;

CREATE TABLE usage_daily (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  mailbox_id CHAR(26) NULL,
  scope_key VARCHAR(40) NOT NULL,
  usage_date DATE NOT NULL,
  storage_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  quota_bytes BIGINT UNSIGNED NOT NULL DEFAULT 0,
  mailbox_count INT UNSIGNED NULL,
  messages_sent INT UNSIGNED NULL,
  messages_received INT UNSIGNED NULL,
  collected_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_usage_scope_date (scope_key, usage_date),
  KEY ix_usage_tenant_date (tenant_id, usage_date),
  CONSTRAINT fk_usage_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_usage_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_type ENUM('user','platform_admin','system','worker','anonymous') NOT NULL,
  actor_user_id CHAR(26) NULL,
  tenant_id CHAR(26) NULL,
  action VARCHAR(100) NOT NULL,
  target_type VARCHAR(40) NULL,
  target_id VARCHAR(64) NULL,
  outcome ENUM('success','failure','denied') NOT NULL,
  reason VARCHAR(500) NULL,
  correlation_id VARCHAR(64) NULL,
  ip VARCHAR(45) NULL,
  metadata JSON NULL,
  KEY ix_audit_tenant_time (tenant_id, occurred_at),
  KEY ix_audit_actor_time (actor_user_id, occurred_at),
  KEY ix_audit_action_time (action, occurred_at),
  KEY ix_audit_target (target_type, target_id)
) ENGINE=InnoDB;

CREATE TABLE abuse_reports (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NULL,
  domain_id CHAR(26) NULL,
  mailbox_id CHAR(26) NULL,
  reported_address VARCHAR(320) NULL,
  reporter_email VARCHAR(254) NULL,
  reporter_user_id CHAR(26) NULL,
  source ENUM('public_form','customer','staff','automated') NOT NULL DEFAULT 'public_form',
  category ENUM('spam','phishing','malware','compromised_account','unusual_sending','other') NOT NULL,
  severity ENUM('low','medium','high','critical') NOT NULL DEFAULT 'medium',
  status ENUM('open','investigating','actioned','dismissed','closed') NOT NULL DEFAULT 'open',
  summary TEXT NOT NULL,
  -- Restricted: visible to platform staff only. Keep evidence minimal.
  investigation_notes TEXT NULL,
  assigned_to CHAR(26) NULL,
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_abuse_status (status, severity, created_at),
  KEY ix_abuse_tenant (tenant_id),
  CONSTRAINT fk_abuse_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE support_tickets (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  requester_user_id CHAR(26) NULL,
  category ENUM('dns','mailbox','delivery','client_setup','account','billing','abuse','other') NOT NULL,
  urgency ENUM('low','normal','high','urgent') NOT NULL DEFAULT 'normal',
  subject VARCHAR(200) NOT NULL,
  status ENUM('open','awaiting_customer','awaiting_support','resolved','closed') NOT NULL DEFAULT 'open',
  assigned_team VARCHAR(40) NOT NULL DEFAULT 'support',
  domain_id CHAR(26) NULL,
  mailbox_id CHAR(26) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_tickets_tenant (tenant_id, status),
  KEY ix_tickets_status (status, urgency),
  CONSTRAINT fk_tickets_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_tickets_requester FOREIGN KEY (requester_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE support_ticket_messages (
  id CHAR(26) NOT NULL PRIMARY KEY,
  ticket_id CHAR(26) NOT NULL,
  author_user_id CHAR(26) NULL,
  is_staff TINYINT(1) NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_stm_ticket (ticket_id, created_at),
  CONSTRAINT fk_stm_ticket FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE,
  CONSTRAINT fk_stm_author FOREIGN KEY (author_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE notifications (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  tenant_id CHAR(26) NULL,
  type VARCHAR(60) NOT NULL,
  severity ENUM('info','warning','critical') NOT NULL DEFAULT 'info',
  title VARCHAR(200) NOT NULL,
  body VARCHAR(1000) NOT NULL,
  link VARCHAR(255) NULL,
  dedupe_key VARCHAR(191) NULL,
  read_at DATETIME(3) NULL,
  emailed_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_notifications_dedupe (user_id, dedupe_key),
  KEY ix_notifications_user (user_id, read_at, created_at),
  CONSTRAINT fk_notifications_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_notifications_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE notification_preferences (
  user_id CHAR(26) NOT NULL PRIMARY KEY,
  email_quota_warnings TINYINT(1) NOT NULL DEFAULT 1,
  email_dns_alerts TINYINT(1) NOT NULL DEFAULT 1,
  email_product_updates TINYINT(1) NOT NULL DEFAULT 0,
  email_maintenance TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_np_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE terms_acceptances (
  id CHAR(26) NOT NULL PRIMARY KEY,
  user_id CHAR(26) NOT NULL,
  tenant_id CHAR(26) NULL,
  document ENUM('terms','privacy','aup') NOT NULL,
  version VARCHAR(20) NOT NULL,
  ip VARCHAR(45) NULL,
  accepted_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY ix_ta_user (user_id, document),
  CONSTRAINT fk_ta_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  CONSTRAINT fk_ta_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE signup_invitations (
  id CHAR(26) NOT NULL PRIMARY KEY,
  email VARCHAR(254) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  created_by CHAR(26) NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_si_hash (token_hash),
  KEY ix_si_email (email),
  CONSTRAINT fk_si_creator FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE platform_settings (
  setting_key VARCHAR(80) NOT NULL PRIMARY KEY,
  setting_value JSON NOT NULL,
  updated_by CHAR(26) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE worker_heartbeats (
  worker_id VARCHAR(100) NOT NULL PRIMARY KEY,
  started_at DATETIME(3) NOT NULL,
  last_seen_at DATETIME(3) NOT NULL,
  jobs_processed INT UNSIGNED NOT NULL DEFAULT 0,
  version VARCHAR(40) NULL
) ENGINE=InnoDB;

CREATE TABLE backup_runs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('backup','restore_test') NOT NULL,
  scope VARCHAR(80) NOT NULL,
  status ENUM('running','succeeded','failed') NOT NULL,
  started_at DATETIME(3) NOT NULL,
  finished_at DATETIME(3) NULL,
  size_bytes BIGINT UNSIGNED NULL,
  location_label VARCHAR(255) NULL,
  message VARCHAR(500) NULL,
  KEY ix_backup_runs_time (kind, started_at)
) ENGINE=InnoDB;

-- Default plan catalogue (initial private-beta defaults; configurable by platform admins).
INSERT INTO plans (id, code, name, description, is_public, max_domains, max_mailboxes, max_mailboxes_per_domain, max_aliases,
  mailbox_quota_default_bytes, mailbox_quota_max_bytes, tenant_storage_max_bytes, attachment_max_bytes,
  daily_send_limit, hourly_send_limit, allow_external_forwarding, allow_catch_all, warn_thresholds, support_level)
VALUES
  ('01JPLANFREEPILOT0000000000', 'free_pilot', 'Free pilot', 'Invite-only evaluation plan. No SLA. Strict limits.', 1,
    1, 2, 2, 5, 104857600, 262144000, 524288000, 10485760, 100, 20, 0, 0, JSON_ARRAY(75, 90, 100), 'community'),
  ('01JPLANBUSINESS00000000000', 'business', 'Business', 'Small-business plan (limits subject to capacity validation).', 1,
    3, 25, 25, 50, 1073741824, 5368709120, 26843545600, 26214400, 1000, 200, 1, 1, JSON_ARRAY(75, 90, 100), 'standard');

INSERT INTO platform_settings (setting_key, setting_value) VALUES
  ('signup_mode', JSON_QUOTE('invite_only')),
  ('maintenance_mode', 'false'),
  ('maintenance_message', JSON_QUOTE('')),
  ('default_plan_code', JSON_QUOTE('free_pilot')),
  ('mailbox_deletion_grace_days', '7'),
  ('max_tenants_per_user', '3'),
  ('mailbox_creation_requires', JSON_QUOTE('ownership')),
  ('terms_version', JSON_QUOTE('2026-10-draft'));
