/**
 * Date-only helpers. Every `@db.Date` column is stored/compared as UTC midnight
 * so that "2026-06-22" round-trips regardless of server timezone.
 */

export const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function parseDateOnly(value: string | Date): Date {
  if (value instanceof Date) {
    return new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()));
  }
  if (!DATE_ONLY_RE.test(value)) {
    throw new Error(`Invalid date-only value: ${value}`);
  }
  const [y, m, d] = value.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d));
}

export function toDateOnlyString(value: Date | string): string {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: Date, days: number): Date {
  const copy = new Date(date.getTime());
  copy.setUTCDate(copy.getUTCDate() + days);
  return copy;
}

export function diffInDays(a: Date, b: Date): number {
  return Math.round((parseDateOnly(a).getTime() - parseDateOnly(b).getTime()) / 86_400_000);
}

export function eachDayInRange(from: Date, to: Date): Date[] {
  const out: Date[] = [];
  let cursor = parseDateOnly(from);
  const end = parseDateOnly(to);
  while (cursor.getTime() <= end.getTime()) {
    out.push(cursor);
    cursor = addDays(cursor, 1);
  }
  return out;
}

/** 0 = Sunday ... 6 = Saturday (UTC). */
export function dayOfWeek(date: Date): number {
  return parseDateOnly(date).getUTCDay();
}

export function isWeekend(date: Date): boolean {
  const dow = dayOfWeek(date);
  return dow === 0 || dow === 6;
}

/** Start of the week containing `date`, honouring weekStartsOn (0=Sun, 1=Mon). */
export function startOfWeek(date: Date, weekStartsOn = 1): Date {
  const d = parseDateOnly(date);
  const diff = (d.getUTCDay() - weekStartsOn + 7) % 7;
  return addDays(d, -diff);
}

export function endOfWeek(date: Date, weekStartsOn = 1): Date {
  return addDays(startOfWeek(date, weekStartsOn), 6);
}

/**
 * Minutes between two "HH:mm" strings. Null when either side is missing or the
 * span is not positive — callers decide what an untimed activity is worth, so
 * the fallback is never buried in here.
 */
export function minutesBetweenTimes(
  startTime?: string | null,
  endTime?: string | null,
): number | null {
  if (!startTime || !endTime) return null;
  if (!TIME_RE.test(startTime) || !TIME_RE.test(endTime)) return null;
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  const diff = eh * 60 + em - (sh * 60 + sm);
  return diff > 0 ? diff : null;
}

/**
 * "0m", "45m", "2h", "1h 30m" — the exact strings the Insights cards render, so
 * the number and its label can never disagree between server and client.
 */
export function formatMinutes(totalMinutes: number): string {
  const minutes = Math.max(0, Math.round(totalMinutes));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes}m`;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** Single letters for the daily-activity axis: M T W T F S S. */
export const WEEKDAY_INITIALS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'] as const;
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;

export function weekdayInitial(date: Date): string {
  return WEEKDAY_INITIALS[dayOfWeek(date)];
}

export function weekdayShort(date: Date): string {
  return WEEKDAY_SHORT[dayOfWeek(date)];
}

export function startOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

export function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
}

export function startOfQuarter(date: Date): Date {
  const d = parseDateOnly(date);
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
}

export function endOfQuarter(date: Date): Date {
  const start = startOfQuarter(date);
  return new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 3, 0));
}

export type StatsPeriod = 'week' | 'month' | 'quarter';

/**
 * The Insights header offers Week / Month / Quarter. Resolving that to a
 * concrete range lives here so the same three words always mean the same three
 * ranges, whichever endpoint is asked. `anchor` is any day inside the period.
 */
export function resolvePeriodRange(
  period: StatsPeriod,
  anchor: Date | string = new Date(),
  weekStartsOn = 1,
): { from: Date; to: Date } {
  const day = parseDateOnly(anchor);
  if (period === 'week') {
    const from = startOfWeek(day, weekStartsOn);
    return { from, to: addDays(from, 6) };
  }
  if (period === 'month') {
    return {
      from: startOfMonth(day.getUTCFullYear(), day.getUTCMonth() + 1),
      to: endOfMonth(day.getUTCFullYear(), day.getUTCMonth() + 1),
    };
  }
  return { from: startOfQuarter(day), to: endOfQuarter(day) };
}

/** The period immediately before the given one — used for "vs last week" deltas. */
export function previousPeriodRange(
  period: StatsPeriod,
  from: Date,
  weekStartsOn = 1,
): { from: Date; to: Date } {
  const start = parseDateOnly(from);
  if (period === 'week') return resolvePeriodRange('week', addDays(start, -7), weekStartsOn);
  if (period === 'month') {
    const previous = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    return resolvePeriodRange('month', previous, weekStartsOn);
  }
  const previous = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1));
  return resolvePeriodRange('quarter', previous, weekStartsOn);
}

/** ISO-8601 week key, e.g. "2026-W26" — the bucketing pattern the stats module uses. */
export function isoWeekKey(date: Date): string {
  const d = parseDateOnly(date);
  const dayNum = (d.getUTCDay() + 6) % 7; // Mon = 0
  d.setUTCDate(d.getUTCDate() - dayNum + 3); // nearest Thursday
  const isoYear = d.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(isoYear, 0, 4));
  const firstDayNum = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - firstDayNum + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return `${isoYear}-W${String(week).padStart(2, '0')}`;
}

export function monthKey(date: Date): string {
  return toDateOnlyString(date).slice(0, 7);
}

/** Bucket key for analytics rollups. */
export function bucketKey(date: Date, granularity: 'day' | 'week' | 'month'): string {
  if (granularity === 'week') return isoWeekKey(date);
  if (granularity === 'month') return monthKey(date);
  return toDateOnlyString(date);
}

/** Start/end of a UTC day as full timestamps (for createdAt-style range queries). */
export function dayRangeUtc(from: Date | string, to: Date | string): { gte: Date; lte: Date } {
  const start = parseDateOnly(from);
  const end = parseDateOnly(to);
  return { gte: start, lte: new Date(end.getTime() + 86_399_999) };
}
