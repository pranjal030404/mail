-- Webmail proxy credentials, per-mailbox webmail preferences and audited operator access grants.

-- The control plane signs in to the mail engine's JMAP endpoint as the mailbox itself. It never
-- stores the customer's password; instead each mailbox gets one dedicated, revocable proxy
-- credential that exists only server-side and is encrypted at rest (AES-256-GCM).
CREATE TABLE mailbox_webmail_credentials (
  mailbox_id CHAR(26) NOT NULL PRIMARY KEY,
  engine_key_id VARCHAR(64) NOT NULL,
  secret_encrypted VARCHAR(512) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  rotated_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  CONSTRAINT fk_mwc_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE mailbox_preferences (
  mailbox_id CHAR(26) NOT NULL PRIMARY KEY,
  signature TEXT NULL,
  block_remote_images TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  CONSTRAINT fk_mp_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Exceptional mailbox access: an operator asks for temporary read access to one mailbox for a
-- documented reason. A different super admin must approve it; it expires quickly and every use is
-- audited. Ordinary admin privileges never grant message content access.
CREATE TABLE admin_access_grants (
  id CHAR(26) NOT NULL PRIMARY KEY,
  tenant_id CHAR(26) NOT NULL,
  mailbox_id CHAR(26) NOT NULL,
  requested_by CHAR(26) NOT NULL,
  approved_by CHAR(26) NULL,
  support_ticket_id CHAR(26) NULL,
  reason VARCHAR(500) NOT NULL,
  scope ENUM('read') NOT NULL DEFAULT 'read',
  status ENUM('pending_approval','active','denied','revoked','expired') NOT NULL DEFAULT 'pending_approval',
  requested_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  approved_at DATETIME(3) NULL,
  expires_at DATETIME(3) NULL,
  revoked_at DATETIME(3) NULL,
  last_used_at DATETIME(3) NULL,
  use_count INT UNSIGNED NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY ix_aag_status_expiry (status, expires_at),
  KEY ix_aag_mailbox (mailbox_id, status),
  KEY ix_aag_requester (requested_by, created_at),
  CONSTRAINT fk_aag_tenant FOREIGN KEY (tenant_id) REFERENCES tenants(id) ON DELETE CASCADE,
  CONSTRAINT fk_aag_mailbox FOREIGN KEY (mailbox_id) REFERENCES mailboxes(id) ON DELETE CASCADE,
  CONSTRAINT fk_aag_requester FOREIGN KEY (requested_by) REFERENCES platform_admins(id) ON DELETE RESTRICT,
  CONSTRAINT fk_aag_approver FOREIGN KEY (approved_by) REFERENCES platform_admins(id) ON DELETE RESTRICT,
  CONSTRAINT fk_aag_ticket FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id) ON DELETE SET NULL
) ENGINE=InnoDB;
