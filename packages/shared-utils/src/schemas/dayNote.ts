import { z } from 'zod';

export const upsertDayNoteSchema = z.object({
  content: z.string().trim().max(5000),
  mood: z.number().int().min(1).max(5).optional().nullable(),
});

export type UpsertDayNoteInput = z.infer<typeof upsertDayNoteSchema>;
