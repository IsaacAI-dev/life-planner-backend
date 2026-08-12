import { z } from 'zod';
import { booleanQuery, cuidString, dateString, timeString } from './common.js';

/** Fields shared by dated and flexible activities. */
export const baseActivityFields = {
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  categoryId: cuidString.optional().nullable(),
  goalId: cuidString.optional().nullable(),
  tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
};

// ---------------------------------------------------------------------------
// Dated activities (base spec) — each gains `isPrivate` per Addendum 2 §19.1
// ---------------------------------------------------------------------------

export const createActivitySchema = z.object({
  ...baseActivityFields,
  date: dateString,
  startTime: timeString.optional().nullable(),
  endTime: timeString.optional().nullable(),
  order: z.number().int().min(0).optional(),
  isPrivate: z.boolean().default(false),
});

export const updateActivitySchema = z
  .object({
    ...baseActivityFields,
    title: baseActivityFields.title.optional(),
    date: dateString.optional(),
    startTime: timeString.optional().nullable(),
    endTime: timeString.optional().nullable(),
    order: z.number().int().min(0).optional(),
    isDone: z.boolean().optional(),
    isPrivate: z.boolean().optional(),
    targetCount: z.number().int().min(1).max(100).optional(),
    windowStart: dateString.optional(),
    windowEnd: dateString.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const bulkCreateActivitySchema = z
  .object({
    ...baseActivityFields,
    rangeStart: dateString,
    rangeEnd: dateString,
    startTime: timeString.optional().nullable(),
    endTime: timeString.optional().nullable(),
    excludeWeekends: z.boolean().default(false),
    daysOfWeek: z.array(z.number().int().min(0).max(6)).min(1).max(7).optional(),
    batchTitle: z.string().trim().min(1).max(200).optional(),
    isPrivate: z.boolean().default(false),
  })
  .refine((v) => v.rangeEnd >= v.rangeStart, {
    message: 'rangeEnd must be on or after rangeStart',
    path: ['rangeEnd'],
  });

export const toggleActivitySchema = z.object({
  isDone: z.boolean().optional(),
});

export const reorderActivitiesSchema = z.object({
  date: dateString,
  orderedIds: z.array(cuidString).min(1).max(200),
});

// ---------------------------------------------------------------------------
// Flexible (non-date-specific) tasks — Addendum 2 §18.3 / §20
// ---------------------------------------------------------------------------

export const createFlexibleActivitySchema = z
  .object({
    ...baseActivityFields,
    isPrivate: z.boolean().default(false),
    windowStart: dateString,
    windowEnd: dateString,
    targetCount: z.number().int().min(1).max(100).default(1),
  })
  .refine((v) => v.windowEnd >= v.windowStart, {
    message: 'windowEnd must be on or after windowStart',
    path: ['windowEnd'],
  });

export const progressActivitySchema = z.object({
  increment: z.number().int().min(1).max(100).default(1),
});

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const listActivitiesQuerySchema = z
  .object({
    from: dateString.optional(),
    to: dateString.optional(),
    done: booleanQuery.optional(),
    categoryId: cuidString.optional(),
    goalId: cuidString.optional(),
    q: z.string().trim().min(1).max(120).optional(),
    /** Addendum 2: omit -> dated-only behavior unchanged for existing callers. */
    flexible: booleanQuery.optional(),
    /** Only meaningful with flexible=true: window contains this date. */
    activeOn: dateString.optional(),
  })
  .refine((v) => !v.from || !v.to || v.to >= v.from, {
    message: '`to` must be on or after `from`',
    path: ['to'],
  });

export type CreateActivityInput = z.infer<typeof createActivitySchema>;
export type UpdateActivityInput = z.infer<typeof updateActivitySchema>;
export type BulkCreateActivityInput = z.infer<typeof bulkCreateActivitySchema>;
export type CreateFlexibleActivityInput = z.infer<typeof createFlexibleActivitySchema>;
export type ProgressActivityInput = z.infer<typeof progressActivitySchema>;
export type ListActivitiesQuery = z.infer<typeof listActivitiesQuerySchema>;
