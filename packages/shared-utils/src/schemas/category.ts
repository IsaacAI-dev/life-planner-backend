import { z } from 'zod';
import { hexColor } from './common.js';

export const createCategorySchema = z.object({
  name: z.string().trim().min(1).max(60),
  color: hexColor,
  icon: z.string().trim().min(1).max(60).optional(),
});

export const updateCategorySchema = z
  .object({
    name: z.string().trim().min(1).max(60),
    color: hexColor,
    icon: z.string().trim().min(1).max(60).nullable(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, { message: 'No fields to update' });

export type CreateCategoryInput = z.infer<typeof createCategorySchema>;
export type UpdateCategoryInput = z.infer<typeof updateCategorySchema>;
