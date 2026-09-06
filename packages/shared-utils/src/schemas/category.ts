import { z } from 'zod';
import { hexColor } from './common.js';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor.default('#6366F1'),
  icon: z.string().trim().max(40).optional().nullable(),
  order: z.number().int().min(0).optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(60).optional(),
    color: hexColor.optional(),
    icon: z.string().trim().max(40).optional().nullable(),
    order: z.number().int().min(0).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
