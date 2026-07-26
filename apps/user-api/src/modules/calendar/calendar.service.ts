import { addDays, dateOnly, formatDate, type CalendarRangeQuery } from '@life-planner/shared-utils';
import { Prisma, prisma } from '@life-planner/database';

const include = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  tags: { select: { id: true, name: true, color: true } },
} satisfies Prisma.ActivityInclude;

/** Returns days in [from, to] each carrying its activities (+ category color) and day note. */
export async function getRange(userId: string, q: CalendarRangeQuery) {
  const from = dateOnly(q.from);
  const to = dateOnly(q.to);

  const [activities, notes] = await Promise.all([
    prisma.activity.findMany({
      where: { userId, deletedAt: null, date: { gte: from, lte: to } },
      include,
      orderBy: [{ date: 'asc' }, { order: 'asc' }],
    }),
    prisma.dayNote.findMany({
      where: { userId, deletedAt: null, date: { gte: from, lte: to } },
    }),
  ]);

  const byDate = new Map<string, { date: string; activities: typeof activities; note: unknown }>();
  for (let d = from; d.getTime() <= to.getTime(); d = addDays(d, 1)) {
    byDate.set(formatDate(d), { date: formatDate(d), activities: [], note: null });
  }
  for (const a of activities) {
    const key = formatDate(a.date);
    byDate.get(key)?.activities.push(a);
  }
  for (const n of notes) {
    const slot = byDate.get(formatDate(n.date));
    if (slot) slot.note = n;
  }

  return { from: q.from, to: q.to, days: [...byDate.values()] };
}

/** 7 day-columns starting at `start`. */
export function getWeek(userId: string, start: string) {
  const from = dateOnly(start);
  const to = addDays(from, 6);
  return getRange(userId, { from: formatDate(from), to: formatDate(to) });
}
