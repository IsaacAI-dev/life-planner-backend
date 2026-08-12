import crypto from 'node:crypto';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { prisma } from '@lifeplanner/database';
import { AppError, ErrorCode } from '@lifeplanner/shared-utils';
import { env } from '../config/env.js';

export interface AccessTokenPayload {
  sub: string;
  email: string;
  type: 'access';
}

export const signAccessToken = (userId: string, email: string): string =>
  jwt.sign({ sub: userId, email, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.ACCESS_TOKEN_TTL,
  } as SignOptions);

export const verifyAccessToken = (token: string): AccessTokenPayload => {
  try {
    const decoded = jwt.verify(token, env.JWT_ACCESS_SECRET) as AccessTokenPayload;
    if (decoded.type !== 'access') throw new Error('wrong token type');
    return decoded;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Access token expired', ErrorCode.TOKEN_EXPIRED);
    }
    throw AppError.unauthorized('Invalid access token', ErrorCode.TOKEN_INVALID);
  }
};

/** Refresh tokens are opaque random strings; only their SHA-256 hash is stored. */
export const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

export const generateOpaqueToken = (): string => crypto.randomBytes(48).toString('base64url');

export const refreshExpiry = (): Date =>
  new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86_400_000);

export async function issueTokens(userId: string, email: string) {
  const accessToken = signAccessToken(userId, email);
  const refreshToken = generateOpaqueToken();
  await prisma.refreshToken.create({
    data: { userId, tokenHash: hashToken(refreshToken), expiresAt: refreshExpiry() },
  });
  return { accessToken, refreshToken, expiresIn: env.ACCESS_TOKEN_TTL };
}

/** Rotates a refresh token: the presented token is revoked and replaced. */
export async function rotateRefreshToken(presented: string) {
  const tokenHash = hashToken(presented);
  const existing = await prisma.refreshToken.findUnique({
    where: { tokenHash },
    include: { user: true },
  });

  if (!existing || existing.revokedAt || existing.expiresAt.getTime() < Date.now()) {
    throw AppError.unauthorized('Refresh token is invalid or expired', ErrorCode.TOKEN_INVALID);
  }
  if (existing.user.deletedAt) {
    throw AppError.unauthorized('Account no longer exists', ErrorCode.TOKEN_INVALID);
  }
  if (existing.user.status === 'BANNED') {
    throw AppError.forbidden(
      existing.user.statusReason ?? 'This account has been banned',
      ErrorCode.ACCOUNT_BANNED,
    );
  }
  if (existing.user.status === 'SUSPENDED') {
    throw AppError.forbidden(
      existing.user.statusReason ?? 'This account is suspended',
      ErrorCode.ACCOUNT_SUSPENDED,
    );
  }

  const nextRefresh = generateOpaqueToken();
  const nextHash = hashToken(nextRefresh);

  await prisma.$transaction([
    prisma.refreshToken.update({
      where: { id: existing.id },
      data: { revokedAt: new Date(), replacedByTokenHash: nextHash },
    }),
    prisma.refreshToken.create({
      data: { userId: existing.userId, tokenHash: nextHash, expiresAt: refreshExpiry() },
    }),
  ]);

  return {
    user: existing.user,
    tokens: {
      accessToken: signAccessToken(existing.userId, existing.user.email),
      refreshToken: nextRefresh,
      expiresIn: env.ACCESS_TOKEN_TTL,
    },
  };
}

export async function revokeRefreshToken(presented: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { tokenHash: hashToken(presented), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/** Used by the ban handler — kills every live session for a user. */
export async function revokeAllUserRefreshTokens(userId: string): Promise<number> {
  const res = await prisma.refreshToken.updateMany({
    where: { userId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
  return res.count;
}
