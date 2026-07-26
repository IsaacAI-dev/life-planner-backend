import type { AnalyticsQuery } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

const DAY_MS = 24 * 60 * 60 * 1000;

/** Dashboard overview: totals, new-user count for the range, and a signup time series. */
export async function overview(q: AnalyticsQuery) {
  const now = new Date();
  const to = q.to ? new Date(q.to) : now;
  const from = q.from ? new Date(q.from) : new Date(to.getTime() - 30 * DAY_MS);

  const [
    totalUsers,
    newUsers,
    suspendedUsers,
    activeSubscriptions,
    totalActivities,
    totalConversations,
    openConversations,
    totalMessages,
    series,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { createdAt: { gte: from, lte: to } } }),
    prisma.user.count({
      where: {
        suspendedAt: { not: null },
        OR: [{ suspendedUntil: null }, { suspendedUntil: { gt: now } }],
      },
    }),
    prisma.subscription.count({ where: { status: 'ACTIVE', currentPeriodEnd: { gt: now } } }),
    prisma.activity.count({ where: { deletedAt: null } }),
    prisma.conversation.count({ where: { deletedAt: null } }),
    prisma.conversation.count({ where: { status: 'OPEN', deletedAt: null } }),
    prisma.message.count({ where: { deletedAt: null } }),
    newUsersSeries(from, to, q.interval),
  ]);

  return {
    range: { from: from.toISOString(), to: to.toISOString(), interval: q.interval },
    totals: {
      users: totalUsers,
      activities: totalActivities,
      conversations: totalConversations,
      openConversations,
      messages: totalMessages,
      activeSubscriptions,
      suspendedUsers,
    },
    newUsers,
    newUsersSeries: series,
  };
}

/** Bucketed signup counts via Postgres date_trunc. Interval is enum-validated. */
async function newUsersSeries(from: Date, to: Date, interval: AnalyticsQuery['interval']) {
  const rows = await prisma.$queryRaw<{ bucket: Date; count: number }[]>`
    SELECT date_trunc(${interval}, "createdAt") AS bucket, COUNT(*)::int AS count
    FROM "User"
    WHERE "createdAt" >= ${from} AND "createdAt" <= ${to}
    GROUP BY bucket
    ORDER BY bucket ASC
  `;
  return rows.map((r) => ({ bucket: r.bucket.toISOString(), count: Number(r.count) }));
}
