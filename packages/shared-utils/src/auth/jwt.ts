import jwt, { type SignOptions } from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import { AppError } from '../errors/index.js';

export type AdminRoleClaim = 'SUPPORT' | 'SUPERADMIN';

export interface UserAccessClaims {
  sub: string; // userId
  type: 'access';
}

export interface UserRefreshClaims {
  sub: string; // userId
  type: 'refresh';
  jti: string; // unique id; sha256(token) is stored server-side for revocation
}

export interface AdminAccessClaims {
  sub: string; // adminId
  type: 'admin';
  role: AdminRoleClaim;
}

export interface JwtConfig {
  accessSecret: string;
  refreshSecret: string;
  adminSecret: string;
  accessTtl: string; // e.g. "15m"
  refreshTtl: string; // e.g. "30d"
}

/** Factory bound to one service's secret/TTL config. */
export function createJwt(cfg: JwtConfig) {
  function signUserAccess(userId: string): string {
    const payload: UserAccessClaims = { sub: userId, type: 'access' };
    return jwt.sign(payload, cfg.accessSecret, { expiresIn: cfg.accessTtl } as SignOptions);
  }

  /** Returns the signed refresh token and its jti (store sha256(token) keyed by jti). */
  function signUserRefresh(userId: string): { token: string; jti: string } {
    const jti = randomUUID();
    const payload: UserRefreshClaims = { sub: userId, type: 'refresh', jti };
    const token = jwt.sign(payload, cfg.refreshSecret, {
      expiresIn: cfg.refreshTtl,
    } as SignOptions);
    return { token, jti };
  }

  function signAdminAccess(adminId: string, role: AdminRoleClaim): string {
    const payload: AdminAccessClaims = { sub: adminId, type: 'admin', role };
    return jwt.sign(payload, cfg.adminSecret, { expiresIn: cfg.accessTtl } as SignOptions);
  }

  function verifyUserAccess(token: string): UserAccessClaims {
    const decoded = safeVerify(token, cfg.accessSecret);
    if (decoded.type !== 'access') throw AppError.unauthorized('Invalid token type');
    return decoded as UserAccessClaims;
  }

  function verifyUserRefresh(token: string): UserRefreshClaims {
    const decoded = safeVerify(token, cfg.refreshSecret);
    if (decoded.type !== 'refresh') throw AppError.unauthorized('Invalid token type');
    return decoded as UserRefreshClaims;
  }

  function verifyAdminAccess(token: string): AdminAccessClaims {
    const decoded = safeVerify(token, cfg.adminSecret);
    if (decoded.type !== 'admin') throw AppError.unauthorized('Invalid token type');
    return decoded as AdminAccessClaims;
  }

  return {
    signUserAccess,
    signUserRefresh,
    signAdminAccess,
    verifyUserAccess,
    verifyUserRefresh,
    verifyAdminAccess,
  };
}

export type Jwt = ReturnType<typeof createJwt>;

function safeVerify(token: string, secret: string): jwt.JwtPayload {
  try {
    const decoded = jwt.verify(token, secret);
    if (typeof decoded === 'string') throw new Error('unexpected string payload');
    return decoded;
  } catch {
    throw AppError.unauthorized('Invalid or expired token');
  }
}
