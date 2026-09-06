import { prisma, type Prisma } from '@lifeplanner/database';
import { eachDayInRange, parseDateOnly, toDateOnlyString } from '@lifeplanner/shared-utils';

const activityInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  tags: { select: { id: true, name: true, color: true } },
} satisfies Prisma.ActivityInclude;

const serialize = (a: Record<string, unknown>) => ({
  ...a,
  date: a.date ? toDateOnlyString(a.date as Date) : null,
  windowStart: a.windowStart ? toDateOnlyString(a.windowStart as Date) : null,
  windowEnd: a.windowEnd ? toDateOnlyString(a.windowEnd as Date) : null,
  isFlexible: a.date === null,
});

/**
 * Admin board view — same shape as the user-facing calendar, but unconditionally
 * includes isPrivate activities and requires no BoardShare: moderation needs
 * full visibility (Addendum 2 §18.6).
 */
export async function buildAdminBoard(userId: string, from: string, to: string) {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);

  const [dated, flexible, notes] = await Promise.all([
    prisma.activity.findMany({
      where: { userId, deletedAt: null, date: { gte: start, lte: end } },
      include: activityInclude,
      orderBy: [{ date: 'asc' }, { order: 'asc' }],
    }),
    prisma.activity.findMany({
      where: {
        userId,
        deletedAt: null,
        date: null,
        windowStart: { lte: end },
        windowEnd: { gte: start },
      },
      include: activityInclude,
      orderBy: [{ windowStart: 'asc' }],
    }),
    prisma.dayNote.findMany({ where: { userId, date: { gte: start, lte: end } } }),
  ]);

  const byDay = new Map<string, typeof dated>();
  for (const activity of dated) {
    const key = toDateOnlyString(activity.date as Date);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(activity);
    else byDay.set(key, [activity]);
  }
  const noteByDay = new Map(notes.map((n) => [toDateOnlyString(n.date), n]));

  const days = eachDayInRange(start, end).map((day) => {
    const key = toDateOnlyString(day);
    const activities = byDay.get(key) ?? [];
    return {
      date: key,
      activities: activities.map(serialize),
      note: noteByDay.get(key) ?? null,
      total: activities.length,
      done: activities.filter((a) => a.isDone).length,
    };
  });

  return {
    from: toDateOnlyString(start),
    to: toDateOnlyString(end),
    days,
    flexibleTasks: flexible.map(serialize),
    totals: {
      activities: dated.length,
      done: dated.filter((a) => a.isDone).length,
      flexible: flexible.length,
      private: [...dated, ...flexible].filter((a) => a.isPrivate).length,
    },
  };
}
