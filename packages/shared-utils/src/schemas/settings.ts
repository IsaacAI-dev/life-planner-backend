import { z } from 'zod';
import { id } from './common.js';

/**
 * Per-user settings document (§11). `.strict()` rejects unknown keys on write.
 * Each field's default produces the canonical default document used at signup.
 */
export const SettingsSchema = z
  .object({
    theme: z.enum(['system', 'light', 'dark']).default('system'),
    weekStartsOn: z.number().int().min(0).max(6).default(1), // 0=Sun, 1=Mon
    defaultCalendarView: z.enum(['day', 'week', 'month']).default('week'),
    excludeWeekendsByDefault: z.boolean().default(false),
    timezone: z.string().default('UTC'),
    defaultCategoryId: id.nullable().default(null),
    notifications: z
      .object({
        email: z.boolean().default(false),
        push: z.boolean().default(false),
        dailyReminderTime: z
          .string()
          .regex(/^\d{2}:\d{2}$/)
          .nullable()
          .default(null),
      })
      .default({}),
  })
  .strict();

/** PATCH allows a partial document; merged then re-validated against SettingsSchema. */
export const patchSettingsSchema = SettingsSchema.partial();

export type Settings = z.infer<typeof SettingsSchema>;
export type PatchSettingsInput = z.infer<typeof patchSettingsSchema>;

/** The canonical default settings document (all defaults applied). */
export const DEFAULT_SETTINGS: Settings = SettingsSchema.parse({});
