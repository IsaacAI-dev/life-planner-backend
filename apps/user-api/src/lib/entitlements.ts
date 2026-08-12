import type { RequestHandler } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  addDays,
  limitsForState,
  parseDateOnly,
  startOfWeek,
  type PlanLimits,
} from '@lifeplanner/shared-utils';
import { env } from '../config/env.js';
import { currentUser } from '../middleware/auth.js';

export interface SeatSource {
  /** Who is paying for this person's access. Name only — nothing else leaks. */
  providerName: string;
  providerEmail: string;
  seatId: string;
  endsAt: string | null;
}

export interface Entitlements {
  tier: 'FREE' | 'PRO';
  /** Whether Pro comes from this person's own plan or a seat on someone else's. */
  source: 'OWN' | 'SEAT';
  seat: SeatSource | null;
  /** Seats this person is paying for, when they are the payer. */
  seatCount: number;
  status: 'ACTIVE' | 'TRIALING' | 'PAST_DUE' | 'EXPIRED' | 'CANCELLED';
  interval: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL' | null;
  currency: string | null;
  amount: number | null;
  renewsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  provider: string | null;
  platform: string | null;
  limits: PlanLimits;
  usage: { activitiesThisWeek: number; goals: number };
}

const overrides = {
  freeActivitiesPerWeek: env.FREE_MAX_ACTIVITIES_PER_WEEK,
  freeGoals: env.FREE_MAX_GOALS,
};

/** Everyone has a row; a user who never paid is FREE/ACTIVE. */
export async function ensureSubscription(userId: string) {
  return prisma.subscription.upsert({
    where: { userId },
    update: {},
    create: { userId, tier: 'FREE', status: 'ACTIVE' },
  });
}

/**
 * Lapsed-but-not-yet-swept plans are treated as expired at read time, so
 * entitlement never depends on a cron job having run.
 */
function effectiveStatus(sub: {
  status: string;
  currentPeriodEnd: Date | null;
  tier: string;
}): Entitlements['status'] {
  if (sub.tier === 'FREE') return 'ACTIVE';
  const lapsed = sub.currentPeriodEnd !== null && sub.currentPeriodEnd.getTime() < Date.now();
  if (lapsed && sub.status !== 'EXPIRED') return 'EXPIRED';
  return sub.status as Entitlements['status'];
}

/**
 * Usage is returned alongside limits in one call so the client can render
 * "3 / 5 activities this week" without a second round trip, and so the quota
 * rule stays server-side. The week window honours settings.weekStartsOn.
 */
export async function getEntitlements(userId: string): Promise<Entitlements> {
  const [sub, settings, seat] = await Promise.all([
    ensureSubscription(userId),
    prisma.userSettings.findUnique({ where: { userId }, select: { weekStartsOn: true } }),
    // A seat on somebody else's plan grants the same entitlement as owning one.
    prisma.subscriptionSeat.findFirst({
      where: { memberUserId: userId, status: 'ACTIVE' },
      select: {
        id: true,
        endsAt: true,
        subscription: {
          select: {
            tier: true,
            status: true,
            currentPeriodEnd: true,
            interval: true,
            user: { select: { name: true, email: true } },
          },
        },
      },
    }),
  ]);

  let status = effectiveStatus(sub);
  let tier = sub.tier as 'FREE' | 'PRO';
  let source: 'OWN' | 'SEAT' = 'OWN';
  let seatSource: SeatSource | null = null;

  // Own plan wins; a seat only fills in when the person is not already Pro.
  if (tier !== 'PRO' && seat) {
    const payer = seat.subscription;
    const payerLapsed =
      payer.currentPeriodEnd !== null && payer.currentPeriodEnd.getTime() < Date.now();
    const seatLapsed = seat.endsAt !== null && seat.endsAt.getTime() < Date.now();

    if (payer.tier === 'PRO' && payer.status !== 'EXPIRED' && !payerLapsed && !seatLapsed) {
      tier = 'PRO';
      status = 'ACTIVE';
      source = 'SEAT';
      seatSource = {
        providerName: payer.user.name,
        providerEmail: payer.user.email,
        seatId: seat.id,
        endsAt: seat.endsAt ? seat.endsAt.toISOString() : null,
      };
    }
  }
  const weekStart = startOfWeek(parseDateOnly(new Date()), settings?.weekStartsOn ?? 1);
  const weekEnd = addDays(weekStart, 6);

  const [activitiesThisWeek, goals] = await Promise.all([
    prisma.activity.count({
      where: {
        userId,
        deletedAt: null,
        OR: [
          { date: { gte: weekStart, lte: weekEnd } },
          // Flexible tasks count in the week their window opens.
          { date: null, windowStart: { lte: weekEnd }, windowEnd: { gte: weekStart } },
        ],
      },
    }),
    prisma.goal.count({ where: { userId, deletedAt: null, status: { not: 'ARCHIVED' } } }),
  ]);

  return {
    tier,
    status,
    source,
    seat: seatSource,
    seatCount: sub.seatCount,
    interval: source === 'SEAT' ? null : sub.interval,
    currency: sub.currency,
    // A seat holder pays nothing and sees no billing detail of the payer's.
    amount: source === 'SEAT' || sub.amount === null ? null : Number(sub.amount),
    renewsAt: source === 'SEAT' ? null : sub.renewsAt ? sub.renewsAt.toISOString() : null,
    currentPeriodEnd:
      source === 'SEAT' ? null : sub.currentPeriodEnd ? sub.currentPeriodEnd.toISOString() : null,
    cancelAtPeriodEnd: source === 'SEAT' ? false : sub.cancelAtPeriodEnd,
    provider: source === 'SEAT' ? null : sub.provider,
    platform: source === 'SEAT' ? null : sub.platform,
    limits: limitsForState(tier, status, overrides),
    usage: { activitiesThisWeek, goals },
  };
}

// ---------------------------------------------------------------------------
// Gates
// ---------------------------------------------------------------------------

export const PAYMENT_REQUIRED = 402;

const featureError = (feature: string) =>
  new AppError(
    PAYMENT_REQUIRED,
    ErrorCode.FORBIDDEN,
    `${feature} is part of Life Planner Pro. Upgrade to unlock it.`,
    { upgradeRequired: true },
  );

const quotaError = (what: string, limit: number) =>
  new AppError(
    PAYMENT_REQUIRED,
    ErrorCode.FORBIDDEN,
    `You have reached the Free plan limit of ${limit} ${what}. Upgrade for unlimited.`,
    { upgradeRequired: true, limit },
  );

/**
 * Feature gate. Support chat is deliberately never gated — a Free user must
 * always be able to raise a complaint.
 */
export const requireFeature =
  (feature: keyof PlanLimits, label: string): RequestHandler =>
  (req, _res, next) => {
    void (async () => {
      try {
        const me = currentUser(req);
        const ent = await getEntitlements(me.id);
        if (ent.limits[feature] !== true) throw featureError(label);
        req.entitlements = ent;
        next();
      } catch (err) {
        next(err);
      }
    })();
  };

/** Quota gate for activity creation. `count` is how many rows this call adds. */
export async function assertActivityQuota(userId: string, count = 1) {
  const ent = await getEntitlements(userId);
  const limit = ent.limits.activitiesPerWeek;
  if (limit === null) return ent;
  if (ent.usage.activitiesThisWeek + count > limit) {
    throw quotaError('activities this week', limit);
  }
  return ent;
}

export async function assertGoalQuota(userId: string, count = 1) {
  const ent = await getEntitlements(userId);
  const limit = ent.limits.goals;
  if (limit === null) return ent;
  if (ent.usage.goals + count > limit) throw quotaError('goals', limit);
  return ent;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      entitlements?: Entitlements;
    }
  }
}

export const subscriptionInclude = {
  transactions: { orderBy: { occurredAt: 'desc' }, take: 20 },
} satisfies Prisma.SubscriptionInclude;
