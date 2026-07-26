import { z } from 'zod';
import { id } from './common.js';

export const reminderChannel = z.enum(['EMAIL', 'PUSH']);

export const createReminderSchema = z.object({
  activityId: id.optional(),
  remindAt: z.string().datetime({ message: 'remindAt must be an ISO 8601 datetime' }),
  channel: reminderChannel.default('PUSH'),
  message: z.string().trim().max(500).optional(),
});

export type CreateReminderInput = z.infer<typeof createReminderSchema>;
