import { prisma, type Prisma } from '@lifeplanner/database';
import { eachDayInRange, parseDateOnly, toDateOnlyString } from '@lifeplanner/shared-utils';
import { activityInclude } from './prismaHelpers.js';
import { serializeActivity } from './serializers.js';

export interface BoardOptions {
  userId: string;
  from: string | Date;
  to: string | Date;
  /**
   * Addendum 2 §18.1 — privacy is enforced purely at read time on paths that
   * cross a user boundary. Owners and admins pass true; a PUBLIC_ONLY viewer
   * passes false, which drops isPrivate rows from the result.
   */
  includePrivate: boolean;
  includeDayNotes?: boolean;
}

export interface BoardDay {
  date: string;
  activities: ReturnType<typeof serializeActivity>[];
  /**
   * Read-only overlay from a connected calendar. Deliberately a separate list
   * from `activities`: these are not editable, do not count toward quota and
   * must not affect streaks, so `total` and `done` ignore them entirely.
   */
  importedEvents: {
    id: string;
    title: string;
    startTime: string | null;
    endTime: string | null;
    allDay: boolean;
    location: string | null;
    source: string;
  }[];
  note?: unknown;
  total: number;
  done: number;
}

export interface Board {
  from: string;
  to: string;
  days: BoardDay[];
  /**
   * Addendum 2 §18.3 — flexible tasks don't belong to any single day, so they
   * ride alongside the day buckets rather than inside them.
   */
  flexibleTasks: ReturnType<typeof serializeActivity>[];
  totals: { activities: number; done: number; flexible: number };
}

export async function buildBoard(options: BoardOptions): Promise<Board> {
  const from = parseDateOnly(options.from);
  const to = parseDateOnly(options.to);

  const privacyFilter: Prisma.ActivityWhereInput = options.includePrivate ? {} : { isPrivate: false };

  const [dated, flexible, notes, imported] = await Promise.all([
    prisma.activity.findMany({
      where: {
        userId: options.userId,
        deletedAt: null,
        date: { gte: from, lte: to },
        ...privacyFilter,
      },
      include: activityInclude,
      orderBy: [{ date: 'asc' }, { order: 'asc' }, { startTime: 'asc' }],
    }),
    prisma.activity.findMany({
      where: {
        userId: options.userId,
        deletedAt: null,
        date: null,
        // window overlaps the requested range
        windowStart: { lte: to },
        windowEnd: { gte: from },
        ...privacyFilter,
      },
      include: activityInclude,
      orderBy: [{ windowStart: 'asc' }, { createdAt: 'asc' }],
    }),
    options.includeDayNotes
      ? prisma.dayNote.findMany({
          where: { userId: options.userId, date: { gte: from, lte: to } },
        })
      : Promise.resolve([]),
    // Only for the board owner: a shared board never leaks somebody's synced
    // calendar, which they connected for themselves rather than to publish.
    options.includePrivate
      ? prisma.importedEvent.findMany({
          where: { userId: options.userId, date: { gte: from, lte: to } },
          include: { connection: { select: { provider: true, label: true } } },
          orderBy: [{ date: 'asc' }, { startTime: 'asc' }],
        })
      : Promise.resolve([]),
  ]);

  const byDay = new Map<string, typeof dated>();
  for (const activity of dated) {
    const key = toDateOnlyString(activity.date as Date);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(activity);
    else byDay.set(key, [activity]);
  }

  const noteByDay = new Map(notes.map((n) => [toDateOnlyString(n.date), n]));

  const importedByDay = new Map<string, typeof imported>();
  for (const event of imported) {
    const key = toDateOnlyString(event.date);
    importedByDay.set(key, [...(importedByDay.get(key) ?? []), event]);
  }

  const days: BoardDay[] = eachDayInRange(from, to).map((day) => {
    const key = toDateOnlyString(day);
    const activities = byDay.get(key) ?? [];
    return {
      date: key,
      activities: activities.map(serializeActivity),
      importedEvents: (importedByDay.get(key) ?? []).map((e) => ({
        id: e.id,
        title: e.title,
        startTime: e.startTime,
        endTime: e.endTime,
        allDay: e.allDay,
        location: e.location,
        source: e.connection.label || e.connection.provider,
      })),
      note: noteByDay.get(key) ?? null,
      total: activities.length,
      done: activities.filter((a) => a.isDone).length,
    };
  });

  return {
    from: toDateOnlyString(from),
    to: toDateOnlyString(to),
    days,
    flexibleTasks: flexible.map(serializeActivity),
    totals: {
      activities: dated.length,
      done: dated.filter((a) => a.isDone).length,
      flexible: flexible.length,
    },
  };
}
