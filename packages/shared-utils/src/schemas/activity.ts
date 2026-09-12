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

// ---------------------------------------------------------------------------
// Batch editing — Addendum 5 §2
//
// These apply only to rows that came out of POST /activities/bulk, i.e. rows
// carrying a batchId. A one-off activity has no batch and is edited singly.
// ---------------------------------------------------------------------------

/**
 * Which rows in the batch an edit touches.
 *  ALL       — every remaining activity in the batch.
 *  UPCOMING  — those dated today or later, so past days keep their record.
 *  PENDING   — those not yet ticked off.
 * `activityIds` overrides the scope entirely when the client wants an explicit
 * subset it has already shown the person.
 */
export const batchScope = z.enum(['ALL', 'UPCOMING', 'PENDING']);

export const listActivityBatchesQuerySchema = z.object({
  /** Batches whose activities fall inside this window. Both or neither. */
  from: dateString.optional(),
  to: dateString.optional(),
  /** Include batches whose activities have all been deleted. */
  includeEmpty: booleanQuery.optional(),
});

const batchTargetFields = {
  scope: batchScope.default('ALL'),
  /** Only meaningful with scope UPCOMING; defaults to today. */
  fromDate: dateString.optional(),
  /** An explicit subset. Every id must belong to the batch. */
  activityIds: z.array(cuidString).min(1).max(366).optional(),
};

export const updateActivityBatchSchema = z
  .object({
    ...batchTargetFields,
    /** Renames the batch itself; independent of the activities' own titles. */
    batchTitle: z.string().trim().min(1).max(200).optional(),
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).nullable().optional(),
    categoryId: cuidString.nullable().optional(),
    goalId: cuidString.nullable().optional(),
    startTime: timeString.nullable().optional(),
    endTime: timeString.nullable().optional(),
    isPrivate: z.boolean().optional(),
    isDone: z.boolean().optional(),
    tags: z.array(z.string().trim().min(1).max(40)).max(20).optional(),
  })
  .refine(
    (v) =>
      [
        'batchTitle',
        'title',
        'description',
        'categoryId',
        'goalId',
        'startTime',
        'endTime',
        'isPrivate',
        'isDone',
        'tags',
      ].some((key) => v[key as keyof typeof v] !== undefined),
    { message: 'Provide at least one field to update' },
  );

/**
 * The same target fields, read from the query string of a DELETE. `activityIds`
 * accepts either repeated parameters or one comma-separated value, because
 * every HTTP client spells a list differently.
 */
export const deleteActivityBatchSchema = z.object({
  scope: batchScope.default('ALL'),
  fromDate: dateString.optional(),
  activityIds: z
    .preprocess(
      (v) => (typeof v === 'string' ? v.split(',').map((s) => s.trim()).filter(Boolean) : v),
      z.array(cuidString).min(1).max(366),
    )
    .optional(),
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
  increment: z.number().int().min(-1).max(100).default(1),
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
export type BatchScope = z.infer<typeof batchScope>;
export type UpdateActivityBatchInput = z.infer<typeof updateActivityBatchSchema>;
export type DeleteActivityBatchInput = z.infer<typeof deleteActivityBatchSchema>;
