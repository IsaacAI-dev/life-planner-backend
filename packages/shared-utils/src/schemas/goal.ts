import { z } from 'zod';
import { dateString } from './common.js';

export const createGoalSchema = z.object({
  title: z.string().trim().min(1).max(200),
  description: z.string().trim().max(2000).optional(),
  targetDate: dateString.optional().nullable(),
  status: z.enum(['ACTIVE', 'ACHIEVED', 'ARCHIVED']).default('ACTIVE'),
});

export const updateGoalSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    description: z.string().trim().max(2000).optional().nullable(),
    targetDate: dateString.optional().nullable(),
    status: z.enum(['ACTIVE', 'ACHIEVED', 'ARCHIVED']).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export const listGoalsQuerySchema = z.object({
  status: z.enum(['ACTIVE', 'ACHIEVED', 'ARCHIVED']).optional(),
});

export const createMilestoneSchema = z.object({
  title: z.string().trim().min(1).max(200),
  dueDate: dateString.optional().nullable(),
  order: z.number().int().min(0).default(0),
});

export const updateMilestoneSchema = z
  .object({
    title: z.string().trim().min(1).max(200).optional(),
    dueDate: dateString.optional().nullable(),
    isDone: z.boolean().optional(),
    order: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
