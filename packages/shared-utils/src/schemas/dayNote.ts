import { z } from 'zod';
import { dateString } from './common.js';

export const upsertDayNoteSchema = z.object({
  content: z.string().trim().max(5000),
  mood: z.number().int().min(1).max(5).nullable().optional(),
});

export const dateParamSchema = z.object({ date: dateString });

export type UpsertDayNoteInput = z.infer<typeof upsertDayNoteSchema>;
