import {
  AppError,
  type GrantSubscriptionInput,
  type ListSubscriptionsQuery,
  type PublicSubscription,
} from '@life-planner/shared-utils';
import { prisma, type Subscription } from '@life-planner/database';

const DAY_MS = 24 * 60 * 60 * 1000;

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

/** List subscriptions (optionally by status) with the owning user, cursor-paginated. */
export async function listSubscriptions(q: ListSubscriptionsQuery) {
  const rows = await prisma.subscription.findMany({
    where: q.status ? { status: q.status } : {},
    orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
    take: q.limit + 1,
    ...(q.cursor ? { cursor: { id: q.cursor }, skip: 1 } : {}),
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  const hasMore = rows.length > q.limit;
  const page = hasMore ? rows.slice(0, q.limit) : rows;

  return {
    items: page.map((s) => ({ ...toPublic(s), user: s.user })),
    nextCursor: hasMore ? (page[page.length - 1]?.id ?? null) : null,
  };
}

/** Admin grant/extend a subscription for a user (manual, no payment provider). */
export async function grant(userId: string, input: GrantSubscriptionInput): Promise<PublicSubscription> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!user) throw AppError.notFound('User not found');

  const now = new Date();
  const periodEnd = new Date(now.getTime() + input.days * DAY_MS);
  const sub = await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      plan: input.plan,
      status: 'ACTIVE',
      provider: 'admin',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
    },
    update: {
      plan: input.plan,
      status: 'ACTIVE',
      provider: 'admin',
      currentPeriodStart: now,
      currentPeriodEnd: periodEnd,
      cancelAtPeriodEnd: false,
      canceledAt: null,
    },
  });
  return toPublic(sub);
}

/** Admin revoke a subscription immediately. */
export async function revoke(userId: string): Promise<PublicSubscription> {
  const sub = await prisma.subscription.findUnique({ where: { userId } });
  if (!sub) throw AppError.notFound('No subscription for this user');
  const updated = await prisma.subscription.update({
    where: { userId },
    data: { status: 'CANCELED', cancelAtPeriodEnd: false, canceledAt: new Date(), currentPeriodEnd: new Date() },
  });
  return toPublic(updated);
}
