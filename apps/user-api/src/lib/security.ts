import crypto from 'node:crypto';
import { prisma } from '@lifeplanner/database';
import { AppError, SECURITY_ACTION_TTL_DAYS } from '@lifeplanner/shared-utils';
import { logger } from './logger.js';
import { env } from '../config/env.js';

type ActionType = 'SEAT_INVITE' | 'SIGNUP' | 'PASSWORD_RESET';

const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

export interface IssuedAction {
  token: string;
  rejectUrl: string | null;
  reportUrl: string;
}

/**
 * Mints the one-time token behind a "this wasn't me" link.
 *
 * Every email announcing something a stranger could have started in your name
 * carries one. Only the mailbox owner receives it, which is what makes acting
 * on a report safe: it cannot be used against someone else's account.
 */
export async function issueSecurityAction(params: {
  type: ActionType;
  email: string;
  userId?: string | null;
  seatId?: string | null;
}): Promise<IssuedAction> {
  const token = crypto.randomBytes(32).toString('base64url');

  await prisma.securityAction.create({
    data: {
      type: params.type,
      tokenHash: hashToken(token),
      email: params.email.toLowerCase(),
      userId: params.userId ?? null,
      seatId: params.seatId ?? null,
      expiresAt: new Date(Date.now() + SECURITY_ACTION_TTL_DAYS * 86_400_000),
    },
  });

  const base = `${env.PUBLIC_APP_URL}/security/${token}`;
  return {
    token,
    // Only an invitation has a polite "no thanks" that isn't an accusation.
    rejectUrl: params.type === 'SEAT_INVITE' ? `${base}?action=reject` : null,
    reportUrl: `${base}?action=report`,
  };
}

export async function resolveSecurityAction(token: string) {
  const action = await prisma.securityAction.findUnique({
    where: { tokenHash: hashToken(token) },
    include: {
      seat: {
        include: {
          subscription: { include: { user: { select: { id: true, name: true, email: true } } } },
        },
      },
      user: { select: { id: true, name: true, email: true } },
    },
  });

  if (!action) throw AppError.notFound('That link is not valid');
  if (action.respondedAt) throw AppError.badRequest('That link has already been used');
  if (action.expiresAt.getTime() < Date.now()) throw AppError.badRequest('That link has expired');
  return action;
}

/**
 * A report is only worth offering if something happens. Each type has a
 * concrete consequence, applied in one transaction with the response record.
 */
export async function respondToSecurityAction(params: {
  token: string;
  outcome: 'REJECTED' | 'REPORTED';
  note?: string;
  ip?: string;
  userAgent?: string;
}) {
  const action = await resolveSecurityAction(params.token);

  if (params.outcome === 'REJECTED' && action.type !== 'SEAT_INVITE') {
    throw AppError.badRequest('Only an invitation can be declined; use report instead');
  }

  const consequences: string[] = [];

  await prisma.$transaction(async (tx) => {
    await tx.securityAction.update({
      where: { id: action.id },
      data: {
        outcome: params.outcome,
        respondedAt: new Date(),
        note: params.note ?? null,
        ip: params.ip ?? null,
        userAgent: params.userAgent ?? null,
      },
    });

    if (action.type === 'SEAT_INVITE' && action.seatId) {
      // Declining and reporting both end the invitation; only the wording and
      // the admin follow-up differ.
      await tx.subscriptionSeat.update({
        where: { id: action.seatId },
        data: {
          status: 'DECLINED',
          revokedAt: new Date(),
          inviteTokenHash: null,
        },
      });
      consequences.push('invitation cancelled');
    }

    if (action.type === 'SIGNUP' && action.userId) {
      // The mailbox owner says they never signed up, so this account was opened
      // with someone else's address. Suspend it and end every session.
      await tx.user.update({
        where: { id: action.userId },
        data: {
          status: 'SUSPENDED',
          statusReason: 'Reported by the owner of the email address as not initiated by them',
          statusChangedAt: new Date(),
        },
      });
      await tx.refreshToken.updateMany({
        where: { userId: action.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      consequences.push('account suspended pending review', 'all sessions ended');
    }

    if (action.type === 'PASSWORD_RESET' && action.userId) {
      // Void every outstanding reset link, and end sessions in case the
      // request came from someone already holding a stolen token.
      await tx.passwordResetToken.updateMany({
        where: { userId: action.userId, usedAt: null },
        data: { usedAt: new Date() },
      });
      await tx.refreshToken.updateMany({
        where: { userId: action.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      });
      consequences.push('pending reset links voided', 'all sessions ended');
    }
  });

  if (params.outcome === 'REPORTED') {
    logger.warn(
      { type: action.type, email: action.email, userId: action.userId },
      'Security report filed — queued for admin review',
    );
  }

  return { action, consequences };
}
