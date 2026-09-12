export const DEFAULT_CATEGORIES = [
  { name: 'Work', color: '#2563EB', icon: 'briefcase', order: 0 },
  { name: 'Health', color: '#16A34A', icon: 'heart', order: 1 },
  { name: 'Personal', color: '#DB2777', icon: 'user', order: 2 },
  { name: 'Learning', color: '#7C3AED', icon: 'book', order: 3 },
  { name: 'Errands', color: '#EA580C', icon: 'shopping-bag', order: 4 },
] as const;

/**
 * Addendum 2 §17.5 — colors are fixed per budget category, not per expense,
 * mirroring how DEFAULT_CATEGORIES ships planner colors. Returned alongside
 * category totals by the summary endpoint so the frontend never hardcodes them.
 */
export const BUDGET_CATEGORY_COLORS: Record<'MANDATORY' | 'SECONDARY' | 'OPTIONAL', string> = {
  MANDATORY: '#DC2626',
  SECONDARY: '#D97706',
  OPTIONAL: '#0891B2',
};

export const BUDGET_CATEGORY_ORDER = ['MANDATORY', 'SECONDARY', 'OPTIONAL'] as const;

/**
 * Base spec §7.9 — which rule counts a day toward a streak.
 * 'ALL_ACTIVITIES_DONE'  : every dated activity on that day is complete.
 * 'ANY_ACTIVITY_DONE'    : at least one dated activity on that day is complete.
 * Named as a constant so switching the business rule is a one-line change.
 *
 * Flexible tasks (date: null) are intentionally excluded from streaks — they do
 * not belong to a single day. See Addendum 2 §17.2 and §23.
 */
export const STREAK_RULE: 'ALL_ACTIVITIES_DONE' | 'ANY_ACTIVITY_DONE' = 'ALL_ACTIVITIES_DONE';

/**
 * An activity with no start/end time still has to occupy space on the Insights
 * chart, so it is counted as this many minutes. Named here rather than inlined
 * in the stats module because the batch and session endpoints read it too.
 */
export const DEFAULT_ACTIVITY_MINUTES = 30;

/**
 * Activities with no category are grouped under a synthetic life area. The id
 * is a sentinel, not a row — the frontend keys off it and must never PATCH it.
 */
export const UNCATEGORIZED_AREA = {
  id: 'uncategorized',
  name: 'Uncategorized',
  color: '#94A3B8',
  icon: null,
} as const;

/** The three ranges behind the Week / Month / Quarter toggle on Insights. */
export const STATS_PERIODS = ['week', 'month', 'quarter'] as const;

/** Above this many days the daily chart rolls up to weekly buckets instead. */
export const DAILY_BUCKET_MAX_DAYS = 31;

/** A bulk create never exceeds this, so neither does a batch edit. */
export const MAX_BATCH_ACTIVITIES = 366;

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

export const ACCESS_TOKEN_TTL_DEFAULT = '15m';
export const REFRESH_TOKEN_TTL_DAYS_DEFAULT = 30;
