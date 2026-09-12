import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  idParamSchema,
  parseDateOnly,
  requestMealPlanSchema,
  sendOk,
  updateMealRequestSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import {
  assertMealPlansEnabled,
  findPendingRequest,
  nutritionCapabilities,
  serializeRequest,
} from '../lib/mealPlans.js';

export const mealRequestsRouter = Router();

/**
 * P-18 — the person asks a coach for a plan; the request surfaces in the admin
 * queue. Addendum 5 §3 adds the rule that only one request may be open at a
 * time: a queue of six half-remembered asks helps nobody, and the coach needs
 * to know which day is actually being asked about.
 */
mealRequestsRouter.post(
  '/',
  validate(requestMealPlanSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await assertMealPlansEnabled(me.id);

    const pending = await findPendingRequest(me.id);
    if (pending) {
      throw AppError.conflict(
        'You already have a plan request waiting with your coach. Cancel it first if you would rather ask about a different day.',
        ErrorCode.MEAL_REQUEST_PENDING,
        { pendingRequest: serializeRequest(pending) },
      );
    }

    const date = parseDateOnly(req.body.date);

    // Upsert, not create: a day whose earlier request was fulfilled, declined
    // or withdrawn can be asked about again, and the unique key is [user, date].
    const request = await prisma.mealPlanRequest.upsert({
      where: { userId_date: { userId: me.id, date } },
      update: {
        note: req.body.note ?? null,
        status: 'PENDING',
        handledAt: null,
        handledByAdminId: null,
        responseNote: null,
      },
      create: { userId: me.id, date, note: req.body.note ?? null },
    });

    sendOk(res, { request: serializeRequest(request) }, 201);
  }),
);

mealRequestsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const [requests, capabilities] = await Promise.all([
      prisma.mealPlanRequest.findMany({
        where: { userId: me.id },
        orderBy: { date: 'desc' },
        take: 50,
      }),
      nutritionCapabilities(me.id),
    ]);

    sendOk(res, { requests: requests.map(serializeRequest), ...capabilities });
  }),
);

/**
 * The single question the nutrition page asks on load: may I show the Request
 * button, and if not, why not?
 */
mealRequestsRouter.get(
  '/pending',
  asyncHandler(async (req, res) => {
    sendOk(res, await nutritionCapabilities(currentUser(req).id));
  }),
);

/** A pending request can be reworded. Changing the day means cancel and re-ask. */
mealRequestsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateMealRequestSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.mealPlanRequest.findFirst({
      where: { id: req.params.id, userId: me.id },
    });
    if (!existing) throw AppError.notFound('Request not found');
    if (existing.status !== 'PENDING') {
      throw AppError.conflict(
        'That request has already been handled.',
        ErrorCode.CONFLICT,
        { status: existing.status },
      );
    }

    const request = await prisma.mealPlanRequest.update({
      where: { id: existing.id },
      data: { note: req.body.note },
    });
    sendOk(res, { request: serializeRequest(request) });
  }),
);

/**
 * Withdrawing rather than deleting: the coach may already have started on it,
 * so the row stays and becomes CANCELLED. That also frees the person to raise
 * a new request straight away.
 */
mealRequestsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.mealPlanRequest.findFirst({
      where: { id: req.params.id, userId: me.id },
    });
    if (!existing) throw AppError.notFound('Request not found');
    if (existing.status !== 'PENDING') {
      throw AppError.conflict(
        'Only a pending request can be cancelled.',
        ErrorCode.CONFLICT,
        { status: existing.status },
      );
    }

    const request = await prisma.mealPlanRequest.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED', handledAt: new Date() },
    });

    sendOk(res, { request: serializeRequest(request), canRequestPlan: true });
  }),
);
