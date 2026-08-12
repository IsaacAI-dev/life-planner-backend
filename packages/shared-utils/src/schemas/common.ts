import { z } from 'zod';
import { DATE_ONLY_RE, TIME_RE } from '../date.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '../constants.js';

/** "YYYY-MM-DD" */
export const dateString = z
  .string()
  .regex(DATE_ONLY_RE, 'Expected a date in YYYY-MM-DD format');

/** "HH:mm" (24h) */
export const timeString = z.string().regex(TIME_RE, 'Expected a time in HH:mm format');

export const isoDateTimeString = z
  .string()
  .datetime({ offset: true })
  .or(z.string().datetime());

export const cuidString = z.string().min(1);

export const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/, 'Expected a hex color like #2563EB');

export const paginationQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(PAGE_SIZE_MAX).default(PAGE_SIZE_DEFAULT),
});

export const dateRangeQuerySchema = z.object({
  from: dateString,
  to: dateString,
}).refine((v) => v.to >= v.from, {
  message: '`to` must be on or after `from`',
  path: ['to'],
});

export const optionalDateRangeQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export const idParamSchema = z.object({ id: cuidString });

export const dateParamSchema = z.object({ date: dateString });

export const booleanQuery = z
  .union([z.boolean(), z.enum(['true', 'false', '1', '0'])])
  .transform((v) => v === true || v === 'true' || v === '1');

export type Pagination = z.infer<typeof paginationQuerySchema>;
export type DateRangeQuery = z.infer<typeof dateRangeQuerySchema>;
