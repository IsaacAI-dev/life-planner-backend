import { z } from 'zod';

export const listNotificationsQuerySchema = z.object({
  cursor: z.string().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  unreadOnly: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
});

export const createNotificationSchema = z.object({
  userId: z.string().min(1),
  type: z.enum([
    'REMINDER',
    'COACH_REPLY',
    'SUPPORT_REPLY',
    'MEAL_PLAN_PUBLISHED',
    'MEAL_PLAN_REQUEST_UPDATE',
    'BOARD_SHARED',
    'PLAN_EXPIRING',
    'PLAN_EXPIRED',
    'PAYMENT_FAILED',
    'RECOMMENDATION',
    'FEEDBACK_REQUEST',
    'STREAK_MILESTONE',
  ]),
  title: z.string().trim().min(1).max(200),
  body: z.string().trim().max(1000).optional(),
  href: z.string().trim().max(300).optional(),
});
