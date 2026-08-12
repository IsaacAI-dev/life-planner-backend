import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { prisma } from '@lifeplanner/database';
import { AppError, ErrorCode } from '@lifeplanner/shared-utils';
import { env } from '../config/env.js';

export type AdminRoleName =
  | 'FITNESS_ADMIN'
  | 'LIFE_COACH_ADMIN'
  | 'SUPPORT_ADMIN'
  | 'MANAGER'
  | 'SUPERADMIN';

export interface AdminTokenPayload {
  sub: string;
  email: string;
  /** An admin holds several levels at once, e.g. fitness + life coach. */
  roles: AdminRoleName[];
  type: 'admin-access';
}

export const signAdminAccessToken = (id: string, email: string, roles: AdminRoleName[]) =>
  jwt.sign({ sub: id, email, roles, type: 'admin-access' }, env.ADMIN_JWT_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as SignOptions);

export const verifyAdminAccessToken = (token: string): AdminTokenPayload => {
  try {
    const decoded = jwt.verify(token, env.ADMIN_JWT_SECRET) as AdminTokenPayload;
    if (decoded.type !== 'admin-access') throw new Error('wrong token type');
    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Access token expired', ErrorCode.TOKEN_EXPIRED);
    }
    throw AppError.unauthorized('Invalid access token', ErrorCode.TOKEN_INVALID);
  }
};

export const hashToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
export const generateOpaqueToken = () => crypto.randomBytes(48).toString('base64url');

const expiry = () => new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

export async function issueAdminTokens(adminId: string, email: string, roles: AdminRoleName[]) {
  const refreshToken = generateOpaqueToken();
  await prisma.adminRefreshToken.create({
    data: { adminId, tokenHash: hashToken(refreshToken), expiresAt: expiry() },
  });
  return {
    accessToken: signAdminAccessToken(adminId, email, roles),
    refreshToken,
    expiresIn: env.ACCESS_TOKEN_TTL,
  };
}

export async function rotateAdminRefreshToken(presented: string) {
  const existing = await prisma.adminRefreshToken.findUnique({
    where: { tokenHash: hashToken(presented) },
    include: { admin: true },
  });

  if (!existing || existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
    throw AppError.unauthorized('Refresh token is invalid or expired', ErrorCode.TOKEN_INVALID);
  }
  if (existing.admin.deletedAt) {
    throw AppError.unauthorized('Admin account no longer exists', ErrorCode.TOKEN_INVALID);
  }

  const nextRefresh = generateOpaqueToken();
  await prisma.$transaction([
    prisma.adminRefreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date() },
    }),
    prisma.adminRefreshToken.create({
      data: { adminId: existing.adminId, tokenHash: hashToken(nextRefresh), expiresAt: expiry() },
    }),
  ]);

  return {
    admin: existing.admin,
    tokens: {
      accessToken: signAdminAccessToken(
        existing.adminId,
        existing.admin.email,
        existing.admin.roles as AdminRoleName[],
      ),
      refreshToken: nextRefresh,
      expiresIn: env.ACCESS_TOKEN_TTL,
    },
  };
}

export async function revokeAdminRefreshToken(presented: string) {
  await prisma.adminRefreshToken.updateMany({
    where: { tokenHash: hashToken(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
