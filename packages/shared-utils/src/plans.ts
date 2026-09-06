// ---------------------------------------------------------------------------
// Addendum 3 — plans, entitlements, RBAC, payment routing
// ---------------------------------------------------------------------------

export type Tier = 'FREE' | 'PRO';

export interface PlanLimits {
  /** null = unlimited */
  activitiesPerWeek: number | null;
  goals: number | null;
  chatEnabled: boolean;
  voiceNotesEnabled: boolean;
  mealPlansEnabled: boolean;
  /** Support is the complaints channel and is never gated. */
  supportChatEnabled: boolean;
}

export interface PlanLimitOverrides {
  freeActivitiesPerWeek?: number;
  freeGoals?: number;
}

/**
 * The single source of truth for what a tier permits. The frontend reads these
 * through GET /subscription and never hardcodes a limit, mirroring how
 * BUDGET_CATEGORY_COLORS is handled.
 *
 * Free-tier numbers come from the environment (FREE_MAX_ACTIVITIES_PER_WEEK,
 * FREE_MAX_GOALS) so pricing experiments don't need a deploy.
 */
export function buildPlanLimits(tier: Tier, overrides: PlanLimitOverrides = {}): PlanLimits {
  if (tier === 'PRO') {
    return {
      activitiesPerWeek: null,
      goals: null,
      chatEnabled: true,
      voiceNotesEnabled: true,
      mealPlansEnabled: true,
      supportChatEnabled: true,
    };
  }
  return {
    activitiesPerWeek: overrides.freeActivitiesPerWeek ?? 5,
    goals: overrides.freeGoals ?? 3,
    // Chats are fully behind the paywall now — no daily allowance.
    chatEnabled: false,
    voiceNotesEnabled: false,
    mealPlansEnabled: false,
    supportChatEnabled: true,
  };
}

/** An EXPIRED or CANCELLED-and-lapsed plan drops to zero, not to Free. */
export function limitsForState(
  tier: Tier,
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'EXPIRED' | 'CANCELLED',
  overrides: PlanLimitOverrides = {},
): PlanLimits {
  if (status === 'EXPIRED') {
    return {
      activitiesPerWeek: 0,
      goals: 0,
      chatEnabled: false,
      voiceNotesEnabled: false,
      mealPlansEnabled: false,
      supportChatEnabled: true,
    };
  }
  if (status === 'PAST_DUE' || status === 'CANCELLED') {
    // Still inside a paid period — keep what was paid for.
    return buildPlanLimits(tier, overrides);
  }
  return buildPlanLimits(tier, overrides);
}

// --- RBAC -------------------------------------------------------------------

export const ADMIN_ROLES = [
  'FITNESS_ADMIN',
  'LIFE_COACH_ADMIN',
  'SUPPORT_ADMIN',
  'MANAGER',
  'SUPERADMIN',
] as const;

export type AdminRoleName = (typeof ADMIN_ROLES)[number];

/** Only these two may read other admins' conversations and client lists. */
export const OVERSIGHT_ROLES: AdminRoleName[] = ['MANAGER', 'SUPERADMIN'];

export const hasRole = (roles: string[], ...wanted: AdminRoleName[]) =>
  wanted.some((r) => roles.includes(r));

export const isOversight = (roles: string[]) => hasRole(roles, ...OVERSIGHT_ROLES);

/** Which conversation types a set of roles is allowed to work. */
export function servableConversationTypes(roles: string[]): ('LIFE_COACH' | 'FITNESS' | 'SUPPORT')[] {
  if (isOversight(roles)) return ['LIFE_COACH', 'FITNESS', 'SUPPORT'];
  const out: ('LIFE_COACH' | 'FITNESS' | 'SUPPORT')[] = [];
  if (roles.includes('LIFE_COACH_ADMIN')) out.push('LIFE_COACH');
  if (roles.includes('FITNESS_ADMIN')) out.push('FITNESS');
  if (roles.includes('SUPPORT_ADMIN')) out.push('SUPPORT');
  return out;
}

/** The admin role that staffs each conversation type. */
export const ROLE_FOR_CONVERSATION: Record<string, AdminRoleName> = {
  LIFE_COACH: 'LIFE_COACH_ADMIN',
  FITNESS: 'FITNESS_ADMIN',
  SUPPORT: 'SUPPORT_ADMIN',
};

export const COACH_ROLE_FOR_CONVERSATION: Record<string, 'LIFE_COACH' | 'FITNESS'> = {
  LIFE_COACH: 'LIFE_COACH',
  FITNESS: 'FITNESS',
};

// --- Payment routing --------------------------------------------------------

/**
 * ISO-3166 alpha-2 for the African continent. Web checkout inside this set goes
 * to Paystack (local rails, local currency); everywhere else goes to Paddle,
 * which acts as merchant of record and handles VAT registration for us.
 * Mobile always uses the store, worldwide — Apple and Google require it.
 */
export const AFRICA_COUNTRIES = new Set([
  'DZ', 'AO', 'BJ', 'BW', 'BF', 'BI', 'CV', 'CM', 'CF', 'TD', 'KM', 'CD', 'CG', 'CI', 'DJ',
  'EG', 'GQ', 'ER', 'SZ', 'ET', 'GA', 'GM', 'GH', 'GN', 'GW', 'KE', 'LS', 'LR', 'LY', 'MG',
  'MW', 'ML', 'MR', 'MU', 'YT', 'MA', 'MZ', 'NA', 'NE', 'NG', 'RW', 'RE', 'SH', 'ST', 'SN',
  'SC', 'SL', 'SO', 'ZA', 'SS', 'SD', 'TZ', 'TG', 'TN', 'UG', 'EH', 'ZM', 'ZW',
]);

export type Provider = 'PADDLE' | 'PAYSTACK' | 'APPLE_APP_STORE' | 'GOOGLE_PLAY';
export type Platform = 'WEB' | 'IOS' | 'ANDROID';

export function resolveProvider(platform: Platform, country: string | null | undefined): Provider {
  if (platform === 'IOS') return 'APPLE_APP_STORE';
  if (platform === 'ANDROID') return 'GOOGLE_PLAY';
  return country && AFRICA_COUNTRIES.has(country.toUpperCase()) ? 'PAYSTACK' : 'PADDLE';
}

/** Who legally sells the subscription — determines who remits the VAT. */
export function merchantOfRecord(provider: Provider): string {
  switch (provider) {
    case 'PADDLE':
      return 'PADDLE';
    case 'APPLE_APP_STORE':
      return 'APPLE';
    case 'GOOGLE_PLAY':
      return 'GOOGLE';
    case 'PAYSTACK':
    default:
      return 'SELF';
  }
}

/** Default store commission, before the small-business reduced rate. */
export const STORE_COMMISSION_RATE: Record<string, number> = {
  APPLE_APP_STORE: 0.3,
  GOOGLE_PLAY: 0.3,
};

/**
 * Splits a tax-inclusive gross into net + tax. Store and Paddle payloads report
 * these separately, so this is only the fallback when a provider does not.
 */
export function splitTaxInclusive(gross: number, taxRate: number) {
  const net = taxRate > 0 ? gross / (1 + taxRate) : gross;
  return {
    netAmount: Math.round(net * 100) / 100,
    taxAmount: Math.round((gross - net) * 100) / 100,
  };
}

// --- Chat / media -----------------------------------------------------------

export const CONVERSATION_TYPES = ['LIFE_COACH', 'FITNESS', 'SUPPORT'] as const;

/** Human labels used in system messages and notification copy. */
export const CONVERSATION_LABELS: Record<string, string> = {
  LIFE_COACH: 'Life Coach',
  FITNESS: 'Fitness Assistant',
  SUPPORT: 'Support',
};

/** How long a soft-deleted message is retained before permanent deletion. */
export const MESSAGE_PURGE_DAYS = 30;

/** A message may only be edited by its sender within this window. */
export const MESSAGE_EDIT_WINDOW_MINUTES = 60;

export const ALLOWED_AUDIO_MIME = [
  'audio/webm',
  'audio/ogg',
  'audio/mpeg',
  'audio/mp4',
  'audio/aac',
  'audio/wav',
];

export const ALLOWED_IMAGE_MIME = ['image/jpeg', 'image/png', 'image/webp'];

/** Number of waveform samples computed server-side for a voice note. */
export const WAVEFORM_SAMPLES = 32;

// --- Nutrition --------------------------------------------------------------

export const MEAL_TIMES = [
  'BREAKFAST',
  'MID_MORNING_SNACK',
  'LUNCH',
  'AFTERNOON_SNACK',
  'DINNER',
  'EVENING_SNACK',
  'OTHER',
] as const;

/** Seeded into FoodCategoryTag; a food may carry several of these. */
export const DEFAULT_FOOD_CATEGORIES = [
  { key: 'PROTEIN', label: 'Protein', color: '#DC2626', sortOrder: 0 },
  { key: 'CARBOHYDRATE', label: 'Carbohydrate', color: '#D97706', sortOrder: 1 },
  { key: 'VEGETABLE', label: 'Vegetable', color: '#16A34A', sortOrder: 2 },
  { key: 'FRUIT', label: 'Fruit', color: '#EA580C', sortOrder: 3 },
  { key: 'DAIRY', label: 'Dairy', color: '#0EA5E9', sortOrder: 4 },
  { key: 'FAT_OIL', label: 'Fats & oils', color: '#CA8A04', sortOrder: 5 },
  { key: 'BEVERAGE', label: 'Beverage', color: '#0891B2', sortOrder: 6 },
  { key: 'SNACK', label: 'Snack', color: '#7C3AED', sortOrder: 7 },
  { key: 'LEGUME', label: 'Legume', color: '#65A30D', sortOrder: 8 },
  { key: 'GRAIN', label: 'Grain', color: '#A16207', sortOrder: 9 },
  { key: 'OTHER', label: 'Other', color: '#64748B', sortOrder: 10 },
] as const;

// --- Settings defaults (P-20 restores exactly these) -------------------------

export const DEFAULT_SETTINGS = {
  theme: 'system',
  weekStartsOn: 1,
  defaultCalendarView: 'week',
  excludeWeekendsByDefault: false,
  textScale: 'DEFAULT',
  coachCheckInFrequency: 'DAILY',
  defaultCategoryId: null,
  notifications: { email: true, push: false, dailyReminderTime: '08:00' },
} as const;

// ---------------------------------------------------------------------------
// Seats
// ---------------------------------------------------------------------------

export const MAX_SEATS = 3;

/**
 * Multi-seat discount. A second person is 1.8x and a third 2.5x, so the saving
 * grows with the group while revenue per coached person stays high enough to
 * cover the Life Coach and Fitness Assistant each seat is entitled to.
 *
 * Used to generate catalog prices; the stored PlanCatalogEntry amount is
 * authoritative once written, so a market can be priced off-curve by hand.
 */
export const SEAT_MULTIPLIER: Record<number, number> = {
  1: 1,
  2: 1.8,
  3: 2.5,
};

export const seatPrice = (soloAmount: number, seats: number): number =>
  Math.round(soloAmount * (SEAT_MULTIPLIER[seats] ?? seats) * 100) / 100;

/** Per-person cost, for the "save 40%" style line on the pricing card. */
export const seatSavingPercent = (seats: number): number => {
  const multiplier = SEAT_MULTIPLIER[seats] ?? seats;
  return Math.round((1 - multiplier / seats) * 100);
};

/** Why a beneficiary cannot be added — each maps to specific copy. */
export type BeneficiaryIssue =
  | 'SELF'
  | 'ALREADY_PRO'
  | 'ALREADY_SEATED'
  | 'SUSPENDED'
  | 'BANNED'
  | 'DUPLICATE';

export const BENEFICIARY_MESSAGES: Record<BeneficiaryIssue, string> = {
  SELF: 'This is your own address — your plan already covers you.',
  ALREADY_PRO: 'This person already has their own Pro plan. They will need to cancel it before joining yours.',
  ALREADY_SEATED: 'This person is already on somebody else’s plan.',
  SUSPENDED: 'This account is suspended and cannot be added right now.',
  BANNED: 'This account cannot be added.',
  DUPLICATE: 'You have entered this address twice.',
};

/** How long an unclaimed seat invitation stays valid. */
export const SEAT_INVITE_TTL_DAYS = 14;

/**
 * How long a "this wasn't me" link stays live. Deliberately longer than the
 * invite itself — someone reading an old email should still be able to report
 * it after the invitation has lapsed.
 */
export const SECURITY_ACTION_TTL_DAYS = 30;
