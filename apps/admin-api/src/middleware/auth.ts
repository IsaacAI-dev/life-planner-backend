import type { Request, RequestHandler } from 'express';
import { prisma } from '@lifeplanner/database';
import { AppError, ErrorCode, isOversight, type AdminRoleName } from '@lifeplanner/shared-utils';
import { verifyAdminAccessToken } from '../lib/tokens.js';

export interface AuthenticatedAdmin {
  id: string;
  email: string;
  name: string;
  roles: AdminRoleName[];
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      admin?: AuthenticatedAdmin;
    }
  }
}

export const requireAdmin: RequestHandler = (req, _res, next) => {
  void (async () => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith('Bearer ')) throw AppError.unauthorized('Missing bearer token');

      const payload = verifyAdminAccessToken(header.slice(7).trim());
      // Roles are re-read from the database rather than trusted from the token,
      // so a demotion takes effect immediately instead of at token expiry.
      const admin = await prisma.admin.findUnique({
        where: { id: payload.sub },
        select: { id: true, email: true, name: true, roles: true, status: true, deletedAt: true },
      });

      if (!admin || admin.deletedAt) {
        throw AppError.unauthorized('Admin account no longer exists', ErrorCode.TOKEN_INVALID);
      }

      // Checked per request, not just at login, so disabling someone takes
      // effect immediately rather than when their access token expires.
      if (admin.status === 'DISABLED') {
        throw AppError.forbidden('This admin account has been disabled');
      }

      // "Last active" in the console. Fire-and-forget: a failed write here must
      // never cost the person their request.
      void prisma.admin
        .update({ where: { id: admin.id }, data: { lastActiveAt: new Date() } })
        .catch(() => undefined);

      req.admin = {
        id: admin.id,
        email: admin.email,
        name: admin.name,
        roles: admin.roles as AdminRoleName[],
      };
      next();
    } catch (err) {
      next(err);
    }
  })();
};

/** Requires at least one of the listed roles. */
export const requireRoles =
  (...roles: AdminRoleName[]): RequestHandler =>
  (req, _res, next) => {
    const mine = req.admin?.roles ?? [];
    if (!roles.some((r) => mine.includes(r))) {
      next(AppError.forbidden(`This action requires one of: ${roles.join(', ')}`));
      return;
    }
    next();
  };

export const requireSuperadmin = requireRoles('SUPERADMIN');

/**
 * Manager and Superadmin only. These are the two roles allowed to read other
 * admins' conversations and client lists, and to reassign work.
 */
export const requireOversight: RequestHandler = (req, _res, next) => {
  if (!isOversight(req.admin?.roles ?? [])) {
    next(AppError.forbidden('Only a Manager or Super Admin can do this'));
    return;
  }
  next();
};

export const currentAdmin = (req: Request): AuthenticatedAdmin => {
  if (!req.admin) throw AppError.unauthorized();
  return req.admin;
};
