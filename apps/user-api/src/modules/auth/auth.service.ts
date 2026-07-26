import {
  AppError,
  DEFAULT_CATEGORIES,
  DEFAULT_SETTINGS,
  hashPassword,
  hashToken,
  randomToken,
  verifyPassword,
  type LoginInput,
  type RegisterInput,
  type AuthResponse,
  type PublicUser,
} from '@life-planner/shared-utils';
import { prisma, type User } from '@life-planner/database';
import { env } from '../../env.js';
import { jwtService } from '../../jwt.js';
import { sendMail } from '../../mailer.js';
import { logger } from '../../logger.js';

/** Window during which a password-reset token is valid. */
const RESET_TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour

/** True when the user is currently suspended (indefinitely, or until a future time). */
export function isSuspended(u: Pick<User, 'suspendedAt' | 'suspendedUntil'>): boolean {
  if (!u.suspendedAt) return false;
  return !u.suspendedUntil || u.suspendedUntil > new Date();
}

function toPublicUser(u: User): PublicUser {
  return {
    id: u.id,
    email: u.email,
    name: u.name,
    timezone: u.timezone,
    createdAt: u.createdAt.toISOString(),
  };
}

/** Parse a TTL like "30d" / "15m" / "3600s" into milliseconds. */
function parseDurationMs(ttl: string): number {
  const m = /^(\d+)\s*(ms|s|m|h|d)$/.exec(ttl.trim());
  if (!m) return Number(ttl) || 0;
  const n = Number(m[1]);
  const unit = m[2];
  const mult: Record<string, number> = {
    ms: 1,
    s: 1000,
    m: 60_000,
    h: 3_600_000,
    d: 86_400_000,
  };
  return n * (mult[unit ?? 'ms'] ?? 1);
}

async function issueTokens(userId: string): Promise<AuthResponse['tokens']> {
  const accessToken = jwtService.signUserAccess(userId);
  const { token: refreshToken } = jwtService.signUserRefresh(userId);

  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: hashToken(refreshToken),
      expiresAt: new Date(Date.now() + parseDurationMs(env.REFRESH_TOKEN_TTL)),
    },
  });

  return {
    accessToken,
    refreshToken,
    accessTokenExpiresIn: env.ACCESS_TOKEN_TTL,
  };
}

export async function register(input: RegisterInput): Promise<AuthResponse> {
  const existing = await prisma.user.findUnique({ where: { email: input.email } });
  if (existing) throw AppError.conflict('An account with this email already exists');

  const passwordHash = await hashPassword(input.password);

  // User + default categories + settings created atomically.
  const user = await prisma.user.create({
    data: {
      email: input.email,
      passwordHash,
      name: input.name ?? null,
      timezone: input.timezone,
      categories: {
        create: DEFAULT_CATEGORIES.map((c) => ({
          name: c.name,
          color: c.color,
          icon: c.icon,
          isDefault: true,
        })),
      },
      settings: {
        create: { data: { ...DEFAULT_SETTINGS, timezone: input.timezone } },
      },
    },
  });

  const tokens = await issueTokens(user.id);
  return { user: toPublicUser(user), tokens };
}

export async function login(input: LoginInput): Promise<AuthResponse> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  // Constant-ish behavior: verify even when user missing is overkill here; we
  // simply return a generic 401 to avoid user enumeration.
  if (!user) throw AppError.unauthorized('Invalid email or password');

  const valid = await verifyPassword(user.passwordHash, input.password);
  if (!valid) throw AppError.unauthorized('Invalid email or password');

  if (isSuspended(user)) throw suspendedError(user);

  const tokens = await issueTokens(user.id);
  return { user: toPublicUser(user), tokens };
}

/** Build a 403 carrying the suspension reason/expiry as details. */
function suspendedError(u: Pick<User, 'suspensionReason' | 'suspendedUntil'>): AppError {
  return AppError.forbidden(
    u.suspensionReason
      ? `Account suspended: ${u.suspensionReason}`
      : 'Account suspended',
  );
}

/**
 * Rotate: verify the refresh JWT, ensure its stored hash exists and is neither
 * revoked nor expired, revoke it, and issue a fresh pair. Reuse of a revoked
 * token yields 401.
 */
export async function refresh(refreshToken: string): Promise<AuthResponse['tokens']> {
  const claims = jwtService.verifyUserRefresh(refreshToken);
  const tokenHash = hashToken(refreshToken);

  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw AppError.unauthorized('Refresh token is invalid or expired');
  }
  if (stored.userId !== claims.sub) throw AppError.unauthorized('Token subject mismatch');

  // Deny refresh for suspended accounts (admins also revoke refresh tokens on suspend).
  const user = await prisma.user.findUnique({ where: { id: claims.sub } });
  if (!user) throw AppError.unauthorized('User no longer exists');
  if (isSuspended(user)) throw suspendedError(user);

  await prisma.refreshToken.update({
    where: { tokenHash },
    data: { revokedAt: new Date() },
  });

  return issueTokens(claims.sub);
}

export async function logout(refreshToken: string): Promise<void> {
  const tokenHash = hashToken(refreshToken);
  await prisma.refreshToken.updateMany({
    where: { tokenHash, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

export async function getMe(userId: string): Promise<PublicUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');
  return toPublicUser(user);
}

/**
 * Issue a password-reset token and email a reset link. Always resolves (even when
 * the email is unknown) so callers cannot use this to enumerate accounts.
 */
export async function requestPasswordReset(email: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user) return;

  const token = randomToken();
  await prisma.passwordResetToken.create({
    data: {
      userId: user.id,
      tokenHash: hashToken(token),
      expiresAt: new Date(Date.now() + RESET_TOKEN_TTL_MS),
    },
  });

  const resetUrl = `${env.WEB_APP_URL}/reset-password?token=${token}`;
  await sendMail({
    to: user.email,
    subject: 'Reset your Life Planner password',
    text:
      `We received a request to reset your password.\n\n` +
      `Reset it here (valid for 1 hour): ${resetUrl}\n\n` +
      `If you didn't request this, you can safely ignore this email.`,
  });
}

/**
 * Complete a reset: validate the token, set the new password, mark the token used,
 * and revoke all refresh tokens so existing sessions are invalidated.
 */
export async function resetPassword(token: string, newPassword: string): Promise<void> {
  const stored = await prisma.passwordResetToken.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!stored || stored.usedAt || stored.expiresAt < new Date()) {
    throw AppError.badRequest('Reset token is invalid or expired');
  }

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: stored.userId }, data: { passwordHash } }),
    prisma.passwordResetToken.update({
      where: { id: stored.id },
      data: { usedAt: new Date() },
    }),
    prisma.refreshToken.updateMany({
      where: { userId: stored.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
  logger.info({ userId: stored.userId }, 'password reset completed');
}

/** Change password while authenticated; revokes other sessions on success. */
export async function changePassword(
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  const valid = await verifyPassword(user.passwordHash, currentPassword);
  if (!valid) throw AppError.unauthorized('Current password is incorrect');

  const passwordHash = await hashPassword(newPassword);
  await prisma.$transaction([
    prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
    prisma.refreshToken.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt: new Date() },
    }),
  ]);
}

/** Permanently delete the account (cascades to all related rows) after re-auth. */
export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) throw AppError.notFound('User not found');

  const valid = await verifyPassword(user.passwordHash, password);
  if (!valid) throw AppError.unauthorized('Password is incorrect');

  await prisma.user.delete({ where: { id: userId } });
  logger.info({ userId }, 'account deleted by user');
}
