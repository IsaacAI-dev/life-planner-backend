import { z } from 'zod';
import { id, timeString } from './common.js';

export const createRecurringSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  categoryId: id.optional(),
  rrule: z.string().trim().min(1).max(500), // validated semantically in the service
  startTime: timeString.optional(),
  endTime: timeString.optional(),
});

export const updateRecurringSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    categoryId: id.nullable(),
    rrule: z.string().trim().min(1).max(500),
    startTime: timeString.nullable(),
    endTime: timeString.nullable(),
    active: z.boolean(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export type CreateRecurringInput = z.infer<typeof createRecurringSchema>;
export type UpdateRecurringInput = z.infer<typeof updateRecurringSchema>;
