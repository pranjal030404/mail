import { z } from 'zod';
import { exec, rows, type Queryable } from '../../db/pool.js';

export const SettingsSchema = z.object({
  signup_mode: z.enum(['closed', 'invite_only', 'open']),
  maintenance_mode: z.boolean(),
  maintenance_message: z.string().max(500),
  default_plan_code: z.string().min(1).max(40),
  mailbox_deletion_grace_days: z.number().int().min(0).max(90),
  max_tenants_per_user: z.number().int().min(1).max(50),
  mailbox_creation_requires: z.enum(['ownership', 'ownership_and_mx']),
  terms_version: z.string().min(1).max(20),
});
export type PlatformSettings = z.infer<typeof SettingsSchema>;

const DEFAULTS: PlatformSettings = {
  signup_mode: 'open',
  maintenance_mode: false,
  maintenance_message: '',
  default_plan_code: 'free_pilot',
  mailbox_deletion_grace_days: 7,
  max_tenants_per_user: 3,
  mailbox_creation_requires: 'ownership',
  terms_version: '2026-10-draft',
};

let cache: { at: number; value: PlatformSettings } | null = null;
const CACHE_MS = 3000;

export function clearSettingsCache(): void {
  cache = null;
}

export async function getSettings(db: Queryable): Promise<PlatformSettings> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.value;
  const list = await rows<{ setting_key: string; setting_value: unknown }>(db, 'SELECT setting_key, setting_value FROM platform_settings');
  const merged: Record<string, unknown> = { ...DEFAULTS };
  for (const r of list) {
    if (r.setting_key in DEFAULTS) merged[r.setting_key] = r.setting_value; // mysql2 has already parsed the JSON column
  }
  const parsed = SettingsSchema.safeParse(merged);
  const value = parsed.success ? parsed.data : DEFAULTS;
  cache = { at: Date.now(), value };
  return value;
}

export async function updateSettings(db: Queryable, patch: Partial<PlatformSettings>, userId: string | null): Promise<PlatformSettings> {
  for (const [key, value] of Object.entries(patch)) {
    await exec(
      db,
      `INSERT INTO platform_settings (setting_key, setting_value, updated_by) VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value), updated_by = VALUES(updated_by)`,
      [key, JSON.stringify(value), userId],
    );
  }
  clearSettingsCache();
  return getSettings(db);
}
