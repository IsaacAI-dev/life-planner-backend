import crypto from 'node:crypto';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  BENEFICIARY_MESSAGES,
  ErrorCode,
  SEAT_INVITE_TTL_DAYS,
  type BeneficiaryIssue,
} from '@lifeplanner/shared-utils';
import { logger } from './logger.js';
import { sendMail } from './mailer.js';
import { notify } from './notify.js';
import { issueSecurityAction } from './security.js';
import { assignCoaches, releaseCoaches } from './subscriptions.js';
import { env } from '../config/env.js';

export interface BeneficiaryCheck {
  email: string;
  ok: boolean;
  /** True when there is no account yet — they get an emailed invitation. */
  willBeInvited: boolean;
  issue: BeneficiaryIssue | null;
  message: string | null;
  name: string | null;
}

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/**
 * Checks every proposed beneficiary BEFORE payment. The rule is that we would
 * rather refuse the sale than take money and then fail to deliver a seat, so
 * anything blocking here stops checkout entirely.
 *
 * A missing account is not blocking — that person simply gets an invitation.
 */
export async function validateBeneficiaries(
  payerId: string,
  payerEmail: string,
  emails: string[],
): Promise<BeneficiaryCheck[]> {
  const seen = new Set<string>();
  const results: BeneficiaryCheck[] = [];

  for (const raw of emails) {
    const email = raw.trim().toLowerCase();

    const fail = (issue: BeneficiaryIssue, name: string | null = null) =>
      results.push({
        email,
        ok: false,
        willBeInvited: false,
        issue,
        message: BENEFICIARY_MESSAGES[issue],
        name,
      });

    if (seen.has(email)) {
      fail('DUPLICATE');
      continue;
    }
    seen.add(email);

    if (email === payerEmail.toLowerCase()) {
      fail('SELF');
      continue;
    }

    const user = await prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        name: true,
        status: true,
        deletedAt: true,
        subscription: { select: { tier: true, status: true } },
        seatMemberships: {
          where: { status: { in: ['ACTIVE', 'INVITED'] } },
          select: { id: true, subscriptionId: true },
        },
      },
    });

    // No account yet — invite them.
    if (!user || user.deletedAt) {
      results.push({
        email,
        ok: true,
        willBeInvited: true,
        issue: null,
        message: 'No Life Planner account yet — we will email them an invitation.',
        name: null,
      });
      continue;
    }

    if (user.status === 'BANNED') {
      fail('BANNED', user.name);
      continue;
    }
    if (user.status === 'SUSPENDED') {
      fail('SUSPENDED', user.name);
      continue;
    }

    // Never let someone quietly pay twice.
    if (
      user.subscription?.tier === 'PRO' &&
      ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(user.subscription.status)
    ) {
      fail('ALREADY_PRO', user.name);
      continue;
    }

    const heldElsewhere = user.seatMemberships.some(
      (s) => s.subscriptionId !== undefined,
    );
    if (heldElsewhere) {
      const ownSubscription = await prisma.subscription.findUnique({
        where: { userId: payerId },
        select: { id: true },
      });
      const onSomeoneElses = user.seatMemberships.some(
        (s) => s.subscriptionId !== ownSubscription?.id,
      );
      if (onSomeoneElses) {
        fail('ALREADY_SEATED', user.name);
        continue;
      }
    }

    results.push({
      email,
      ok: true,
      willBeInvited: false,
      issue: null,
      message: `${user.name} will be added to your plan.`,
      name: user.name,
    });
  }

  return results;
}

/** Throws if any beneficiary is blocking. Called again at checkout, server-side. */
export function assertBeneficiariesUsable(checks: BeneficiaryCheck[]): void {
  const blocked = checks.filter((c) => !c.ok);
  if (blocked.length > 0) {
    throw AppError.badRequest(
      'One or more people cannot be added to your plan',
      ErrorCode.VALIDATION_ERROR,
      { beneficiaries: blocked },
    );
  }
}

/**
 * Records the intended beneficiaries at checkout time as PENDING_PAYMENT rows,
 * so the list survives the round trip to the provider. Nobody is emailed and
 * nobody gets entitlement until the webhook confirms payment.
 */
export async function stageSeats(subscriptionId: string, emails: string[]): Promise<void> {
  await prisma.subscriptionSeat.deleteMany({
    where: { subscriptionId, status: 'PENDING_PAYMENT' },
  });

  for (const inviteEmail of emails) {
    await prisma.subscriptionSeat.upsert({
      where: { subscriptionId_inviteEmail: { subscriptionId, inviteEmail } },
      update: { status: 'PENDING_PAYMENT', revokedAt: null, endsAt: null },
      create: { subscriptionId, inviteEmail, status: 'PENDING_PAYMENT' },
    });
  }
}

/**
 * Turns paid-for staged seats into live invitations. An existing account is
 * seated immediately; a stranger gets a tokenised email and claims later.
 */
export async function issueSeats(subscriptionId: string): Promise<void> {
  const [subscription, staged] = await Promise.all([
    prisma.subscription.findUnique({
      where: { id: subscriptionId },
      select: { id: true, user: { select: { id: true, name: true, email: true } } },
    }),
    prisma.subscriptionSeat.findMany({
      where: { subscriptionId, status: 'PENDING_PAYMENT' },
    }),
  ]);
  if (!subscription) return;

  for (const seat of staged) {
    const existing = await prisma.user.findUnique({
      where: { email: seat.inviteEmail },
      select: { id: true, name: true, status: true, deletedAt: true },
    });

    // Someone with an account is seated straight away — no email round trip.
    if (existing && !existing.deletedAt && existing.status === 'ACTIVE') {
      await prisma.subscriptionSeat.update({
        where: { id: seat.id },
        data: {
          status: 'ACTIVE',
          memberUserId: existing.id,
          invitedAt: new Date(),
          claimedAt: new Date(),
          inviteTokenHash: null,
          inviteExpiresAt: null,
        },
      });

      // A seat is a full Pro membership: their own coaches, their own everything.
      await assignCoaches(existing.id);
      await notify({
        userId: existing.id,
        type: 'PLAN_EXPIRING',
        title: `${subscription.user.name} added you to their Life Planner plan`,
        body: 'You now have Pro — coach chats, voice notes and meal plans. They cannot see any of your data.',
        href: '/plan',
      });

      logger.info({ seatId: seat.id, memberUserId: existing.id }, 'Seat activated for existing user');
      continue;
    }

    // Otherwise send a tokenised invitation.
    const token = crypto.randomBytes(32).toString('base64url');
    await prisma.subscriptionSeat.update({
      where: { id: seat.id },
      data: {
        status: 'INVITED',
        inviteTokenHash: hashToken(token),
        inviteExpiresAt: new Date(Date.now() + SEAT_INVITE_TTL_DAYS * 86_400_000),
        invitedAt: new Date(),
      },
    });

    const link = `${env.PUBLIC_APP_URL}/plan/join?token=${token}`;

    // An unsolicited invitation naming a stranger is exactly the shape of a
    // phishing attempt, so the mail says who sent it and offers a way out that
    // does not require an account.
    const security = await issueSecurityAction({
      type: 'SEAT_INVITE',
      email: seat.inviteEmail,
      seatId: seat.id,
    });

    await sendMail({
      to: seat.inviteEmail,
      subject: `${subscription.user.name} has given you Life Planner Pro`,
      text: [
        `${subscription.user.name} (${subscription.user.email}) has paid for a Life Planner Pro seat for you.`,
        '',
        'Pro gives you your own Life Coach and Fitness Assistant, voice notes and meal plans.',
        'Your planner stays completely private — they cannot see your activities, goals, notes or chats,',
        'and neither can they see them later. Paying for a seat grants access, nothing more.',
        '',
        `Accept here: ${link}`,
        '',
        `Not interested? Decline here: ${security.rejectUrl}`,
        `Don't know ${subscription.user.name}? Report it here: ${security.reportUrl}`,
        '',
        `This invitation expires in ${SEAT_INVITE_TTL_DAYS} days.`,
      ].join('\n'),
    });

    logger.info({ seatId: seat.id, email: seat.inviteEmail }, 'Seat invitation sent');
  }
}

/** Resolves an invite token to its seat, rejecting expired or spent ones. */
export async function seatForToken(token: string) {
  const seat = await prisma.subscriptionSeat.findUnique({
    where: { inviteTokenHash: hashToken(token) },
    include: {
      subscription: {
        select: {
          id: true,
          tier: true,
          status: true,
          currentPeriodEnd: true,
          user: { select: { name: true, email: true } },
        },
      },
    },
  });

  if (!seat) throw AppError.notFound('That invitation is not valid');
  if (seat.status === 'ACTIVE') throw AppError.badRequest('That invitation has already been accepted');
  if (seat.status !== 'INVITED') throw AppError.badRequest('That invitation is no longer available');
  if (seat.inviteExpiresAt && seat.inviteExpiresAt.getTime() < Date.now()) {
    await prisma.subscriptionSeat.update({ where: { id: seat.id }, data: { status: 'EXPIRED' } });
    throw AppError.badRequest('That invitation has expired');
  }
  if (seat.subscription.tier !== 'PRO' || seat.subscription.status === 'EXPIRED') {
    throw AppError.badRequest('The plan behind this invitation is no longer active');
  }

  return seat;
}

/** Accepts an invitation for the signed-in user. */
export async function claimSeat(token: string, userId: string) {
  const seat = await seatForToken(token);

  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: {
      id: true,
      status: true,
      subscription: { select: { tier: true, status: true } },
      seatMemberships: { where: { status: 'ACTIVE' }, select: { id: true } },
    },
  });

  if (user.status !== 'ACTIVE') {
    throw AppError.forbidden('This account cannot accept a plan invitation');
  }
  if (
    user.subscription?.tier === 'PRO' &&
    ['ACTIVE', 'TRIALING', 'PAST_DUE'].includes(user.subscription.status)
  ) {
    throw AppError.badRequest(
      'You already have your own Pro plan. Cancel it first, then accept this invitation.',
    );
  }
  if (user.seatMemberships.length > 0) {
    throw AppError.badRequest('You are already on somebody else’s plan');
  }

  const claimed = await prisma.subscriptionSeat.update({
    where: { id: seat.id },
    data: {
      status: 'ACTIVE',
      memberUserId: userId,
      claimedAt: new Date(),
      inviteTokenHash: null,
      inviteExpiresAt: null,
    },
  });

  await assignCoaches(userId);

  return claimed;
}

/**
 * An unclaimed invitation can be pulled immediately — nothing was delivered.
 * A live seat ends at period end, because it has been paid for.
 */
export async function revokeSeat(seatId: string, subscriptionId: string) {
  const seat = await prisma.subscriptionSeat.findFirst({
    where: { id: seatId, subscriptionId },
    include: { subscription: { select: { currentPeriodEnd: true } } },
  });
  if (!seat) throw AppError.notFound('Seat not found');
  if (seat.status === 'REVOKED') throw AppError.badRequest('That seat has already been removed');

  if (seat.status !== 'ACTIVE') {
    return prisma.subscriptionSeat.update({
      where: { id: seat.id },
      data: { status: 'REVOKED', revokedAt: new Date(), inviteTokenHash: null },
    });
  }

  const endsAt = seat.subscription.currentPeriodEnd ?? new Date();
  const updated = await prisma.subscriptionSeat.update({
    where: { id: seat.id },
    data: { revokedAt: new Date(), endsAt },
  });

  if (seat.memberUserId) {
    await notify({
      userId: seat.memberUserId,
      type: 'PLAN_EXPIRING',
      title: 'Your Pro access ends soon',
      body: `The plan covering you ends on ${endsAt.toISOString().slice(0, 10)}. You can subscribe yourself to keep Pro.`,
      href: '/plan',
    });
  }

  return updated;
}

/** Ends seats whose paid period has run out. Called by the nightly sweep. */
export async function expireLapsedSeats(): Promise<number> {
  const due = await prisma.subscriptionSeat.findMany({
    where: { status: 'ACTIVE', endsAt: { not: null, lte: new Date() } },
    select: { id: true, memberUserId: true },
  });

  for (const seat of due) {
    await prisma.subscriptionSeat.update({
      where: { id: seat.id },
      data: { status: 'EXPIRED' },
    });
    if (seat.memberUserId) {
      await releaseCoaches(seat.memberUserId, 'Seat ended');
      await notify({
        userId: seat.memberUserId,
        type: 'PLAN_EXPIRED',
        title: 'Your Pro access has ended',
        body: 'The plan that covered you has ended. Subscribe any time to pick up where you left off.',
        href: '/plan',
      });
    }
  }

  return due.length;
}

/**
 * When the payer's own plan lapses, every seat on it falls with it — the seats
 * were only ever entitlement borrowed from that subscription.
 */
export async function cascadeSeatsOnExpiry(subscriptionId: string): Promise<void> {
  const seats = await prisma.subscriptionSeat.findMany({
    where: { subscriptionId, status: { in: ['ACTIVE', 'INVITED', 'PENDING_PAYMENT'] } },
    select: { id: true, memberUserId: true },
  });

  await prisma.subscriptionSeat.updateMany({
    where: { subscriptionId, status: { in: ['ACTIVE', 'INVITED', 'PENDING_PAYMENT'] } },
    data: { status: 'EXPIRED', inviteTokenHash: null },
  });

  for (const seat of seats) {
    if (!seat.memberUserId) continue;
    await releaseCoaches(seat.memberUserId, 'Payer plan lapsed');
    await notify({
      userId: seat.memberUserId,
      type: 'PLAN_EXPIRED',
      title: 'Your Pro access has ended',
      body: 'The plan that covered you is no longer active. Subscribe any time to keep going.',
      href: '/plan',
    });
  }
}
