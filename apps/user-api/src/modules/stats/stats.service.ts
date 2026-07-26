import { dateOnly, formatDate, type StatsRangeQuery } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

/**
 * NOTE (§15 decision #6): streak rule is configurable here. Default is
 * "all activities done that day" — a day counts toward a streak only if it has
 * at least one activity AND every (non-deleted) activity on it is done.
 */
type StreakRule = 'all-done' | 'at-least-one';
const STREAK_RULE: StreakRule = 'all-done';

function defaultRange(q: StatsRangeQuery): { from: Date; to: Date } {
  const to = q.to ? dateOnly(q.to) : dateOnly(new Date());
  const from = q.from ? dateOnly(q.from) : dateOnly(new Date(to.getTime() - 83 * 86_400_000)); // ~12 weeks
  return { from, to };
}

export async function overview(userId: string, q: StatsRangeQuery) {
  const { from, to } = defaultRange(q);
  const activities = await prisma.activity.findMany({
    where: { userId, deletedAt: null, date: { gte: from, lte: to } },
    select: { isDone: true, date: true },
  });

  const total = activities.length;
  const done = activities.filter((a) => a.isDone).length;

  // completion per ISO week (year-week key)
  const byWeek = new Map<string, { total: number; done: number }>();
  for (const a of activities) {
    const key = isoWeekKey(a.date);
    const slot = byWeek.get(key) ?? { total: 0, done: 0 };
    slot.total += 1;
    if (a.isDone) slot.done += 1;
    byWeek.set(key, slot);
  }

  return {
    range: { from: formatDate(from), to: formatDate(to) },
    completionRate: total === 0 ? 0 : Math.round((done / total) * 100),
    totals: { total, done },
    perWeek: [...byWeek.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, v]) => ({
        week,
        total: v.total,
        done: v.done,
        rate: v.total === 0 ? 0 : Math.round((v.done / v.total) * 100),
      })),
  };
}

export async function categories(userId: string, q: StatsRangeQuery) {
  const { from, to } = defaultRange(q);
  const activities = await prisma.activity.findMany({
    where: { userId, deletedAt: null, date: { gte: from, lte: to } },
    select: {
      isDone: true,
      category: { select: { id: true, name: true, color: true } },
    },
  });

  const map = new Map<string, { id: string | null; name: string; color: string | null; total: number; done: number }>();
  for (const a of activities) {
    const id = a.category?.id ?? 'uncategorized';
    const slot = map.get(id) ?? {
      id: a.category?.id ?? null,
      name: a.category?.name ?? 'Uncategorized',
      color: a.category?.color ?? null,
      total: 0,
      done: 0,
    };
    slot.total += 1;
    if (a.isDone) slot.done += 1;
    map.set(id, slot);
  }

  return {
    range: { from: formatDate(from), to: formatDate(to) },
    categories: [...map.values()].map((c) => ({
      ...c,
      rate: c.total === 0 ? 0 : Math.round((c.done / c.total) * 100),
    })),
  };
}

export async function streaks(userId: string) {
  // Look back ~1 year of activity to compute streaks.
  const since = dateOnly(new Date(Date.now() - 365 * 86_400_000));
  const activities = await prisma.activity.findMany({
    where: { userId, deletedAt: null, date: { gte: since } },
    select: { date: true, isDone: true },
    orderBy: { date: 'asc' },
  });

  // Group by day → qualifies?
  const dayMap = new Map<string, { total: number; done: number }>();
  for (const a of activities) {
    const key = formatDate(a.date);
    const slot = dayMap.get(key) ?? { total: 0, done: 0 };
    slot.total += 1;
    if (a.isDone) slot.done += 1;
    dayMap.set(key, slot);
  }

  const qualifies = (d: { total: number; done: number }) =>
    STREAK_RULE === 'all-done' ? d.total > 0 && d.done === d.total : d.done >= 1;

  const qualifyingDays = [...dayMap.entries()]
    .filter(([, v]) => qualifies(v))
    .map(([k]) => k)
    .sort();

  let longest = 0;
  let run = 0;
  let prev: Date | null = null;
  for (const key of qualifyingDays) {
    const cur = dateOnly(key);
    if (prev && cur.getTime() - prev.getTime() === 86_400_000) run += 1;
    else run = 1;
    longest = Math.max(longest, run);
    prev = cur;
  }

  // Current streak: count back from today (or yesterday) while days qualify.
  const set = new Set(qualifyingDays);
  let current = 0;
  let cursor = dateOnly(new Date());
  if (!set.has(formatDate(cursor))) cursor = new Date(cursor.getTime() - 86_400_000);
  while (set.has(formatDate(cursor))) {
    current += 1;
    cursor = new Date(cursor.getTime() - 86_400_000);
  }

  return { rule: STREAK_RULE, currentStreak: current, longestStreak: longest };
}

export async function moodTrend(userId: string, q: StatsRangeQuery) {
  const { from, to } = defaultRange(q);
  const notes = await prisma.dayNote.findMany({
    where: { userId, deletedAt: null, date: { gte: from, lte: to }, mood: { not: null } },
    select: { date: true, mood: true },
    orderBy: { date: 'asc' },
  });
  return {
    range: { from: formatDate(from), to: formatDate(to) },
    points: notes.map((n) => ({ date: formatDate(n.date), mood: n.mood })),
  };
}

function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
