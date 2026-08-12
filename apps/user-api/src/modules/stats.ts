import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  STREAK_RULE,
  addDays,
  dateRangeQuerySchema,
  isoWeekKey,
  parseDateOnly,
  sendOk,
  toDateOnlyString,
  coachInsightQuerySchema,
  dailyStatsQuerySchema,
  eachDayInRange,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const statsRouter = Router();

statsRouter.get(
  '/overview',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    const gte = parseDateOnly(from);
    const lte = parseDateOnly(to);

    const [dated, flexible] = await Promise.all([
      prisma.activity.findMany({
        where: { userId: me.id, deletedAt: null, date: { gte, lte } },
        select: { id: true, isDone: true, date: true },
      }),
      prisma.activity.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          date: null,
          windowStart: { lte },
          windowEnd: { gte },
        },
        select: { id: true, isDone: true, targetCount: true, completedCount: true },
      }),
    ]);

    const done = dated.filter((a) => a.isDone).length;

    // Weekly rollup using the isoWeekKey bucketing pattern.
    const weekly = new Map<string, { total: number; done: number }>();
    for (const activity of dated) {
      const key = isoWeekKey(activity.date as Date);
      const bucket = weekly.get(key) ?? { total: 0, done: 0 };
      bucket.total += 1;
      if (activity.isDone) bucket.done += 1;
      weekly.set(key, bucket);
    }

    sendOk(res, {
      range: { from, to },
      totals: {
        activities: dated.length,
        done,
        pending: dated.length - done,
        completionRate: dated.length === 0 ? 0 : Math.round((done / dated.length) * 100),
      },
      flexible: {
        total: flexible.length,
        done: flexible.filter((a) => a.isDone).length,
        completions: flexible.reduce((sum, a) => sum + a.completedCount, 0),
        targets: flexible.reduce((sum, a) => sum + a.targetCount, 0),
      },
      weekly: [...weekly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, v]) => ({ week, ...v })),
    });
  }),
);

statsRouter.get(
  '/categories',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };

    const [categories, activities] = await Promise.all([
      prisma.category.findMany({
        where: { userId: me.id, deletedAt: null },
        select: { id: true, name: true, color: true },
      }),
      prisma.activity.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          date: { gte: parseDateOnly(from), lte: parseDateOnly(to) },
        },
        select: { categoryId: true, isDone: true },
      }),
    ]);

    const tally = new Map<string, { total: number; done: number }>();
    for (const a of activities) {
      const key = a.categoryId ?? 'uncategorized';
      const bucket = tally.get(key) ?? { total: 0, done: 0 };
      bucket.total += 1;
      if (a.isDone) bucket.done += 1;
      tally.set(key, bucket);
    }

    const rows = categories.map((c) => ({
      categoryId: c.id,
      name: c.name,
      color: c.color,
      ...(tally.get(c.id) ?? { total: 0, done: 0 }),
    }));

    const uncategorized = tally.get('uncategorized');
    if (uncategorized) {
      rows.push({
        categoryId: 'uncategorized',
        name: 'Uncategorized',
        color: '#94A3B8',
        ...uncategorized,
      });
    }

    sendOk(res, { range: { from, to }, categories: rows });
  }),
);

statsRouter.get(
  '/streaks',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);

    /**
     * Base spec §7.9 — streaks scan dated activities only. Flexible tasks
     * (date: null) are intentionally excluded: they don't belong to one day.
     */
    const activities = await prisma.activity.findMany({
      where: { userId: me.id, deletedAt: null, date: { not: null } },
      select: { date: true, isDone: true },
      orderBy: { date: 'asc' },
    });

    const byDay = new Map<string, { total: number; done: number }>();
    for (const a of activities) {
      const key = toDateOnlyString(a.date as Date);
      const bucket = byDay.get(key) ?? { total: 0, done: 0 };
      bucket.total += 1;
      if (a.isDone) bucket.done += 1;
      byDay.set(key, bucket);
    }

    const qualifies = (day: { total: number; done: number } | undefined) => {
      if (!day || day.total === 0) return false;
      return STREAK_RULE === 'ALL_ACTIVITIES_DONE' ? day.done === day.total : day.done > 0;
    };

    // Longest streak across all recorded days.
    const sortedKeys = [...byDay.keys()].sort();
    let longest = 0;
    let running = 0;
    let previous: string | null = null;
    for (const key of sortedKeys) {
      if (!qualifies(byDay.get(key))) {
        running = 0;
        previous = key;
        continue;
      }
      const isConsecutive =
        previous !== null && toDateOnlyString(addDays(parseDateOnly(previous), 1)) === key;
      running = isConsecutive && running > 0 ? running + 1 : 1;
      longest = Math.max(longest, running);
      previous = key;
    }

    // Current streak walks backwards from today (or yesterday, if today is unfinished).
    const today = parseDateOnly(new Date());
    let cursor = qualifies(byDay.get(toDateOnlyString(today))) ? today : addDays(today, -1);
    let current = 0;
    while (qualifies(byDay.get(toDateOnlyString(cursor)))) {
      current += 1;
      cursor = addDays(cursor, -1);
    }

    sendOk(res, {
      rule: STREAK_RULE,
      currentStreak: current,
      longestStreak: longest,
      daysTracked: byDay.size,
      note: 'Flexible (non-date-specific) tasks are excluded from streaks by design.',
    });
  }),
);

statsRouter.get(
  '/mood',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };

    const notes = await prisma.dayNote.findMany({
      where: {
        userId: me.id,
        mood: { not: null },
        date: { gte: parseDateOnly(from), lte: parseDateOnly(to) },
      },
      select: { date: true, mood: true },
      orderBy: { date: 'asc' },
    });

    const points = notes.map((n) => ({ date: toDateOnlyString(n.date), mood: n.mood as number }));
    const average =
      points.length === 0
        ? null
        : Math.round((points.reduce((s, p) => s + p.mood, 0) / points.length) * 100) / 100;

    sendOk(res, { range: { from, to }, average, points });
  }),
);

/**
 * P-14 — stacked per-day totals for the Insights chart. Days with nothing
 * planned still appear with zero, so the chart keeps an even x-axis without the
 * client filling gaps.
 *
 * Minutes come from startTime/endTime; an activity with no times contributes
 * DEFAULT_ACTIVITY_MINUTES so it is still visible on the chart.
 */
const DEFAULT_ACTIVITY_MINUTES = 30;

const minutesOf = (startTime: string | null, endTime: string | null): number => {
  if (!startTime || !endTime) return DEFAULT_ACTIVITY_MINUTES;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : DEFAULT_ACTIVITY_MINUTES;
};

statsRouter.get(
  '/daily',
  validate(dailyStatsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    const start = parseDateOnly(from);
    const end = parseDateOnly(to);

    const activities = await prisma.activity.findMany({
      where: { userId: me.id, deletedAt: null, date: { gte: start, lte: end } },
      select: {
        date: true,
        startTime: true,
        endTime: true,
        isDone: true,
        category: { select: { id: true, name: true, color: true } },
      },
    });

    const byDay = new Map<string, Map<string, { name: string; color: string; minutes: number }>>();
    for (const a of activities) {
      const key = toDateOnlyString(a.date as Date);
      const bucket = byDay.get(key) ?? new Map();
      const categoryId = a.category?.id ?? 'uncategorized';
      const current = bucket.get(categoryId) ?? {
        name: a.category?.name ?? 'Uncategorized',
        color: a.category?.color ?? '#94A3B8',
        minutes: 0,
      };
      current.minutes += minutesOf(a.startTime, a.endTime);
      bucket.set(categoryId, current);
      byDay.set(key, bucket);
    }

    sendOk(res, {
      days: eachDayInRange(start, end).map((day) => {
        const key = toDateOnlyString(day);
        const bucket = byDay.get(key);
        const byCategory = bucket
          ? [...bucket.entries()].map(([categoryId, v]) => ({ categoryId, ...v }))
          : [];
        return {
          date: key,
          totalMinutes: byCategory.reduce((sum, c) => sum + c.minutes, 0),
          byCategory,
        };
      }),
    });
  }),
);

/** P-11 — authored coach commentary, or null when none exists for the range. */
statsRouter.get(
  '/coach-insight',
  validate(coachInsightQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from?: string; to?: string };

    const insight = await prisma.coachInsight.findFirst({
      where: {
        userId: me.id,
        ...(from ? { periodEnd: { gte: parseDateOnly(from) } } : {}),
        ...(to ? { periodStart: { lte: parseDateOnly(to) } } : {}),
      },
      orderBy: { createdAt: 'desc' },
      include: { admin: { select: { id: true, name: true, avatarUrl: true } } },
    });

    if (!insight) {
      sendOk(res, null);
      return;
    }

    sendOk(res, {
      id: insight.id,
      headline: insight.headline,
      body: insight.body,
      periodStart: toDateOnlyString(insight.periodStart),
      periodEnd: toDateOnlyString(insight.periodEnd),
      author: insight.admin,
      createdAt: insight.createdAt,
    });
  }),
);
