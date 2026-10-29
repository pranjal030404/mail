-- Free-for-all defaults: open registration and a plainly free default plan.
UPDATE platform_settings SET setting_value = JSON_QUOTE('open') WHERE setting_key = 'signup_mode';
UPDATE plans SET name = 'Free', description = 'Free plan for companies and individuals. No SLA.' WHERE code = 'free_pilot';
UPDATE plans SET description = 'Free higher-limit plan. No SLA.' WHERE code = 'business';
