import { z } from 'zod';
import { dateString } from './common.js';

export const recordEventSchema = z.object({
  type: z.enum(['PAGE_VIEW', 'CUSTOM']).default('PAGE_VIEW'),
  path: z.string().trim().max(300).optional(),
  referrer: z.string().trim().max(300).optional(),
  sessionId: z.string().trim().max(100).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const analyticsRangeQuerySchema = z
  .object({ from: dateString, to: dateString })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export const analyticsPagesQuerySchema = z
  .object({
    from: dateString,
    to: dateString,
    limit: z.coerce.number().int().min(1).max(100).default(10),
  })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export const analyticsSignupsQuerySchema = z
  .object({
    from: dateString,
    to: dateString,
    granularity: z.enum(['day', 'week', 'month']).default('day'),
  })
  .refine((v) => v.to >= v.from, { message: '`to` must be on or after `from`', path: ['to'] });

export type RecordEventInput = z.infer<typeof recordEventSchema>;
