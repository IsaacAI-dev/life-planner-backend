import { Router } from 'express';
import { prisma, type Prisma } from '@lifeplanner/database';
import { recordEventSchema, sendOk } from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { optionalAuth } from '../middleware/auth.js';
import { analyticsLimiter } from '../middleware/rateLimit.js';

export const analyticsRouter = Router();

/**
 * Addendum 2 §18.7 — deliberately not behind requireAuth: page views happen
 * before login too. optionalAuth attaches req.user when a valid token is
 * present and continues silently when it isn't, so the event still carries a
 * userId for logged-in visitors without gatekeeping anonymous ones.
 *
 * Signups are NOT logged here — they're derived from User.createdAt, so there's
 * only ever one source of truth for that fact.
 */
analyticsRouter.post(
  '/events',
  analyticsLimiter,
  optionalAuth,
  validate(recordEventSchema),
  asyncHandler(async (req, res) => {
    const { type, path, referrer, sessionId, metadata } = req.body;

    const event = await prisma.analyticsEvent.create({
      data: {
        type,
        path: path ?? null,
        referrer: referrer ?? null,
        sessionId: sessionId ?? null,
        userId: req.user?.id ?? null,
        metadata: (metadata ?? undefined) as Prisma.InputJsonValue | undefined,
      },
      select: { id: true, type: true, createdAt: true },
    });

    // 202: the client fires and forgets; it never needs the stored row back.
    sendOk(res, { recorded: true, event }, 202);
  }),
);
