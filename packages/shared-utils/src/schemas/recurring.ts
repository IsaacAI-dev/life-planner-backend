import { z } from 'zod';
import { cuidString, timeString } from './common.js';

export const createRecurringSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  rrule: z.string().trim().min(3).max(500),
  startTime: timeString.optional().nullable(),
  endTime: timeString.optional().nullable(),
  categoryId: cuidString.optional().nullable(),
  isPrivate: z.boolean().default(false),
  active: z.boolean().default(true),
});

export const updateRecurringSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    rrule: z.string().trim().min(3).max(500).optional(),
    startTime: timeString.optional().nullable(),
    endTime: timeString.optional().nullable(),
    categoryId: cuidString.optional().nullable(),
    isPrivate: z.boolean().optional(),
    active: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
