import { z } from 'zod';

export const subscriptionStatus = z.enum(['ACTIVE', 'CANCELED', 'EXPIRED']);

/** User-initiated subscribe (mock billing). Plan defaults to the assistant tier. */
export const subscribeSchema = z.object({
  plan: z.string().trim().min(1).max(60).default('ASSISTANT_UNLIMITED'),
});

/** Admin grant/extend a subscription for a user. */
export const grantSubscriptionSchema = z.object({
  plan: z.string().trim().min(1).max(60).default('ASSISTANT_UNLIMITED'),
  days: z.coerce.number().int().min(1).max(3650).default(30),
});

/** Admin list subscriptions, optionally filtered by status. */
export const listSubscriptionsQuerySchema = z.object({
  status: subscriptionStatus.optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().optional(),
});

export type SubscribeInput = z.infer<typeof subscribeSchema>;
export type GrantSubscriptionInput = z.infer<typeof grantSubscriptionSchema>;
export type ListSubscriptionsQuery = z.infer<typeof listSubscriptionsQuerySchema>;
