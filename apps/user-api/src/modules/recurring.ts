import { Router } from 'express';
// `rrule` ships as CommonJS; a named ESM import fails at runtime under NodeNext.
import rrulePkg from 'rrule';

const { RRule } = rrulePkg;
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  createRecurringSchema,
  idParamSchema,
  sendOk,
  updateRecurringSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { assertCategoryOwned } from '../lib/prismaHelpers.js';
import { materializeTemplate } from '../jobs/recurring.js';

export const recurringRouter = Router();

const assertValidRrule = (rrule: string) => {
  try {
    RRule.fromString(rrule.startsWith('RRULE:') ? rrule : `RRULE:${rrule}`);
  } catch {
    throw AppError.badRequest('rrule is not a valid RFC 5545 recurrence rule');
  }
};

recurringRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const recurring = await prisma.recurringTemplate.findMany({
      where: { userId: me.id },
      include: { category: { select: { id: true, name: true, color: true } } },
      orderBy: { createdAt: 'desc' },
    });
    sendOk(res, { recurring });
  }),
);

recurringRouter.post(
  '/',
  validate(createRecurringSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    assertValidRrule(req.body.rrule);
    await assertCategoryOwned(me.id, req.body.categoryId);

    const recurring = await prisma.recurringTemplate.create({
      data: { ...req.body, userId: me.id, categoryId: req.body.categoryId ?? null },
    });

    // Materialize immediately so the user sees occurrences without waiting for cron.
    const created = await materializeTemplate(recurring);
    sendOk(res, { recurring, materialized: created }, 201);
  }),
);

recurringRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateRecurringSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.recurringTemplate.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Recurring template not found');
    if (req.body.rrule) assertValidRrule(req.body.rrule);
    if (req.body.categoryId !== undefined) await assertCategoryOwned(me.id, req.body.categoryId);

    const recurring = await prisma.recurringTemplate.update({ where: { id: owned.id }, data: req.body });
    sendOk(res, { recurring });
  }),
);

recurringRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.recurringTemplate.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Recurring template not found');

    // Deactivate rather than delete: already-materialized activities stay put.
    const recurring = await prisma.recurringTemplate.update({
      where: { id: owned.id },
      data: { active: false },
    });
    sendOk(res, { deactivated: true, recurring });
  }),
);
