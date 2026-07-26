import { z } from 'zod';
import { dateString } from './common.js';

export const statsRangeQuerySchema = z.object({
  from: dateString.optional(),
  to: dateString.optional(),
});

export type StatsRangeQuery = z.infer<typeof statsRangeQuerySchema>;
