import { z } from 'zod';
import { dateString } from './common.js';

export const goalStatus = z.enum(['ACTIVE', 'ACHIEVED', 'ARCHIVED']);

export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  targetDate: dateString.optional(),
  status: goalStatus.default('ACTIVE'),
});

export const updateGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    description: z.string().trim().max(2000).nullable(),
    targetDate: dateString.nullable(),
    status: goalStatus,
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export const createMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(200),
  dueDate: dateString.nullable().optional(),
  order: z.number().int().min(0).default(0),
});

export const updateMilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    done: z.boolean(),
    dueDate: dateString.nullable(),
    order: z.number().int().min(0),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export type CreateGoalInput = z.infer<typeof createGoalSchema>;
export type UpdateGoalInput = z.infer<typeof updateGoalSchema>;
export type CreateMilestoneInput = z.infer<typeof createMilestoneSchema>;
export type UpdateMilestoneInput = z.infer<typeof updateMilestoneSchema>;
