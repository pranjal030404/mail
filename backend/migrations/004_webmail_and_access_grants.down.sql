-- Safe rollback: this migration only added webmail/access-grant objects, so dropping them cannot
-- lose customer mail or message content (mail content lives in the mail engine, not MySQL).
-- Access-grant history is intentionally lost on rollback; export it first in production.
DROP TABLE IF EXISTS admin_access_grants;
DROP TABLE IF EXISTS mailbox_preferences;
DROP TABLE IF EXISTS mailbox_webmail_credentials;
