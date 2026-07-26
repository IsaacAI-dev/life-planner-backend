import { z } from 'zod';

const boolFlag = z.enum(['true', 'false']).transform((s) => s === 'true');

/** Admin: list/search users with filtering, sorting, and cursor pagination. */
export const listUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(200).optional(),
  suspended: boolFlag.optional(),
  subscribed: boolFlag.optional(),
  createdFrom: z.string().datetime().optional(),
  createdTo: z.string().datetime().optional(),
  sort: z.enum(['createdAt', 'email', 'name']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

/** Admin: suspend a user. `until` null/omitted = indefinite. */
export const suspendUserSchema = z.object({
  until: z.string().datetime().optional(),
  reason: z.string().trim().max(500).optional(),
});

/** Admin: analytics overview, optional date range + bucket interval for the series. */
export const analyticsQuerySchema = z.object({
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  interval: z.enum(['day', 'week', 'month']).default('day'),
});

export type ListUsersQuery = z.infer<typeof listUsersQuerySchema>;
export type SuspendUserInput = z.infer<typeof suspendUserSchema>;
export type AnalyticsQuery = z.infer<typeof analyticsQuerySchema>;
