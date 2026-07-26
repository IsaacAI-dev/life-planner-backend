import {
  AppError,
  dayRangeInTimezone,
  type MessageUsage,
  type PublicSubscription,
  type SubscribeInput,
} from '@life-planner/shared-utils';
import { prisma, type Subscription } from '@life-planner/database';
import { env } from '../../env.js';
import { paymentProvider } from './provider.js';

const PERIOD_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

function toPublic(s: Subscription): PublicSubscription {
  return {
    plan: s.plan,
    status: s.status,
    currentPeriodStart: s.currentPeriodStart.toISOString(),
    currentPeriodEnd: s.currentPeriodEnd.toISOString(),
    cancelAtPeriodEnd: s.cancelAtPeriodEnd,
    canceledAt: s.canceledAt ? s.canceledAt.toISOString() : null,
  };
}

/** A subscription grants access while ACTIVE and within its paid period. */
export function isLive(s: Pick<Subscription, 'status' | 'currentPeriodEnd'> | null): boolean {
  return !!s && s.status === 'ACTIVE' && s.currentPeriodEnd > new Date();
}

/** Whether the user currently has assistant access beyond the free tier. */
export async function isSubscribed(userId: string): Promise<boolean> {
  const sub = await prisma.subscription.findUnique({
    where: { userId },
    select: { status: true, currentPeriodEnd: true },
  });
  return isLive(sub);
}

/** Count of the user's assistant messages sent today, in their timezone. */
export async function getDailyUsage(
  userId: string,
  timezone: string,
): Promise<MessageUsage> {
  const subscribed = await isSubscribed(userId);
  const { start, end } = dayRangeInTimezone(new Date(), timezone);
  const used = await prisma.message.count({
    where: {
      role: 'USER',
      deletedAt: null,
      createdAt: { gte: start, lt: end },
      conversation: { userId },
    },
  });
  const limit = env.FREE_DAILY_MESSAGE_LIMIT;
  // `subscribed` clients are not capped; `remaining` is still reported for display.
  return { used, limit, remaining: Math.max(0, limit - used), subscribed };
}

export async function getMySubscription(
  userId: string,
): Promise<{ subscription: PublicSubscription | null; usage: MessageUsage }> {
  const [sub, user] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.user.findUnique({ where: { id: userId }, select: { timezone: true } }),
  ]);
  const usage = await getDailyUsage(userId, user?.timezone ?? 'UTC');
  return { subscription: sub ? toPublic(sub) : null, usage };
}

/** Subscribe (or re-subscribe) via the mock provider; period runs now → +30d. */
export async function subscribe(
  userId: string,
  input: SubscribeInput,
): Promise<PublicSubscription> {
  const { providerRef } = await paymentProvider.createSubscription(userId, input.plan);
  const now = new Date();
  const periodEnd = new Date(now.getTime() + PERIOD_DAYS * MS_PER_DAY);

  const sub = await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      plan: input.plan,
      status: 'ACTIVE',
      provider: paymentProvider.name,
      providerRef,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
    update: {
      plan: input.plan,
      status: 'ACTIVE',
      provider: paymentProvider.name,
      providerRef,
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  });
  return toPublic(sub);
}

/** Cancel at period end: access continues until currentPeriodEnd, then lapses. */
export async function cancel(userId: string): Promise<PublicSubscription> {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub || sub.status !== 'ACTIVE') {
    throw AppError.notFound('No active subscription to cancel');
  }
  await paymentProvider.cancelSubscription(sub.providerRef);
  const updated = await prisma.subscription.update({
    where: { userId },
    data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
  });
  return toPublic(updated);
}
