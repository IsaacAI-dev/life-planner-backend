import { prisma, type Prisma } from '@lifeplanner/database';
import { CONVERSATION_LABELS } from '@lifeplanner/shared-utils';
import { logger } from './logger.js';
import { notify } from './notify.js';

type CoachRole = 'LIFE_COACH' | 'FITNESS';

const ROLE_REQUIRED: Record<CoachRole, 'LIFE_COACH_ADMIN' | 'FITNESS_ADMIN'> = {
  LIFE_COACH: 'LIFE_COACH_ADMIN',
  FITNESS: 'FITNESS_ADMIN',
};

/**
 * Least-loaded round robin: pick the available admin holding the right role who
 * currently carries the fewest active clients, skipping anyone at capacity.
 * Ties break on id, so the choice is deterministic and testable.
 */
export async function pickCoach(role: CoachRole): Promise<string | null> {
  const candidates = await prisma.admin.findMany({
    where: {
      deletedAt: null,
      isAvailable: true,
      roles: { has: ROLE_REQUIRED[role] },
    },
    select: {
      id: true,
      maxClients: true,
      _count: { select: { coachAssignments: { where: { status: 'ACTIVE', role } } } },
    },
    orderBy: { id: 'asc' },
  });

  const withRoom = candidates.filter((c) => c._count.coachAssignments < c.maxClients);
  if (withRoom.length === 0) {
    logger.warn({ role }, 'No coach has capacity — assignment deferred');
    return null;
  }
  withRoom.sort((a, b) => a._count.coachAssignments - b._count.coachAssignments);
  return withRoom[0].id;
}

/**
 * Called whenever a subscription becomes PRO. Idempotent: an existing ACTIVE
 * assignment for a role is left alone, so a renewal never reshuffles coaches.
 */
export async function assignCoaches(userId: string, assignedByAdminId?: string) {
  const roles: CoachRole[] = ['LIFE_COACH', 'FITNESS'];
  const assigned: { role: CoachRole; adminId: string }[] = [];

  for (const role of roles) {
    const existing = await prisma.coachAssignment.findFirst({
      where: { userId, role, status: 'ACTIVE' },
      select: { id: true, adminId: true },
    });
    if (existing) {
      assigned.push({ role, adminId: existing.adminId });
      continue;
    }

    const adminId = await pickCoach(role);
    if (!adminId) continue;

    await prisma.coachAssignment.create({
      data: { userId, adminId, role, assignedByAdminId: assignedByAdminId ?? null },
    });

    // Open the matching conversation so the person has somewhere to talk.
    const type = role === 'LIFE_COACH' ? 'LIFE_COACH' : 'FITNESS';
    await prisma.conversation.upsert({
      where: { userId_type: { userId, type } },
      update: { assignedAdminId: adminId, status: 'CLAIMED' },
      create: {
        userId,
        type,
        assignedAdminId: adminId,
        status: 'CLAIMED',
        lastMessageAt: new Date(),
        messages: {
          create: {
            senderType: 'SYSTEM',
            kind: 'SYSTEM',
            content: `You've been matched with your ${CONVERSATION_LABELS[type]}. Say hello whenever you're ready.`,
          },
        },
      },
    });

    assigned.push({ role, adminId });
  }

  if (assigned.length > 0) {
    await notify({
      userId,
      type: 'COACH_REPLY',
      title: 'Your coaches are ready',
      body: 'Your Life Coach and Fitness Assistant have been assigned. Open Chats to say hello.',
      href: '/chats',
    });
  }

  return assigned;
}

/** Ends coach assignments when a plan lapses; conversations are left readable. */
export async function releaseCoaches(userId: string, reason: string) {
  await prisma.coachAssignment.updateMany({
    where: { userId, status: 'ACTIVE' },
    data: { status: 'ENDED', endedAt: new Date(), reason },
  });
}

export interface ActivationInput {
  userId: string;
  /** Total people covered, including the payer. */
  seats?: number;
  tier: 'PRO';
  status: 'ACTIVE' | 'TRIALING';
  interval: 'MONTHLY' | 'QUARTERLY' | 'ANNUAL';
  currency: string;
  amount: number;
  provider: Prisma.SubscriptionCreateInput['provider'];
  platform: Prisma.SubscriptionCreateInput['platform'];
  providerCustomerId?: string | null;
  providerSubscriptionId?: string | null;
  providerPurchaseToken?: string | null;
  currentPeriodEnd: Date | null;
}

/** Grants entitlement and triggers coach assignment. Safe to call repeatedly. */
export async function activateSubscription(input: ActivationInput) {
  const existing = await prisma.subscription.findUnique({ where: { userId: input.userId } });
  const wasPro = existing?.tier === 'PRO' && existing.status !== 'EXPIRED';

  const subscription = await prisma.subscription.upsert({
    where: { userId: input.userId },
    update: {
      tier: input.tier,
      status: input.status,
      interval: input.interval,
      currency: input.currency,
      amount: input.amount,
      provider: input.provider,
      platform: input.platform,
      providerCustomerId: input.providerCustomerId ?? undefined,
      providerSubscriptionId: input.providerSubscriptionId ?? undefined,
      providerPurchaseToken: input.providerPurchaseToken ?? undefined,
      currentPeriodEnd: input.currentPeriodEnd,
      renewsAt: input.currentPeriodEnd,
      seatCount: input.seats ?? existing?.pendingSeatCount ?? existing?.seatCount ?? 1,
      pendingSeatCount: null,
      cancelAtPeriodEnd: false,
      cancelledAt: null,
      expiredAt: null,
      startedAt: existing?.startedAt ?? new Date(),
      activatedAt: wasPro ? existing?.activatedAt : new Date(),
    },
    create: {
      userId: input.userId,
      tier: input.tier,
      status: input.status,
      interval: input.interval,
      currency: input.currency,
      amount: input.amount,
      provider: input.provider,
      platform: input.platform,
      providerCustomerId: input.providerCustomerId ?? null,
      providerSubscriptionId: input.providerSubscriptionId ?? null,
      providerPurchaseToken: input.providerPurchaseToken ?? null,
      currentPeriodEnd: input.currentPeriodEnd,
      renewsAt: input.currentPeriodEnd,
      seatCount: input.seats ?? 1,
      startedAt: new Date(),
      activatedAt: new Date(),
    },
  });

  if (!wasPro) await assignCoaches(input.userId);

  // Turn any seats paid for at checkout into live invitations. Imported lazily
  // because seats.ts depends on this module for coach assignment.
  const { issueSeats } = await import('./seats.js');
  await issueSeats(subscription.id);

  return subscription;
}

export async function expireSubscription(userId: string, reason: string) {
  const subscription = await prisma.subscription.update({
    where: { userId },
    data: { status: 'EXPIRED', expiredAt: new Date() },
  });
  await releaseCoaches(userId, reason);

  // Seats are entitlement borrowed from this subscription, so they fall with it.
  const { cascadeSeatsOnExpiry } = await import('./seats.js');
  await cascadeSeatsOnExpiry(subscription.id);
  await notify({
    userId,
    type: 'PLAN_EXPIRED',
    title: 'Your Pro plan has ended',
    body: 'Chats and meal plans are paused. Renew any time to pick up where you left off.',
    href: '/plan',
  });
  return subscription;
}
