import { z } from 'zod';
import { cuidString } from './common.js';

export const createReminderSchema = z.object({
  activityId: cuidString.optional().nullable(),
  remindAt: z.string().datetime({ offset: true }).or(z.string().datetime()),
  channel: z.enum(['EMAIL', 'PUSH']).default('EMAIL'),
  message: z.string().trim().max(500).optional(),
});

export const listRemindersQuerySchema = z.object({
  /// The activity detail dialog needs one activity's reminders, not the whole
  /// year's — filtering server-side keeps that request proportional.
  activityId: z.string().min(1).optional(),
  status: z.enum(['PENDING', 'SENT', 'CANCELLED', 'FAILED']).optional(),
});
