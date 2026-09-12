import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  DAILY_BUCKET_MAX_DAYS,
  DEFAULT_ACTIVITY_MINUTES,
  UNCATEGORIZED_AREA,
  addDays,
  coachInsightQuerySchema,
  dailyStatsQuerySchema,
  dateRangeQuerySchema,
  diffInDays,
  eachDayInRange,
  formatMinutes,
  insightsQuerySchema,
  isoWeekKey,
  parseDateOnly,
  resolvePeriodRange,
  sendOk,
  startOfWeek,
  toDateOnlyString,
  weekdayInitial,
  weekdayShort,
  type StatsPeriod,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { activityMinutes, computeStreaks, percentOf, tallyByDay } from '../lib/insights.js';

export const statsRouter = Router();

/**
 * Minutes come from startTime/endTime; an activity with no times contributes
 * DEFAULT_ACTIVITY_MINUTES so it is still visible on the chart. Flexible tasks
 * are never scheduled, so they contribute no minutes at all — they are counted
 * by head, not by hour.
 */
const minutesOf = activityMinutes;

/** The person's own week start, which every period boundary honours. */
async function weekStartFor(userId: string): Promise<number> {
  const settings = await prisma.userSettings.findUnique({
    where: { userId },
    select: { weekStartsOn: true },
  });
  return settings?.weekStartsOn ?? 1;
}

const areaShape = () => ({
  total: 0,
  done: 0,
  plannedMinutes: 0,
  completedMinutes: 0,
  dated: { total: 0, done: 0 },
  flexible: { total: 0, done: 0 },
});

type AreaTally = ReturnType<typeof areaShape>;

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

statsRouter.get(
  '/overview',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    const gte = parseDateOnly(from);
    const lte = parseDateOnly(to);

    const [dated, flexible, notes] = await Promise.all([
      prisma.activity.findMany({
        where: { userId: me.id, deletedAt: null, date: { gte, lte } },
        select: { id: true, isDone: true, date: true, startTime: true, endTime: true },
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
      prisma.dayNote.count({ where: { userId: me.id, date: { gte, lte } } }),
    ]);

    const done = dated.filter((a) => a.isDone).length;

    // Minutes are what the Insights cards lead with, so the overview carries
    // them too rather than leaving the client to re-derive them from /daily.
    let plannedMinutes = 0;
    let completedMinutes = 0;
    for (const a of dated) {
      const minutes = minutesOf(a.startTime, a.endTime);
      plannedMinutes += minutes;
      if (a.isDone) completedMinutes += minutes;
    }

    // Weekly rollup using the isoWeekKey bucketing pattern.
    const weekly = new Map<string, { total: number; done: number; minutes: number }>();
    for (const activity of dated) {
      const key = isoWeekKey(activity.date as Date);
      const bucket = weekly.get(key) ?? { total: 0, done: 0, minutes: 0 };
      bucket.total += 1;
      bucket.minutes += minutesOf(activity.startTime, activity.endTime);
      if (activity.isDone) bucket.done += 1;
      weekly.set(key, bucket);
    }

    sendOk(res, {
      range: { from, to, days: diffInDays(lte, gte) + 1 },
      totals: {
        activities: dated.length,
        done,
        pending: dated.length - done,
        completionRate: percentOf(done, dated.length),
        plannedMinutes,
        plannedLabel: formatMinutes(plannedMinutes),
        completedMinutes,
        completedLabel: formatMinutes(completedMinutes),
        minutesCompletionRate: percentOf(completedMinutes, plannedMinutes),
        notesWritten: notes,
      },
      flexible: {
        total: flexible.length,
        done: flexible.filter((a) => a.isDone).length,
        completions: flexible.reduce((sum, a) => sum + a.completedCount, 0),
        targets: flexible.reduce((sum, a) => sum + a.targetCount, 0),
      },
      weekly: [...weekly.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([week, v]) => ({ week, ...v, minutesLabel: formatMinutes(v.minutes) })),
    });
  }),
);

// ---------------------------------------------------------------------------
// Categories (life areas)
// ---------------------------------------------------------------------------

statsRouter.get(
  '/categories',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    const gte = parseDateOnly(from);
    const lte = parseDateOnly(to);

    const [categories, dated, flexible] = await Promise.all([
      prisma.category.findMany({
        where: { userId: me.id, deletedAt: null },
        select: { id: true, name: true, color: true, icon: true },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
      }),
      prisma.activity.findMany({
        where: { userId: me.id, deletedAt: null, date: { gte, lte } },
        select: { categoryId: true, isDone: true, startTime: true, endTime: true },
      }),
      // A flexible task belongs to a life area too; the Insights list counts it.
      prisma.activity.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          date: null,
          windowStart: { lte },
          windowEnd: { gte },
        },
        select: { categoryId: true, isDone: true },
      }),
    ]);

    const tally = collectAreas(dated, flexible);
    const rows = areaRows(tally, categories);

    sendOk(res, {
      range: { from, to },
      total: rows.reduce((sum, r) => sum + r.total, 0),
      lifeAreas: rows.length,
      categories: rows,
    });
  }),
);

// ---------------------------------------------------------------------------
// Streaks
// ---------------------------------------------------------------------------

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

    sendOk(res, {
      ...computeStreaks(tallyByDay(activities)),
      note: 'Flexible (non-date-specific) tasks are excluded from streaks by design.',
    });
  }),
);

// ---------------------------------------------------------------------------
// Mood
// ---------------------------------------------------------------------------

statsRouter.get(
  '/mood',
  validate(dateRangeQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to } = req.query as unknown as { from: string; to: string };
    const start = parseDateOnly(from);
    const end = parseDateOnly(to);

    const notes = await prisma.dayNote.findMany({
      where: { userId: me.id, date: { gte: start, lte: end } },
      select: { date: true, mood: true },
      orderBy: { date: 'asc' },
    });

    sendOk(res, { range: { from, to }, ...moodSummary(notes, start, end) });
  }),
);

// ---------------------------------------------------------------------------
// Daily rollup (P-14)
// ---------------------------------------------------------------------------

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
        categoryId: true,
        category: { select: { id: true, name: true, color: true } },
      },
    });

    sendOk(res, { days: buildDayBuckets(activities, start, end) });
  }),
);

// ---------------------------------------------------------------------------
// Coach insight (P-11)
// ---------------------------------------------------------------------------

const coachInsightInclude = {
  admin: { select: { id: true, name: true, avatarUrl: true } },
} satisfies Prisma.CoachInsightInclude;

/** Authored coach commentary, or null when none exists for the range. */
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
      include: coachInsightInclude,
    });

    sendOk(res, insight ? serializeInsight(insight) : null);
  }),
);

// ---------------------------------------------------------------------------
// Insights — one call behind the whole Insights page
// ---------------------------------------------------------------------------

/**
 * Addendum 5 §1. The page has seven cards; fetching them piecemeal meant seven
 * round trips and seven chances for the figures to disagree with each other.
 * This returns every number the page renders, already labelled, from a single
 * consistent read of one range.
 */
statsRouter.get(
  '/insights',
  validate(insightsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { period, anchor, from, to } = req.query as unknown as {
      period: StatsPeriod;
      anchor?: string;
      from?: string;
      to?: string;
    };

    const weekStartsOn = await weekStartFor(me.id);
    const range =
      from && to
        ? { from: parseDateOnly(from), to: parseDateOnly(to) }
        : resolvePeriodRange(period, anchor ?? new Date(), weekStartsOn);
    const { from: start, to: end } = range;
    const daysInRange = diffInDays(end, start) + 1;

    const [categories, dated, flexible, notes, allDated, insight] = await Promise.all([
      prisma.category.findMany({
        where: { userId: me.id, deletedAt: null },
        select: { id: true, name: true, color: true, icon: true },
        orderBy: [{ order: 'asc' }, { name: 'asc' }],
      }),
      prisma.activity.findMany({
        where: { userId: me.id, deletedAt: null, date: { gte: start, lte: end } },
        select: {
          date: true,
          startTime: true,
          endTime: true,
          isDone: true,
          categoryId: true,
          category: { select: { id: true, name: true, color: true } },
        },
      }),
      prisma.activity.findMany({
        where: {
          userId: me.id,
          deletedAt: null,
          date: null,
          windowStart: { lte: end },
          windowEnd: { gte: start },
        },
        select: { categoryId: true, isDone: true, targetCount: true, completedCount: true },
      }),
      prisma.dayNote.findMany({
        where: { userId: me.id, date: { gte: start, lte: end } },
        select: { date: true, mood: true },
        orderBy: { date: 'asc' },
      }),
      // Streaks are a lifetime figure, so they deliberately ignore the range.
      prisma.activity.findMany({
        where: { userId: me.id, deletedAt: null, date: { not: null } },
        select: { date: true, isDone: true },
      }),
      prisma.coachInsight.findFirst({
        where: { userId: me.id, periodEnd: { gte: start }, periodStart: { lte: end } },
        orderBy: { createdAt: 'desc' },
        include: coachInsightInclude,
      }),
    ]);

    // --- Planned / completed ------------------------------------------------
    let plannedMinutes = 0;
    let completedMinutes = 0;
    let datedDone = 0;
    for (const a of dated) {
      const minutes = minutesOf(a.startTime, a.endTime);
      plannedMinutes += minutes;
      if (a.isDone) {
        completedMinutes += minutes;
        datedDone += 1;
      }
    }
    const flexibleDone = flexible.filter((a) => a.isDone).length;

    // --- Life areas ---------------------------------------------------------
    const areas = areaRows(collectAreas(dated, flexible), categories);
    const areaTotal = areas.reduce((sum, a) => sum + a.total, 0);

    // --- Day notes ----------------------------------------------------------
    const mood = moodSummary(notes, start, end);
    const today = parseDateOnly(new Date());
    // Days of the period that have actually happened — a Tuesday should not be
    // told it has missed Friday's reflection.
    const daysElapsed = Math.min(
      daysInRange,
      Math.max(0, diffInDays(today.getTime() < end.getTime() ? today : end, start) + 1),
    );

    // --- Daily activity chart ----------------------------------------------
    const useWeeks = daysInRange > DAILY_BUCKET_MAX_DAYS;
    const buckets = useWeeks
      ? buildWeekBuckets(dated, start, end, weekStartsOn)
      : buildDayBuckets(dated, start, end);

    const streaks = computeStreaks(tallyByDay(allDated), today);

    sendOk(res, {
      period: from && to ? 'custom' : period,
      range: { from: toDateOnlyString(start), to: toDateOnlyString(end), days: daysInRange },
      planned: {
        minutes: plannedMinutes,
        label: formatMinutes(plannedMinutes),
        activities: dated.length + flexible.length,
        datedActivities: dated.length,
        flexibleActivities: flexible.length,
        // "across 6 life areas" — every area listed under Activities by life area.
        lifeAreas: areas.length,
      },
      completed: {
        minutes: completedMinutes,
        label: formatMinutes(completedMinutes),
        activities: datedDone + flexibleDone,
        // "0% of what you planned" is measured in minutes, not in headcount.
        percentOfPlanned: percentOf(completedMinutes, plannedMinutes),
        percentOfActivities: percentOf(datedDone + flexibleDone, dated.length + flexible.length),
      },
      streak: {
        current: streaks.currentStreak,
        best: streaks.longestStreak,
        label: `${streaks.currentStreak}d`,
        bestLabel: `${streaks.longestStreak}d`,
        activeToday: streaks.activeToday,
        rule: streaks.rule,
      },
      notes: {
        written: notes.length,
        withMood: mood.count,
        daysInRange,
        // What the "n / n days with a reflection" card divides by.
        daysElapsed,
        label: `${notes.length} / ${daysElapsed}`,
      },
      lifeAreas: { total: areaTotal, count: areas.length, areas },
      dailyActivity: {
        granularity: useWeeks ? 'week' : 'day',
        label: useWeeks ? `Last ${buckets.length} weeks` : `Last ${buckets.length} days`,
        maxMinutes: buckets.reduce((max, b) => Math.max(max, b.totalMinutes), 0),
        buckets,
      },
      mood,
      coachInsight: insight ? serializeInsight(insight) : null,
      meta: {
        // Spelled out so the client never has to guess at the arithmetic.
        untimedActivityMinutes: DEFAULT_ACTIVITY_MINUTES,
        weekStartsOn,
        flexibleCountedInAreas: true,
        flexibleCountedInMinutes: false,
      },
    });
  }),
);

/** The three ranges behind the Week / Month / Quarter toggle, resolved to dates. */
statsRouter.get(
  '/insights/periods',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const weekStartsOn = await weekStartFor(me.id);
    const today = parseDateOnly(new Date());

    const shape = (period: StatsPeriod) => {
      const current = resolvePeriodRange(period, today, weekStartsOn);
      const previousAnchor =
        period === 'week'
          ? addDays(current.from, -7)
          : new Date(
              Date.UTC(
                current.from.getUTCFullYear(),
                current.from.getUTCMonth() - (period === 'month' ? 1 : 3),
                1,
              ),
            );
      const previous = resolvePeriodRange(period, previousAnchor, weekStartsOn);
      return {
        period,
        current: { from: toDateOnlyString(current.from), to: toDateOnlyString(current.to) },
        previous: { from: toDateOnlyString(previous.from), to: toDateOnlyString(previous.to) },
      };
    };

    sendOk(res, {
      weekStartsOn,
      periods: (['week', 'month', 'quarter'] as StatsPeriod[]).map(shape),
    });
  }),
);

// ---------------------------------------------------------------------------
// Shared shaping
// ---------------------------------------------------------------------------

interface DatedRow {
  date: Date | null;
  startTime: string | null;
  endTime: string | null;
  isDone: boolean;
  categoryId: string | null;
  category?: { id: string; name: string; color: string } | null;
}

interface FlexibleRow {
  categoryId: string | null;
  isDone: boolean;
}

/** What an area tally needs; `date` is irrelevant once the range is fixed. */
interface AreaRow extends FlexibleRow {
  startTime: string | null;
  endTime: string | null;
}

interface CategoryMeta {
  id: string;
  name: string;
  color: string;
  icon: string | null;
}

/** One pass over both activity kinds, bucketed by life area. */
function collectAreas(dated: AreaRow[], flexible: FlexibleRow[]): Map<string, AreaTally> {
  const tally = new Map<string, AreaTally>();
  const bucketFor = (categoryId: string | null) => {
    const key = categoryId ?? UNCATEGORIZED_AREA.id;
    const bucket = tally.get(key) ?? areaShape();
    tally.set(key, bucket);
    return bucket;
  };

  for (const a of dated) {
    const bucket = bucketFor(a.categoryId);
    const minutes = minutesOf(a.startTime, a.endTime);
    bucket.total += 1;
    bucket.dated.total += 1;
    bucket.plannedMinutes += minutes;
    if (a.isDone) {
      bucket.done += 1;
      bucket.dated.done += 1;
      bucket.completedMinutes += minutes;
    }
  }
  for (const a of flexible) {
    const bucket = bucketFor(a.categoryId);
    bucket.total += 1;
    bucket.flexible.total += 1;
    if (a.isDone) {
      bucket.done += 1;
      bucket.flexible.done += 1;
    }
  }
  return tally;
}

/**
 * Every life area the person owns, in their own order, whether or not anything
 * landed in it this period — an empty "Errands 0/0" row is information too. The
 * synthetic Uncategorized area is appended only when something falls into it.
 */
function areaRows(tally: Map<string, AreaTally>, categories: CategoryMeta[]) {
  const grandTotal = [...tally.values()].reduce((sum, v) => sum + v.total, 0);

  const row = (id: string, name: string, color: string, icon: string | null) => {
    const t = tally.get(id) ?? areaShape();
    return {
      categoryId: id,
      name,
      color,
      icon,
      ...t,
      plannedLabel: formatMinutes(t.plannedMinutes),
      completedLabel: formatMinutes(t.completedMinutes),
      // "1 / 8" on the card; share sizes the segment in the stacked bar.
      label: `${t.done} / ${t.total}`,
      share: grandTotal === 0 ? 0 : Math.round((t.total / grandTotal) * 10000) / 10000,
      sharePercent: percentOf(t.total, grandTotal),
      completionRate: percentOf(t.done, t.total),
    };
  };

  const rows = categories.map((c) => row(c.id, c.name, c.color, c.icon));
  if (tally.has(UNCATEGORIZED_AREA.id)) {
    rows.push(row(UNCATEGORIZED_AREA.id, UNCATEGORIZED_AREA.name, UNCATEGORIZED_AREA.color, null));
  }
  return rows;
}

/**
 * Mood points plus a gap-free series, so the trend keeps an even x-axis. A null
 * mood means "nothing recorded that day" and is not the same as a low score.
 */
function moodSummary(notes: { date: Date; mood: number | null }[], start: Date, end: Date) {
  const moodByDay = new Map(
    notes
      .filter((n) => n.mood !== null)
      .map((n) => [toDateOnlyString(n.date), n.mood as number] as const),
  );
  const points = [...moodByDay.entries()].map(([date, mood]) => ({ date, mood }));

  return {
    average:
      points.length === 0
        ? null
        : Math.round((points.reduce((s, p) => s + p.mood, 0) / points.length) * 100) / 100,
    hasData: points.length > 0,
    count: points.length,
    min: points.length ? Math.min(...points.map((p) => p.mood)) : null,
    max: points.length ? Math.max(...points.map((p) => p.mood)) : null,
    points,
    series: eachDayInRange(start, end).map((day) => {
      const key = toDateOnlyString(day);
      return {
        date: key,
        label: weekdayInitial(day),
        weekday: weekdayShort(day),
        mood: moodByDay.get(key) ?? null,
      };
    }),
  };
}

interface CategorySlice {
  categoryId: string;
  name: string;
  color: string;
  minutes: number;
  completedMinutes: number;
  total: number;
  done: number;
}

/**
 * Days with nothing planned still appear with zero, so the chart keeps an even
 * x-axis without the client filling gaps itself.
 */
function buildDayBuckets(rows: DatedRow[], start: Date, end: Date) {
  const byDay = new Map<string, Map<string, CategorySlice>>();
  for (const a of rows) {
    if (!a.date) continue;
    const key = toDateOnlyString(a.date);
    const bucket = byDay.get(key) ?? new Map<string, CategorySlice>();
    const categoryId = a.category?.id ?? UNCATEGORIZED_AREA.id;
    const slice = bucket.get(categoryId) ?? {
      categoryId,
      name: a.category?.name ?? UNCATEGORIZED_AREA.name,
      color: a.category?.color ?? UNCATEGORIZED_AREA.color,
      minutes: 0,
      completedMinutes: 0,
      total: 0,
      done: 0,
    };
    const minutes = minutesOf(a.startTime, a.endTime);
    slice.minutes += minutes;
    slice.total += 1;
    if (a.isDone) {
      slice.completedMinutes += minutes;
      slice.done += 1;
    }
    bucket.set(categoryId, slice);
    byDay.set(key, bucket);
  }

  return eachDayInRange(start, end).map((day) => {
    const key = toDateOnlyString(day);
    const byCategory = [...(byDay.get(key)?.values() ?? [])];
    const totalMinutes = byCategory.reduce((sum, c) => sum + c.minutes, 0);
    const completedMinutes = byCategory.reduce((sum, c) => sum + c.completedMinutes, 0);
    return {
      date: key,
      label: weekdayInitial(day),
      weekday: weekdayShort(day),
      totalMinutes,
      totalLabel: formatMinutes(totalMinutes),
      completedMinutes,
      completedLabel: formatMinutes(completedMinutes),
      total: byCategory.reduce((sum, c) => sum + c.total, 0),
      done: byCategory.reduce((sum, c) => sum + c.done, 0),
      byCategory,
    };
  });
}

/** Long ranges roll up to weeks; a 90-bar chart is unreadable on a phone. */
function buildWeekBuckets(rows: DatedRow[], start: Date, end: Date, weekStartsOn: number) {
  const days = buildDayBuckets(rows, start, end);
  const weeks = new Map<string, ReturnType<typeof buildDayBuckets>>();
  for (const day of days) {
    const key = toDateOnlyString(startOfWeek(parseDateOnly(day.date), weekStartsOn));
    weeks.set(key, [...(weeks.get(key) ?? []), day]);
  }

  return [...weeks.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([weekStart, members]) => {
      const byCategory = new Map<string, CategorySlice>();
      for (const day of members) {
        for (const slice of day.byCategory) {
          const current = byCategory.get(slice.categoryId) ?? {
            ...slice,
            minutes: 0,
            completedMinutes: 0,
            total: 0,
            done: 0,
          };
          current.minutes += slice.minutes;
          current.completedMinutes += slice.completedMinutes;
          current.total += slice.total;
          current.done += slice.done;
          byCategory.set(slice.categoryId, current);
        }
      }
      const totalMinutes = members.reduce((sum, d) => sum + d.totalMinutes, 0);
      const completedMinutes = members.reduce((sum, d) => sum + d.completedMinutes, 0);
      return {
        date: weekStart,
        label: isoWeekKey(parseDateOnly(weekStart)).split('-')[1],
        weekday: `Week of ${weekStart}`,
        totalMinutes,
        totalLabel: formatMinutes(totalMinutes),
        completedMinutes,
        completedLabel: formatMinutes(completedMinutes),
        total: members.reduce((sum, d) => sum + d.total, 0),
        done: members.reduce((sum, d) => sum + d.done, 0),
        byCategory: [...byCategory.values()],
      };
    });
}

/** "Moyo Ade" -> "MO": the two-letter monogram the insight card renders. */
const initialsOf = (name: string): string => {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
};

const serializeInsight = (insight: {
  id: string;
  headline: string;
  body: string;
  periodStart: Date;
  periodEnd: Date;
  createdAt: Date;
  admin: { id: string; name: string; avatarUrl: string | null };
}) => ({
  id: insight.id,
  headline: insight.headline,
  body: insight.body,
  periodStart: toDateOnlyString(insight.periodStart),
  periodEnd: toDateOnlyString(insight.periodEnd),
  author: { ...insight.admin, initials: initialsOf(insight.admin.name) },
  createdAt: insight.createdAt,
});
