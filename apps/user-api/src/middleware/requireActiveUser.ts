import type { NextFunction, Request, Response } from 'express';
import { AppError } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';
import { currentUserId } from './auth.js';

/**
 * Blocks suspended accounts on abuse-sensitive routes. Must run after requireAuth.
 * One indexed lookup; access tokens are short-lived (15m) and suspending also
 * revokes refresh tokens, so the window for a still-valid token is bounded.
 */
export async function requireActiveUser(
  req: Request,
  _res: Response,
  next: NextFunction,
): Promise<void> {
  try {
    const userId = currentUserId(req);
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { suspendedAt: true, suspendedUntil: true, suspensionReason: true },
    });
    if (!user) throw AppError.unauthorized('User no longer exists');

    const suspended =
      user.suspendedAt && (!user.suspendedUntil || user.suspendedUntil > new Date());
    if (suspended) {
      throw AppError.forbidden(
        user.suspensionReason
          ? `Account suspended: ${user.suspensionReason}`
          : 'Account suspended',
      );
    }
    next();
  } catch (err) {
    next(err);
  }
}
