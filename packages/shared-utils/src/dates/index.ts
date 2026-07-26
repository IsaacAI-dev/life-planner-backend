// rrule v2 ships a UMD/CJS bundle as its `main` (no `exports` map, no `"type":
// "module"`), so Node's ESM loader can't statically detect its named exports
// and `import { RRule } from 'rrule'` throws ERR at runtime. The default import
// resolves to the whole module.exports object, so we destructure from that.
import RRulePkg from 'rrule';
import type { RRule as RRuleInstance } from 'rrule';

const { RRule, rrulestr } = RRulePkg;

/**
 * Date-only handling: all calendar `date` columns are @db.Date. We represent a
 * calendar day as a JS Date pinned to UTC midnight so range queries and
 * equality are timezone-stable. Time-of-day lives separately in startTime/endTime
 * strings interpreted in the user's timezone.
 */

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Parse a "YYYY-MM-DD" string into a UTC-midnight Date. */
export function dateOnly(input: string | Date): Date {
  if (input instanceof Date) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const [y, m, d] = input.split('-').map(Number);
  return new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1));
}

/** Format a Date as "YYYY-MM-DD" (UTC). */
export function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Day-of-week in UTC: 0=Sun .. 6=Sat. */
export function dayOfWeek(d: Date): number {
  return d.getUTCDay();
}

export function isWeekend(d: Date): boolean {
  const dow = dayOfWeek(d);
  return dow === 0 || dow === 6;
}

export function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * MS_PER_DAY);
}

export interface ExpandRangeOptions {
  excludeWeekends?: boolean;
  /** Whitelist of weekdays (0=Sun..6=Sat). If provided, only these are kept. */
  daysOfWeek?: number[];
}

/**
 * Expand an inclusive [start, end] date range into an array of UTC-midnight Dates,
 * honoring excludeWeekends and an optional daysOfWeek whitelist.
 */
export function expandRange(
  start: string | Date,
  end: string | Date,
  opts: ExpandRangeOptions = {},
): Date[] {
  const from = dateOnly(start);
  const to = dateOnly(end);
  if (to.getTime() < from.getTime()) {
    throw new Error('rangeEnd must be on or after rangeStart');
  }
  const whitelist = opts.daysOfWeek ? new Set(opts.daysOfWeek) : null;
  const out: Date[] = [];
  for (let cur = from; cur.getTime() <= to.getTime(); cur = addDays(cur, 1)) {
    if (opts.excludeWeekends && isWeekend(cur)) continue;
    if (whitelist && !whitelist.has(dayOfWeek(cur))) continue;
    out.push(new Date(cur));
  }
  return out;
}

/** Days between two dates (inclusive of both ends counts as +1). */
export function daysBetween(a: Date, b: Date): number {
  return Math.round((dateOnly(b).getTime() - dateOnly(a).getTime()) / MS_PER_DAY);
}

/** Offset (ms) of a timezone relative to UTC at the given instant. UTC+1 → +3600000. */
function tzOffsetMs(at: Date, timeZone: string): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
  const map: Record<string, number> = {};
  for (const p of dtf.formatToParts(at)) {
    if (p.type !== 'literal') map[p.type] = Number(p.value);
  }
  const asUTC = Date.UTC(map.year!, map.month! - 1, map.day!, map.hour!, map.minute!, map.second!);
  return asUTC - at.getTime();
}

/**
 * Returns the UTC instants [start, end) bounding the calendar day that `at` falls
 * on in the given IANA timezone. Used for timezone-correct "messages sent today"
 * counting. Falls back to a plain UTC day if the timezone is invalid.
 */
export function dayRangeInTimezone(
  at: Date,
  timeZone: string,
): { start: Date; end: Date } {
  try {
    const offset = tzOffsetMs(at, timeZone);
    // Local wall-clock date for `at` in the target zone.
    const local = new Date(at.getTime() + offset);
    const startUtcMs =
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate()) - offset;
    return { start: new Date(startUtcMs), end: new Date(startUtcMs + MS_PER_DAY) };
  } catch {
    const start = dateOnly(at);
    return { start, end: addDays(start, 1) };
  }
}

/**
 * Expand an iCal RRULE into occurrence dates within (after, before], used by the
 * recurring materializer. `dtstart` anchors the rule. Returns UTC-midnight dates.
 */
export function expandRRule(
  rrule: string,
  dtstart: Date,
  after: Date,
  before: Date,
): Date[] {
  // Allow either a bare "FREQ=..." or a full "RRULE:FREQ=..." string.
  const ruleString = rrule.startsWith('RRULE:') || rrule.includes('DTSTART')
    ? rrule
    : `RRULE:${rrule}`;

  let rule: RRuleInstance;
  const parsed = rrulestr(ruleString, { dtstart: dateOnly(dtstart) });
  rule = parsed instanceof RRule ? parsed : RRule.fromString(parsed.toString());

  // between() is exclusive on both bounds by default; pass inc=true to include.
  return rule.between(dateOnly(after), dateOnly(before), true).map((d) => dateOnly(d));
}

/** Validate that a string is a parseable RRULE. Returns true/false. */
export function isValidRRule(rrule: string): boolean {
  try {
    const ruleString = rrule.startsWith('RRULE:') ? rrule : `RRULE:${rrule}`;
    rrulestr(ruleString);
    return true;
  } catch {
    return false;
  }
}

export { RRule };
