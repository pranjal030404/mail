UPDATE platform_settings SET setting_value = JSON_QUOTE('invite_only') WHERE setting_key = 'signup_mode';
UPDATE plans SET name = 'Free pilot', description = 'Invite-only evaluation plan. No SLA. Strict limits.' WHERE code = 'free_pilot';
UPDATE plans SET description = 'Small-business plan (limits subject to capacity validation).' WHERE code = 'business';
