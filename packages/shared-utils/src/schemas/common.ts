import { z } from 'zod';

/** Hex color like "#2563EB". */
export const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Must be a hex color, e.g. "#2563EB"');

/** Calendar day "YYYY-MM-DD". */
export const dateString = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be a date in YYYY-MM-DD format');

/** Time-of-day "HH:MM" (24h). */
export const timeString = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Must be a time in HH:MM format');

/** An id path/reference. Prisma cuids; kept permissive intentionally. */
export const id = z.string().min(1, 'id is required');

/** Days of week whitelist: 0=Sun .. 6=Sat. */
export const dayOfWeek = z.number().int().min(0).max(6);

export const idParam = z.object({ id });

/** Cursor/limit pagination shared by list endpoints. */
export const pagination = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type Pagination = z.infer<typeof pagination>;
