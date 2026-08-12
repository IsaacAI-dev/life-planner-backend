import type { Request, RequestHandler } from 'express';
import { prisma } from '@lifeplanner/database';
import { AppError, ErrorCode } from '@lifeplanner/shared-utils';
import { verifyAccessToken } from '../lib/tokens.js';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
  timezone: string;
  country: string | null;
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED';
  suspendedUntil?: Date | null;
  statusReason: string | null;
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

const bearer = (req: Request): string | null => {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7).trim();
  return token.length > 0 ? token : null;
};

/**
 * Addendum 2 §18.6 — the single centralized enforcement point for account
 * status. The user row is already loaded here for JWT validation, so gating on
 * `status` costs one extra column on the same query.
 */
export const assertUsable = (user: {
  status: string;
  statusReason: string | null;
  suspendedUntil?: Date | null;
  deletedAt: Date | null;
}) => {
  if (user.deletedAt) {
    throw AppError.unauthorized('Account no longer exists', ErrorCode.TOKEN_INVALID);
  }
  if (user.status === 'BANNED') {
    // No reason, ever. A ban is final and explaining it invites an argument
    // the product cannot have; the reason lives in the moderation log for staff.
    throw new AppError(
      403,
      ErrorCode.ACCOUNT_BANNED,
      'This account has been permanently closed.',
      { banned: true },
    );
  }
  if (user.status === 'SUSPENDED') {
    // Treated as lifted at read time, so a missed nightly sweep never keeps
    // somebody locked out past their date. The sweep does the DB flip.
    const lifted = Boolean(user.suspendedUntil && user.suspendedUntil.getTime() <= Date.now());
    if (!lifted) {
      throw new AppError(
        403,
        ErrorCode.ACCOUNT_SUSPENDED,
        user.suspendedUntil
          ? 'This account is suspended.'
          : 'This account is suspended pending review.',
        {
          suspended: true,
          // The person sees why, and when they get back in.
          reason: user.statusReason,
          suspendedUntil: user.suspendedUntil,
        },
      );
    }
  }
};

export const requireAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const token = bearer(req);
      if (!token) throw AppError.unauthorized('Missing bearer token');

      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          name: true,
          timezone: true,
          country: true,
          status: true,
          statusReason: true,
          suspendedUntil: true,
          deletedAt: true,
        },
      });

      if (!user) throw AppError.unauthorized('Account no longer exists', ErrorCode.TOKEN_INVALID);
      assertUsable(user);

      req.user = {
        id: user.id,
        email: user.email,
        name: user.name,
        timezone: user.timezone,
        country: user.country,
        status: user.status,
        statusReason: user.statusReason,
      };
      next();
    } catch (err) {
      next(err);
    }
  })();
};

/**
 * Addendum 2 §18.7 — attaches req.user when a valid token is present and simply
 * continues when it is absent or invalid. Page views happen before login too, so
 * the analytics endpoint must never gate-keep anonymous visitors.
 */
export const optionalAuth: RequestHandler = (req, _res, next) => {
  void (async () => {
    const token = bearer(req);
    if (!token) {
      next();
      return;
    }
    try {
      const payload = verifyAccessToken(token);
      const user = await prisma.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          email: true,
          name: true,
          timezone: true,
          country: true,
          status: true,
          statusReason: true,
          suspendedUntil: true,
          deletedAt: true,
        },
      });
      if (user && !user.deletedAt && user.status === 'ACTIVE') {
        req.user = {
          id: user.id,
          email: user.email,
          name: user.name,
          timezone: user.timezone,
          country: user.country,
          status: user.status,
          statusReason: user.statusReason,
        };
      }
    } catch {
      // Invalid token on an optional-auth route is simply anonymous.
    }
    next();
  })();
};

/** Convenience accessor for handlers mounted behind requireAuth. */
export const currentUser = (req: Request): AuthenticatedUser => {
  if (!req.user) throw AppError.unauthorized();
  return req.user;
};
