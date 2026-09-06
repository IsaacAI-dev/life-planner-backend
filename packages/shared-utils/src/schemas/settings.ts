import { z } from 'zod';
import { cuidString, timeString } from './common.js';

const notificationsSchema = z.object({
  email: z.boolean(),
  push: z.boolean(),
  dailyReminderTime: timeString.nullable(),
});

/** PUT replaces the whole document; unknown keys are rejected. */
export const replaceSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]),
    defaultCalendarView: z.enum(['day', 'week', 'month']),
    excludeWeekendsByDefault: z.boolean(),
    timezone: z.string().trim().min(1).max(64),
    defaultCategoryId: cuidString.nullable(),
    notifications: notificationsSchema,
    textScale: z.enum(['SMALL', 'DEFAULT', 'LARGE', 'LARGEST']),
    coachCheckInFrequency: z.enum(['OFF', 'DAILY', 'WEEKLY']),
  })
  .strict();

export const patchSettingsSchema = z
  .object({
    theme: z.enum(['light', 'dark', 'system']).optional(),
    weekStartsOn: z.union([z.literal(0), z.literal(1)]).optional(),
    defaultCalendarView: z.enum(['day', 'week', 'month']).optional(),
    excludeWeekendsByDefault: z.boolean().optional(),
    timezone: z.string().trim().min(1).max(64).optional(),
    defaultCategoryId: cuidString.nullable().optional(),
    notifications: notificationsSchema.partial().optional(),
    textScale: z.enum(['SMALL', 'DEFAULT', 'LARGE', 'LARGEST']).optional(),
    coachCheckInFrequency: z.enum(['OFF', 'DAILY', 'WEEKLY']).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
