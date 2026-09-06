import { z } from 'zod';
import { hexColor } from './common.js';

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: hexColor.default('#64748B'),
});

export const updateTagSchema = z
  .object({
    name: z.string().trim().min(1).max(40).optional(),
    color: hexColor.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Provide at least one field to update' });
