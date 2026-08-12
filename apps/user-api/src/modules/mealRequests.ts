import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  parseDateOnly,
  requestMealPlanSchema,
  sendOk,
  toDateOnlyString,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { getEntitlements } from '../lib/entitlements.js';

export const mealRequestsRouter = Router();

/**
 * P-18 — Addendum 2 made plans admin-authored with no way for a person to ask
 * for one. This closes that loop; the request surfaces in the admin queue.
 */
mealRequestsRouter.post(
  '/',
  validate(requestMealPlanSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const ent = await getEntitlements(me.id);
    if (!ent.limits.mealPlansEnabled) {
      throw new AppError(402, ErrorCode.FORBIDDEN, 'Meal plans are part of Life Planner Pro.', {
        upgradeRequired: true,
      });
    }

    const date = parseDateOnly(req.body.date);

    const request = await prisma.mealPlanRequest.upsert({
      where: { userId_date: { userId: me.id, date } },
      update: { note: req.body.note ?? null, status: 'PENDING', handledAt: null },
      create: { userId: me.id, date, note: req.body.note ?? null },
    });

    sendOk(res, { request: { ...request, date: toDateOnlyString(request.date) } }, 201);
  }),
);

mealRequestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const requests = await prisma.mealPlanRequest.findMany({
      where: { userId: me.id },
      orderBy: { date: 'desc' },
      take: 50,
    });
    sendOk(res, { requests: requests.map((r) => ({ ...r, date: toDateOnlyString(r.date) })) });
  }),
);
