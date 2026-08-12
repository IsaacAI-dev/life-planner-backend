import { z } from 'zod';

/**
 * A suspension is temporary and explained: the person is shown the reason and
 * when it lifts, because the point is for them to come back.
 */
export const suspendUserSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  /// Defaults to a week. Omit `until` and pass days instead, or give a date.
  days: z.number().int().min(1).max(365).default(7).optional(),
  until: z.string().datetime().optional(),
});

/**
 * A ban is permanent and deliberately unexplained to the user. The reason is
 * recorded for staff and the moderation log, never shown to the account.
 */
export const banUserSchema = z.object({
  reason: z.string().trim().max(500).optional(),
});

export const moderationHistoryQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export const searchUsersQuerySchema = z.object({
  q: z.string().trim().min(1).max(120).optional(),
  status: z.enum(['ACTIVE', 'SUSPENDED', 'BANNED']).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export type SuspendUserInput = z.infer<typeof suspendUserSchema>;
export type SearchUsersQuery = z.infer<typeof searchUsersQuerySchema>;
