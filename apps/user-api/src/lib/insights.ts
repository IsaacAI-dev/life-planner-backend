import {
  DEFAULT_ACTIVITY_MINUTES,
  STREAK_RULE,
  addDays,
  minutesBetweenTimes,
  parseDateOnly,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';

/**
 * Streak and duration maths shared by GET /stats/streaks and GET /stats/insights.
 * Both endpoints answer the same question ("how many days in a row?"), so they
 * answer it with the same code — the Insights card and the streak endpoint can
 * never disagree.
 */

export interface DayTally {
  total: number;
  done: number;
}

export interface DatedRow {
  date: Date | null;
  isDone: boolean;
}

/** Minutes an activity occupies on the chart; untimed rows get the default. */
export const activityMinutes = (
  startTime: string | null,
  endTime: string | null,
): number => minutesBetweenTimes(startTime, endTime) ?? DEFAULT_ACTIVITY_MINUTES;

/** Groups dated rows into per-day totals keyed by "YYYY-MM-DD". */
export function tallyByDay(rows: DatedRow[]): Map<string, DayTally> {
  const byDay = new Map<string, DayTally>();
  for (const row of rows) {
    if (!row.date) continue;
    const key = toDateOnlyString(row.date);
    const bucket = byDay.get(key) ?? { total: 0, done: 0 };
    bucket.total += 1;
    if (row.isDone) bucket.done += 1;
    byDay.set(key, bucket);
  }
  return byDay;
}

/** Base spec §7.9 — whether a day counts toward a streak under the active rule. */
export const dayQualifies = (day: DayTally | undefined): boolean => {
  if (!day || day.total === 0) return false;
  return STREAK_RULE === 'ALL_ACTIVITIES_DONE' ? day.done === day.total : day.done > 0;
};

export interface StreakSummary {
  rule: typeof STREAK_RULE;
  currentStreak: number;
  longestStreak: number;
  daysTracked: number;
  /** True when today itself already qualifies, so the UI can say "kept today". */
  activeToday: boolean;
}

/**
 * Current and longest streak from a day tally. `today` is injectable so the
 * calculation is testable without freezing the clock.
 */
export function computeStreaks(byDay: Map<string, DayTally>, today = new Date()): StreakSummary {
  const sortedKeys = [...byDay.keys()].sort();

  let longest = 0;
  let running = 0;
  let previous: string | null = null;
  for (const key of sortedKeys) {
    if (!dayQualifies(byDay.get(key))) {
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

  // The current streak walks backwards from today, or from yesterday when today
  // is simply not finished yet — an unfinished today must not break a streak.
  const anchor = parseDateOnly(today);
  const activeToday = dayQualifies(byDay.get(toDateOnlyString(anchor)));
  let cursor = activeToday ? anchor : addDays(anchor, -1);
  let current = 0;
  while (dayQualifies(byDay.get(toDateOnlyString(cursor)))) {
    current += 1;
    cursor = addDays(cursor, -1);
  }

  return {
    rule: STREAK_RULE,
    currentStreak: current,
    longestStreak: longest,
    daysTracked: byDay.size,
    activeToday,
  };
}

/** Whole percent, guarding the divide-by-zero the empty state always hits. */
export const percentOf = (part: number, whole: number): number =>
  whole === 0 ? 0 : Math.round((part / whole) * 100);
