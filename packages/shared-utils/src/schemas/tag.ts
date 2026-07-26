import { z } from 'zod';
import { hexColor } from './common.js';

export const createTagSchema = z.object({
  name: z.string().trim().min(1).max(40),
  color: hexColor.optional(),
});

export type CreateTagInput = z.infer<typeof createTagSchema>;
