import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  analyticsPagesQuerySchema,
  analyticsRangeQuerySchema,
  analyticsSignupsQuerySchema,
  bucketKey,
  dayRangeUtc,
  sendOk,
  opsReportQuerySchema,
  parseDateOnly,
  analyticsOverviewQuerySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';

export const adminAnalyticsRouter = Router();

/**
 * uniqueVisitors = distinct sessionId
 * activeUsers    = distinct userId with any activity mutation in range
 * newSignups     = User.count where createdAt in range (derived, never logged
 *                  as its own event — one source of truth per fact)
 */
adminAnalyticsRouter.get(
  '/overview',
  validate(analyticsRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    const range = dayRangeUtc(from, to);

    const [totalPageViews, sessions, newSignups, activeUserRows] = await Promise.all([
      prisma.analyticsEvent.count({ where: { type: 'PAGE_VIEW', createdAt: range } }),
      prisma.analyticsEvent.findMany({
        where: { createdAt: range, sessionId: { not: null } },
        distinct: ['sessionId'],
        select: { sessionId: true },
      }),
      prisma.user.count({ where: { createdAt: range } }),
      prisma.activity.findMany({
        where: { updatedAt: range },
        distinct: ['userId'],
        select: { userId: true },
      }),
    ]);

    sendOk(res, {
      range: { from, to },
      totalPageViews,
      uniqueVisitors: sessions.length,
      newSignups,
      activeUsers: activeUserRows.length,
    });
  }),
);

adminAnalyticsRouter.get(
  '/pages',
  validate(analyticsPagesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to, limit } = req.query as unknown as { from: string; to: string; limit: number };
    const range = dayRangeUtc(from, to);

    const grouped = await prisma.analyticsEvent.groupBy({
      by: ['path'],
      where: { type: 'PAGE_VIEW', createdAt: range, path: { not: null } },
      _count: { _all: true },
      orderBy: { _count: { path: 'desc' } },
      take: limit,
    });

    sendOk(res, {
      range: { from, to },
      pages: grouped.map((row) => ({ path: row.path as string, views: row._count._all })),
    });
  }),
);

adminAnalyticsRouter.get(
  '/signups',
  validate(analyticsSignupsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to, granularity } = req.query as unknown as {
      from: string;
      to: string;
      granularity: 'day' | 'week' | 'month';
    };
    const range = dayRangeUtc(from, to);

    const users = await prisma.user.findMany({
      where: { createdAt: range },
      select: { createdAt: true },
      orderBy: { createdAt: 'asc' },
    });

    const buckets = new Map<string, number>();
    for (const user of users) {
      const key = bucketKey(user.createdAt, granularity);
      buckets.set(key, (buckets.get(key) ?? 0) + 1);
    }

    sendOk(res, {
      range: { from, to },
      granularity,
      total: users.length,
      points: [...buckets.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([bucket, count]) => ({ bucket, count })),
    });
  }),
);

/**
 * App-wide operational reporting: adoption of each feature, chat load, coach
 * workload and content volume. Deliberately a single call — the dashboard shows
 * all of it at once and eight round trips would be worse.
 */
adminAnalyticsRouter.get(
  '/ops',
  validate(opsReportQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    const start = parseDateOnly(from);
    const end = new Date(`${to}T23:59:59.999Z`);
    const range = { gte: start, lte: end };

    const [
      newUsers,
      activeSubscriptions,
      activitiesCreated,
      goalsCreated,
      messagesSent,
      voiceNotes,
      openConversations,
      mealPlansPublished,
      mealRequests,
      recommendations,
      feedbackForms,
      byConversationType,
    ] = await Promise.all([
      prisma.user.count({ where: { createdAt: range } }),
      prisma.subscription.count({ where: { tier: 'PRO', status: 'ACTIVE' } }),
      prisma.activity.count({ where: { createdAt: range } }),
      prisma.goal.count({ where: { createdAt: range } }),
      prisma.message.count({ where: { createdAt: range, deletedAt: null } }),
      prisma.message.count({ where: { createdAt: range, kind: 'VOICE_NOTE' } }),
      prisma.conversation.count({ where: { status: { not: 'CLOSED' } } }),
      prisma.mealPlan.count({ where: { publishedAt: range } }),
      prisma.mealPlanRequest.count({ where: { createdAt: range } }),
      prisma.recommendation.groupBy({ by: ['status'], _count: true, where: { createdAt: range } }),
      prisma.feedbackForm.groupBy({ by: ['status'], _count: true, where: { createdAt: range } }),
      prisma.conversation.groupBy({ by: ['type', 'status'], _count: true }),
    ]);

    // Median first-response time would need per-message analysis; the count of
    // unclaimed conversations is the actionable number for a queue dashboard.
    const unclaimed = await prisma.conversation.count({
      where: { assignedAdminId: null, status: 'OPEN' },
    });

    sendOk(res, {
      range: { from, to },
      users: { newUsers, activeSubscriptions },
      planner: { activitiesCreated, goalsCreated },
      chat: {
        messagesSent,
        voiceNotes,
        openConversations,
        unclaimed,
        byType: byConversationType,
      },
      nutrition: { mealPlansPublished, mealRequests },
      coaching: { recommendations, feedbackForms },
    });
  }),
);

/** Per-coach workload, for staffing decisions. */
adminAnalyticsRouter.get(
  '/coach-load',
  asyncHandler(async (_req, res) => {
    const admins = await prisma.admin.findMany({
      where: { deletedAt: null },
      select: {
        id: true,
        name: true,
        roles: true,
        isAvailable: true,
        maxClients: true,
        _count: {
          select: {
            coachAssignments: { where: { status: 'ACTIVE' } },
            assignedConversations: { where: { status: { not: 'CLOSED' } } },
          },
        },
      },
      orderBy: { name: 'asc' },
    });

    sendOk(res, {
      admins: admins.map((a) => ({
        id: a.id,
        name: a.name,
        roles: a.roles,
        isAvailable: a.isAvailable,
        maxClients: a.maxClients,
        activeClients: a._count.coachAssignments,
        openConversations: a._count.assignedConversations,
        utilisation:
          a.maxClients > 0
            ? Math.round((a._count.coachAssignments / a.maxClients) * 100) / 100
            : null,
      })),
    });
  }),
);

/**
 * The console's landing screen: ten headline counters with a week-over-week
 * delta each, plus weekly trend series.
 *
 * Deltas compare the last seven days against the seven before, which is what
 * "vs last week" means to someone reading the dashboard — not calendar weeks.
 */
adminAnalyticsRouter.get(
  '/dashboard',
  validate(analyticsOverviewQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { weeks, month } = req.query as unknown as { weeks: number; month?: string };

    /**
     * The console's "All months" picker. Selecting a month scopes every counter
     * and every series to it; the trend then buckets that month by week rather
     * than the trailing `weeks` window.
     */
    const monthStart = month ? new Date(`${month}-01T00:00:00.000Z`) : null;
    const monthEnd = monthStart
      ? new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 1))
      : null;
    const scope = monthStart && monthEnd ? { gte: monthStart, lt: monthEnd } : undefined;
    const now = new Date();
    const weekAgo = new Date(now.getTime() - 7 * 86_400_000);
    const twoWeeksAgo = new Date(now.getTime() - 14 * 86_400_000);

    const delta = (current: number, previous: number) =>
      previous === 0
        ? current === 0
          ? 0
          : 100
        : Math.round(((current - previous) / previous) * 1000) / 10;

    /** Total, plus the two trailing weeks used for the delta. */
    const metric = async (
      count: (where: Record<string, unknown>) => Promise<number>,
      field = 'createdAt',
    ) => {
      // With a month selected the headline is that month's count, and the
      // comparison is against the month before — not against last week, which
      // would be meaningless next to a monthly figure.
      if (monthStart && monthEnd) {
        const prevStart = new Date(
          Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() - 1, 1),
        );
        const [total, previous] = await Promise.all([
          count({ [field]: { gte: monthStart, lt: monthEnd } }),
          count({ [field]: { gte: prevStart, lt: monthStart } }),
        ]);
        return { total, change: delta(total, previous) };
      }

      const [total, thisWeek, lastWeek] = await Promise.all([
        count({}),
        count({ [field]: { gte: weekAgo } }),
        count({ [field]: { gte: twoWeeksAgo, lt: weekAgo } }),
      ]);
      return { total, change: delta(thisWeek, lastWeek) };
    };

    const [
      users,
      activities,
      budgets,
      flexibleTasks,
      mealPlans,
      sharedBoards,
      subscribers,
      goals,
      reviews,
      siteVisits,
      bannedUsers,
      suspendedUsers,
    ] = await Promise.all([
      metric((w) => prisma.user.count({ where: { deletedAt: null, ...w } })),
      metric((w) => prisma.activity.count({ where: { deletedAt: null, date: { not: null }, ...w } })),
      metric((w) => prisma.budgetMonth.count({ where: w })),
      metric((w) => prisma.activity.count({ where: { deletedAt: null, date: null, ...w } })),
      metric((w) => prisma.mealPlan.count({ where: w })),
      metric((w) => prisma.boardShare.count({ where: { status: 'ACTIVE', ...w } })),
      metric((w) => prisma.subscription.count({ where: { tier: 'PRO', ...w } })),
      metric((w) => prisma.goal.count({ where: { deletedAt: null, ...w } })),
      metric((w) => prisma.feedbackForm.count({ where: { status: 'COMPLETED', ...w } })),
      metric((w) => prisma.analyticsEvent.count({ where: { type: 'PAGE_VIEW', ...w } })),
      // Counted from the moderation log, not User.status: reinstating someone
      // must not erase the fact that they were banned.
      metric((w) => prisma.moderationEvent.count({ where: { action: 'BANNED', ...w } })),
      metric((w) => prisma.moderationEvent.count({ where: { action: 'SUSPENDED', ...w } })),
    ]);

    // --- weekly trend series ---
    const weekStarts: Date[] = [];
    if (monthStart && monthEnd) {
      // Weekly buckets inside the selected month.
      const cursor = new Date(monthStart);
      while (cursor < monthEnd) {
        weekStarts.push(new Date(cursor));
        cursor.setUTCDate(cursor.getUTCDate() + 7);
      }
    }
    const anchor = new Date(now);
    anchor.setUTCHours(0, 0, 0, 0);
    anchor.setUTCDate(anchor.getUTCDate() - ((anchor.getUTCDay() + 6) % 7)); // Monday
    if (weekStarts.length === 0) {
      for (let i = weeks - 1; i >= 0; i -= 1) {
        weekStarts.push(new Date(anchor.getTime() - i * 7 * 86_400_000));
      }
    }

    /**
     * One grouped query per series rather than `weeks` separate counts — at 26
     * weeks that is the difference between 6 queries and 156.
     */
    const bucket = (rows: { at: Date }[]) =>
      weekStarts.map((start, i) => {
        const end = i === weekStarts.length - 1
          ? new Date(start.getTime() + 7 * 86_400_000)
          : weekStarts[i + 1];
        return {
          weekStart: start.toISOString().slice(0, 10),
          value: rows.filter((r) => r.at >= start && r.at < end).length,
        };
      });

    const since = weekStarts[0];
    const until = monthEnd ?? new Date(now.getTime() + 7 * 86_400_000);
    const window = { gte: since, lt: until };

    const [
      enrollments,
      budgetRows,
      mealPlanRows,
      newSubs,
      lostSubs,
      deletions,
      bannedRows,
      suspendedRows,
      flexibleRows,
      goalRows,
      activityRows,
      reviewRows,
    ] = await Promise.all([
      prisma.user.findMany({ where: { createdAt: window }, select: { createdAt: true } }),
      prisma.budgetMonth.findMany({ where: { createdAt: window }, select: { createdAt: true } }),
      prisma.mealPlan.findMany({ where: { createdAt: window }, select: { createdAt: true } }),
      prisma.subscription.findMany({
        where: { tier: 'PRO', activatedAt: window },
        select: { activatedAt: true },
      }),
      prisma.subscription.findMany({
        where: { expiredAt: window },
        select: { expiredAt: true },
      }),
      prisma.user.findMany({ where: { deletedAt: window }, select: { deletedAt: true } }),
      prisma.moderationEvent.findMany({
        where: { action: 'BANNED', createdAt: window },
        select: { createdAt: true },
      }),
      prisma.moderationEvent.findMany({
        where: { action: 'SUSPENDED', createdAt: window },
        select: { createdAt: true },
      }),
      prisma.activity.findMany({
        where: { date: null, deletedAt: null, createdAt: window },
        select: { createdAt: true },
      }),
      prisma.goal.findMany({
        where: { deletedAt: null, createdAt: window },
        select: { createdAt: true },
      }),
      prisma.activity.findMany({
        where: { date: { not: null }, deletedAt: null, createdAt: window },
        select: { createdAt: true },
      }),
      prisma.feedbackForm.findMany({
        where: { status: 'COMPLETED', respondedAt: window },
        select: { respondedAt: true },
      }),
    ]);

    const sum = (series: { value: number }[]) => series.reduce((t, s) => t + s.value, 0);
    const trend = (rows: { at: Date }[]) => {
      const series = bucket(rows);
      const last = series[series.length - 1]?.value ?? 0;
      const previous = series[series.length - 2]?.value ?? 0;
      return { total: sum(series), change: delta(last, previous), series };
    };

    sendOk(res, {
      counters: {
        users,
        activities,
        budgets,
        flexibleTasks,
        mealPlans,
        sharedBoards,
        subscribers,
        goals,
        reviews,
        siteVisits,
        bannedUsers,
        suspendedUsers,
      },
      weeks,
      trends: {
        userEnrollments: trend(enrollments.map((r) => ({ at: r.createdAt }))),
        budgetsCreated: trend(budgetRows.map((r) => ({ at: r.createdAt }))),
        mealPlansCreated: trend(mealPlanRows.map((r) => ({ at: r.createdAt }))),
        newSubscribers: trend(newSubs.map((r) => ({ at: r.activatedAt as Date }))),
        subscribersLost: trend(lostSubs.map((r) => ({ at: r.expiredAt as Date }))),
        accountsDeleted: trend(deletions.map((r) => ({ at: r.deletedAt as Date }))),
        bannedUsers: trend(bannedRows.map((r) => ({ at: r.createdAt }))),
        suspendedUsers: trend(suspendedRows.map((r) => ({ at: r.createdAt }))),
        flexibleTasksCreated: trend(flexibleRows.map((r) => ({ at: r.createdAt }))),
        goalsCreated: trend(goalRows.map((r) => ({ at: r.createdAt }))),
        activitiesCreated: trend(activityRows.map((r) => ({ at: r.createdAt }))),
        reviewsReceived: trend(reviewRows.map((r) => ({ at: r.respondedAt as Date }))),
      },
      month: month ?? null,
    });
  }),
);
