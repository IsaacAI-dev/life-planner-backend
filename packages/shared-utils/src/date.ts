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

export function startOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month - 1, 1));
}

export function endOfMonth(year: number, month: number): Date {
  return new Date(Date.UTC(year, month, 0));
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
