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

export const PAGE_SIZE_DEFAULT = 25;
export const PAGE_SIZE_MAX = 100;

export const ACCESS_TOKEN_TTL_DEFAULT = '15m';
export const REFRESH_TOKEN_TTL_DAYS_DEFAULT = 30;
