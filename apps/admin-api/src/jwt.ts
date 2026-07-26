import jwt, { type SignOptions } from 'jsonwebtoken';
import { createJwt, AppError, type AdminRoleClaim } from '@life-planner/shared-utils';
import { env } from './env.js';

/**
 * Admin access tokens use the shared factory (type "admin"). The Admin model
 * has no refresh-token table, so admin refresh is a stateless signed JWT
 * (type "admin-refresh"). It cannot be individually revoked — rotating
 * ADMIN_JWT_SECRET invalidates all admin sessions. Add an AdminRefreshToken
 * model if per-session revocation becomes a requirement.
 */
export const jwtService = createJwt({
  accessSecret: env.ADMIN_JWT_SECRET,
  refreshSecret: env.ADMIN_JWT_SECRET,
  adminSecret: env.ADMIN_JWT_SECRET,
  accessTtl: env.ACCESS_TOKEN_TTL,
  refreshTtl: env.ADMIN_REFRESH_TTL,
});

interface AdminRefreshClaims {
  sub: string;
  role: AdminRoleClaim;
  type: 'admin-refresh';
}

export function signAdminRefresh(adminId: string, role: AdminRoleClaim): string {
  const payload: AdminRefreshClaims = { sub: adminId, role, type: 'admin-refresh' };
  return jwt.sign(payload, env.ADMIN_JWT_SECRET, { expiresIn: env.ADMIN_REFRESH_TTL } as SignOptions);
}

export function verifyAdminRefresh(token: string): AdminRefreshClaims {
  try {
    const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET);
    if (typeof decoded === 'string' || (decoded as AdminRefreshClaims).type !== 'admin-refresh') {
      throw new Error('bad type');
    }
    return decoded as AdminRefreshClaims;
  } catch {
    throw AppError.unauthorized('Invalid or expired refresh token');
  }
}
