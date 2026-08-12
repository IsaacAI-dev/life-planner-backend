import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  DEFAULT_CATEGORIES,
  ErrorCode,
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
  resetPasswordSchema,
  sendOk,
  updateProfileSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { authLimiter } from '../middleware/rateLimit.js';
import { currentUser, requireAuth, assertUsable } from '../middleware/auth.js';
import { hashPassword, verifyPassword } from '../lib/password.js';
import {
  generateOpaqueToken,
  hashToken,
  issueTokens,
  revokeAllUserRefreshTokens,
  revokeRefreshToken,
  rotateRefreshToken,
} from '../lib/tokens.js';
import { publicUser } from '../lib/serializers.js';
import { sendMail } from '../lib/mailer.js';
import { issueSecurityAction } from '../lib/security.js';
import { logger } from '../lib/logger.js';

export const authRouter = Router();

authRouter.post(
  '/register',
  authLimiter,
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const { email, password, name, timezone, country } = req.body;

    const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
    if (existing) throw AppError.conflict('That email is already registered', ErrorCode.EMAIL_TAKEN);

    const user = await prisma.user.create({
      data: {
        email,
        name,
        timezone,
        country: country ?? null,
        passwordHash: await hashPassword(password),
        icalToken: generateOpaqueToken(),
        categories: {
          create: DEFAULT_CATEGORIES.map((c) => ({
            name: c.name,
            color: c.color,
            icon: c.icon,
            order: c.order,
          })),
        },
        settings: { create: { timezone } },
      },
    });

    const tokens = await issueTokens(user.id, user.email);

    // A welcome mail doubles as the notice that someone opened an account with
    // this address. If it wasn't them, the report link suspends it and ends
    // every session.
    const security = await issueSecurityAction({
      type: 'SIGNUP',
      email: user.email,
      userId: user.id,
    });

    await sendMail({
      to: user.email,
      subject: 'Welcome to Life Planner',
      text: [
        `Hi ${user.name}, your Life Planner account is ready.`,
        '',
        'A calm canvas for a colorful life — start by planning tomorrow.',
        '',
        "Didn't sign up? This account was created with your email address.",
        `Tell us here and we'll close it: ${security.reportUrl}`,
      ].join('\n'),
    }).catch((err) => logger.error({ err }, 'Welcome mail failed'));

    sendOk(res, { user: publicUser(user), tokens }, 201);
  }),
);

authRouter.post(
  '/login',
  authLimiter,
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const { email, password } = req.body;
    const user = await prisma.user.findUnique({ where: { email } });

    if (!user || !(await verifyPassword(user.passwordHash, password))) {
      throw AppError.unauthorized('Email or password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }

    // Addendum 2 §18.6 — login is one of the two enforcement points for status.
    assertUsable(user);

    const tokens = await issueTokens(user.id, user.email);
    sendOk(res, { user: publicUser(user), tokens });
  }),
);

authRouter.post(
  '/refresh',
  authLimiter,
  validate(refreshSchema),
  asyncHandler(async (req, res) => {
    const { user, tokens } = await rotateRefreshToken(req.body.refreshToken);
    sendOk(res, { user: publicUser(user), tokens });
  }),
);

authRouter.post(
  '/logout',
  validate(logoutSchema),
  asyncHandler(async (req, res) => {
    if (req.body.refreshToken) await revokeRefreshToken(req.body.refreshToken);
    sendOk(res, { loggedOut: true });
  }),
);

authRouter.get(
  '/me',
  requireAuth,
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.findUniqueOrThrow({
      where: { id: me.id },
      include: { settings: true },
    });
    sendOk(res, { user: publicUser(user), settings: user.settings });
  }),
);

authRouter.patch(
  '/me',
  requireAuth,
  validate(updateProfileSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.update({ where: { id: me.id }, data: req.body });
    sendOk(res, { user: publicUser(user) });
  }),
);

authRouter.post(
  '/change-password',
  requireAuth,
  authLimiter,
  validate(changePasswordSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const user = await prisma.user.findUniqueOrThrow({ where: { id: me.id } });

    if (!(await verifyPassword(user.passwordHash, req.body.currentPassword))) {
      throw AppError.unauthorized('Current password is incorrect', ErrorCode.INVALID_CREDENTIALS);
    }

    await prisma.user.update({
      where: { id: me.id },
      data: { passwordHash: await hashPassword(req.body.newPassword) },
    });
    // Changing the password kills every other session.
    await revokeAllUserRefreshTokens(me.id);

    const tokens = await issueTokens(user.id, user.email);
    sendOk(res, { changed: true, tokens });
  }),
);

authRouter.post(
  '/forgot-password',
  authLimiter,
  validate(forgotPasswordSchema),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findUnique({ where: { email: req.body.email } });

    // Always answer identically — never leak whether an address is registered.
    if (user && !user.deletedAt && user.status !== 'BANNED') {
      const token = generateOpaqueToken();
      await prisma.passwordResetToken.create({
        data: {
          userId: user.id,
          tokenHash: hashToken(token),
          expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        },
      });
      const security = await issueSecurityAction({
        type: 'PASSWORD_RESET',
        email: user.email,
        userId: user.id,
      });

      await sendMail({
        to: user.email,
        subject: 'Reset your Life Planner password',
        text: [
          `Use this token within the next hour to reset your password: ${token}`,
          '',
          "Didn't ask for this? Tell us here and we'll void the link and sign out every device:",
          security.reportUrl,
        ].join('\n'),
      });
      logger.debug({ userId: user.id }, 'Password reset token issued');
    }

    sendOk(res, {
      requested: true,
      message: 'If that email is registered, a reset link is on its way.',
    });
  }),
);

authRouter.post(
  '/reset-password',
  authLimiter,
  validate(resetPasswordSchema),
  asyncHandler(async (req, res) => {
    const record = await prisma.passwordResetToken.findUnique({
      where: { tokenHash: hashToken(req.body.token) },
      include: { user: true },
    });

    if (!record || record.usedAt || record.expiresAt.getTime() < Date.now()) {
      throw AppError.badRequest('This reset token is invalid or has expired', ErrorCode.TOKEN_INVALID);
    }
    assertUsable(record.user);

    await prisma.$transaction([
      prisma.user.update({
        where: { id: record.userId },
        data: { passwordHash: await hashPassword(req.body.password) },
      }),
      prisma.passwordResetToken.update({
        where: { id: record.id },
        data: { usedAt: new Date() },
      }),
      prisma.refreshToken.updateMany({
        where: { userId: record.userId, revokedAt: null },
        data: { revokedAt: new Date() },
      }),
    ]);

    sendOk(res, { reset: true });
  }),
);
