import { z } from 'zod';
import { dateString, dayOfWeek, id, timeString } from './common.js';

const baseActivityFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  categoryId: id.optional(),
  goalId: id.optional(),
  startTime: timeString.optional(),
  endTime: timeString.optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
};

export const createActivitySchema = z.object({
  ...baseActivityFields,
  date: dateString,
});

export const bulkCreateActivitySchema = z
  .object({
    ...baseActivityFields,
    rangeStart: dateString,
    rangeEnd: dateString,
    excludeWeekends: z.boolean().default(false),
    daysOfWeek: z.array(dayOfWeek).min(1).max(7).optional(),
    batchTitle: z.string().trim().min(1).max(200).optional(),
  })
  .refine((v) => v.rangeEnd >= v.rangeStart, {
    message: 'rangeEnd must be on or after rangeStart',
    path: ['rangeEnd'],
  });

export const updateActivitySchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    categoryId: id.nullable(),
    goalId: id.nullable(),
    date: dateString,
    startTime: timeString.nullable(),
    endTime: timeString.nullable(),
    order: z.number().int().min(0),
    tags: z.array(z.string().trim().min(1).max(40)).max(20),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const toggleActivitySchema = z.object({
  isDone: z.boolean().optional(), // omit to flip
});

export const listActivitiesQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
  categoryId: id.optional(),
  goalId: id.optional(),
  tag: z.string().trim().min(1).max(40).optional(),
  done: z
    .enum(['true', 'false'])
    .transform((s) => s === 'true')
    .optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

export const reorderActivitiesSchema = z.object({
  date: dateString,
  orderedIds: z.array(id).min(1),
});

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type BulkCreateActivityInput = z.infer<typeof bulkCreateActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type ToggleActivityInput = z.infer<typeof toggleActivitySchema>;
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;
export type ReorderActivitiesInput = z.infer<typeof reorderActivitiesSchema>;
