import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  banUserSchema,
  idParamSchema,
  paginate,
  adminUserQuerySchema,
  adminUpdateUserSchema,
  setPersonalitySchema,
  sendOk,
  sharedBoardQuerySchema,
  suspendUserSchema,
  moderationHistoryQuerySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentAdmin } from '../middleware/auth.js';
import { buildAdminBoard } from '../lib/board.js';
import { publishRealtime, userRoom } from '../lib/realtime.js';

export const adminUsersRouter = Router();

const activityParamsSchema = z.object({ id: z.string().min(1), activityId: z.string().min(1) });

const userSummary = {
  id: true,
  email: true,
  name: true,
  timezone: true,
  country: true,
  status: true,
  statusReason: true,
  statusChangedAt: true,
  statusChangedByAdminId: true,
  createdAt: true,
} satisfies Prisma.UserSelect;

// ---------------------------------------------------------------------------
// Search / lookup
// ---------------------------------------------------------------------------

adminUsersRouter.get(
  '/',
  validate(adminUserQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { q, status, subscription, country, joinedFrom, joinedTo, page, pageSize } =
      req.query as unknown as {
        q?: string;
        status?: 'ACTIVE' | 'SUSPENDED' | 'BANNED' | 'DELETED';
        subscription?: 'FREE' | 'PRO' | 'EXPIRED';
        country?: string;
        joinedFrom?: string;
        joinedTo?: string;
        page: number;
        pageSize: number;
      };

    // A lapsed PRO row is reported as EXPIRED, matching what the console shows
    // in the subscription column.
    const subscriptionFilter: Prisma.UserWhereInput =
      subscription === 'FREE'
        ? { OR: [{ subscription: null }, { subscription: { tier: 'FREE' } }] }
        : subscription === 'PRO'
          ? { subscription: { tier: 'PRO', status: { in: ['ACTIVE', 'TRIALING', 'PAST_DUE'] } } }
          : subscription === 'EXPIRED'
            ? { subscription: { tier: 'PRO', status: { in: ['EXPIRED', 'CANCELLED'] } } }
            : {};

    const where: Prisma.UserWhereInput = {
      // 'DELETED' is a soft-delete filter, not a status column value.
      ...(status === 'DELETED' ? { deletedAt: { not: null } } : { deletedAt: null }),
      ...(status && status !== 'DELETED' ? { status } : {}),
      ...(country ? { country } : {}),
      ...subscriptionFilter,
      ...(joinedFrom || joinedTo
        ? {
            createdAt: {
              ...(joinedFrom ? { gte: new Date(`${joinedFrom}T00:00:00.000Z`) } : {}),
              ...(joinedTo ? { lte: new Date(`${joinedTo}T23:59:59.999Z`) } : {}),
            },
          }
        : {}),
      ...(q
        ? {
            OR: [
              { email: { contains: q, mode: 'insensitive' } },
              { name: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {}),
    };

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        select: {
          ...userSummary,
          country: true,
          deletedAt: true,
          subscription: {
            select: { tier: true, status: true, currentPeriodEnd: true, interval: true },
          },
          _count: {
            select: {
              activities: true,
              goals: true,
              conversations: true,
              mealPlans: true,
              budgetMonths: true,
            },
          },
        },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.user.count({ where }),
    ]);

    sendOk(
      res,
      paginate(
        users.map((u) => ({
          ...u,
          // The console renders "Deleted" as an account state alongside
          // Active/Suspended/Banned, even though it lives in a different column.
          accountState: u.deletedAt ? 'DELETED' : u.status,
          counts: u._count,
          _count: undefined,
        })),
        page,
        pageSize,
        total,
      ),
    );
  }),
);

adminUsersRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: {
        ...userSummary,
        country: true,
        phone: true,
        location: true,
        state: true,
        heightCm: true,
        yearOfBirth: true,
        gender: true,
        /// Admin-only. See the note on User.personalityNotes.
        personalityNotes: true,
        statusChangedByAdmin: { select: { id: true, name: true } },
        settings: true,
        subscription: true,
        _count: {
          select: {
            activities: true,
            goals: true,
            conversations: true,
            mealPlans: true,
            budgetMonths: true,
          },
        },
      },
    });
    if (!user) throw AppError.notFound('User not found');
    sendOk(res, { user: { ...user, counts: user._count, _count: undefined } });
  }),
);

// ---------------------------------------------------------------------------
// Read-only board inspection — private activities included unconditionally
// ---------------------------------------------------------------------------

adminUsersRouter.get(
  '/:id/board',
  validate(idParamSchema, 'params'),
  validate(sharedBoardQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { from, to } = req.query as unknown as { from: string; to: string };
    const user = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true, name: true, email: true, status: true },
    });
    if (!user) throw AppError.notFound('User not found');

    const board = await buildAdminBoard(user.id, from, to);
    sendOk(res, { user, ...board });
  }),
);

// ---------------------------------------------------------------------------
// Suspend / ban / reinstate
// ---------------------------------------------------------------------------

const ACTION_FOR: Record<string, 'SUSPENDED' | 'BANNED' | 'REINSTATED'> = {
  SUSPENDED: 'SUSPENDED',
  BANNED: 'BANNED',
  ACTIVE: 'REINSTATED',
};

/**
 * Flips the account state and writes an immutable ModerationEvent in the same
 * transaction. The event log is what the console's banned/suspended charts read
 * from — User.status alone is current state, so reinstating someone would
 * otherwise erase the fact they were ever suspended.
 */
const setStatus = async (
  userId: string,
  adminId: string,
  status: 'ACTIVE' | 'SUSPENDED' | 'BANNED',
  reason?: string,
  suspendedUntil?: Date | null,
) => {
  const existing = await prisma.user.findFirst({
    where: { id: userId, deletedAt: null },
    select: { id: true },
  });
  if (!existing) throw AppError.notFound('User not found');

  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: {
        status,
        statusReason: status === 'ACTIVE' ? null : (reason ?? null),
        suspendedUntil: status === 'SUSPENDED' ? (suspendedUntil ?? null) : null,
        statusChangedAt: new Date(),
        statusChangedByAdminId: adminId,
      },
      select: { ...userSummary, suspendedUntil: true },
    });

    await tx.moderationEvent.create({
      data: {
        userId,
        adminId,
        action: ACTION_FOR[status],
        reason: status === 'ACTIVE' ? null : (reason ?? null),
        expiresAt: status === 'SUSPENDED' ? (suspendedUntil ?? null) : null,
      },
    });

    return user;
  });
};

adminUsersRouter.post(
  '/:id/suspend',
  validate(idParamSchema, 'params'),
  validate(suspendUserSchema),
  asyncHandler(async (req, res) => {
    const admin = currentAdmin(req);
    const { reason, days, until } = req.body as {
      reason: string;
      days?: number;
      until?: string;
    };

    // A suspension is temporary by definition; default to a week rather than
    // letting it be open-ended, which would be a ban by another name.
    const suspendedUntil = until
      ? new Date(until)
      : new Date(Date.now() + (days ?? 7) * 86_400_000);

    if (suspendedUntil.getTime() <= Date.now()) {
      throw AppError.badRequest('A suspension must end in the future');
    }

    // SUSPENDED leaves existing access tokens to expire naturally (<=15 min)
    // but blocks login and refresh from that point on.
    const user = await setStatus(req.params.id, admin.id, 'SUSPENDED', reason, suspendedUntil);
    sendOk(res, { user, suspendedUntil, sessionsRevoked: 0 });
  }),
);

adminUsersRouter.post(
  '/:id/ban',
  validate(idParamSchema, 'params'),
  validate(banUserSchema),
  asyncHandler(async (req, res) => {
    const admin = currentAdmin(req);
    const user = await setStatus(req.params.id, admin.id, 'BANNED', req.body.reason);

    // BANNED additionally revokes every refresh token so live sessions die now.
    const revoked = await prisma.refreshToken.updateMany({
      where: { userId: user.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });

    // Best-effort nudge to any connected socket; the handshake re-check does the
    // rest within the access-token TTL.
    // The reason is deliberately not sent to the client — a ban is not explained
    // to the account it applies to.
    await publishRealtime(userRoom(user.id), 'account:banned', {}).catch(() => undefined);

    sendOk(res, { user, sessionsRevoked: revoked.count });
  }),
);

adminUsersRouter.post(
  '/:id/reinstate',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const admin = currentAdmin(req);
    const user = await setStatus(req.params.id, admin.id, 'ACTIVE');
    sendOk(res, { user });
  }),
);

// ---------------------------------------------------------------------------
// Admin-initiated task deletion
// ---------------------------------------------------------------------------

adminUsersRouter.delete(
  '/:id/activities/:activityId',
  validate(activityParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const admin = currentAdmin(req);
    const activity = await prisma.activity.findFirst({
      where: { id: req.params.activityId, userId: req.params.id, deletedAt: null },
    });
    if (!activity) throw AppError.notFound('Activity not found on that user’s board');

    /**
     * Soft delete via the same deletedAt mechanism as the user-facing delete,
     * plus a DELETED_BY_ADMIN history row carrying the acting adminId — so the
     * audit trail distinguishes admin removal from the user's own.
     */
    await prisma.$transaction([
      prisma.activity.update({
        where: { id: activity.id },
        data: { deletedAt: new Date() },
      }),
      prisma.activityHistory.create({
        data: {
          activityId: activity.id,
          changeType: 'DELETED_BY_ADMIN',
          adminId: admin.id,
          snapshot: {
            adminId: admin.id,
            adminName: admin.name,
            title: activity.title,
            date: activity.date ? activity.date.toISOString().slice(0, 10) : null,
            isPrivate: activity.isPrivate,
            deletedAt: new Date().toISOString(),
          },
        },
      }),
    ]);

    sendOk(res, { deleted: true, activityId: activity.id });
  }),
);

// ---------------------------------------------------------------------------
// Personality notes — admin eyes only
// ---------------------------------------------------------------------------

/**
 * A short list of things the desks should know about how to work with someone:
 * "answers voice notes faster than text", "evenings are rarely free".
 *
 * Written by staff, about the person, and never exposed on any user-facing
 * endpoint — a note like "loses momentum after two missed days" is useful to a
 * coach and would be a horrible thing to discover about yourself in your own
 * profile. The user API selects columns explicitly, so this cannot leak by
 * accident.
 */
adminUsersRouter.get(
  '/:id/personality',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const user = await prisma.user.findFirst({
      where: { id: req.params.id },
      select: { id: true, name: true, personalityNotes: true },
    });
    if (!user) throw AppError.notFound('User not found');
    sendOk(res, { userId: user.id, notes: user.personalityNotes });
  }),
);

/** Replaces the whole list. An empty array is the console's "delete list". */
adminUsersRouter.put(
  '/:id/personality',
  validate(idParamSchema, 'params'),
  validate(setPersonalitySchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('User not found');

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: { personalityNotes: req.body.notes },
      select: { id: true, personalityNotes: true },
    });
    sendOk(res, { userId: user.id, notes: user.personalityNotes });
  }),
);

/** Profile edits made from the console's user drawer. */
adminUsersRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(adminUpdateUserSchema),
  asyncHandler(async (req, res) => {
    const existing = await prisma.user.findFirst({
      where: { id: req.params.id, deletedAt: null },
      select: { id: true },
    });
    if (!existing) throw AppError.notFound('User not found');

    if (req.body.email) {
      const clash = await prisma.user.findFirst({
        where: { email: req.body.email, id: { not: existing.id } },
        select: { id: true },
      });
      if (clash) throw AppError.conflict('Another account already uses that email');
    }

    const user = await prisma.user.update({
      where: { id: existing.id },
      data: req.body,
      select: { ...userSummary, country: true, phone: true },
    });
    sendOk(res, { user });
  }),
);

/** The account's moderation history, newest first. */
adminUsersRouter.get(
  '/:id/moderation',
  validate(idParamSchema, 'params'),
  validate(moderationHistoryQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const { page, pageSize } = req.query as unknown as { page: number; pageSize: number };
    const where = { userId: req.params.id };

    const [events, total] = await Promise.all([
      prisma.moderationEvent.findMany({
        where,
        include: { admin: { select: { id: true, name: true } } },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      prisma.moderationEvent.count({ where }),
    ]);

    sendOk(res, paginate(events, page, pageSize, total));
  }),
);
