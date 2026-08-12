import { Router } from 'express';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  createReminderSchema,
  idParamSchema,
  listRemindersQuerySchema,
  sendOk,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';

export const remindersRouter = Router();

remindersRouter.get(
  '/',
  validate(listRemindersQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { status, activityId } = req.query as unknown as {
      status?: 'PENDING' | 'SENT' | 'CANCELLED' | 'FAILED';
      activityId?: string;
    };
    const reminders = await prisma.reminder.findMany({
      // activityId is still scoped by userId, so passing someone else's id
      // returns nothing rather than leaking their reminders.
      where: { userId: me.id, ...(status ? { status } : {}), ...(activityId ? { activityId } : {}) },
      include: { activity: { select: { id: true, title: true, date: true } } },
      orderBy: { remindAt: 'asc' },
    });
    sendOk(res, { reminders });
  }),
);

remindersRouter.post(
  '/',
  validate(createReminderSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { activityId, remindAt, ...rest } = req.body;

    if (activityId) {
      const owned = await prisma.activity.findFirst({
        where: { id: activityId, userId: me.id, deletedAt: null },
        select: { id: true },
      });
      if (!owned) throw AppError.badRequest('activityId does not belong to you');
    }

    const when = new Date(remindAt);
    if (Number.isNaN(when.getTime())) throw AppError.badRequest('remindAt is not a valid date');

    const reminder = await prisma.reminder.create({
      data: { ...rest, userId: me.id, activityId: activityId ?? null, remindAt: when },
    });
    sendOk(res, { reminder }, 201);
  }),
);

remindersRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.reminder.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true, status: true },
    });
    if (!owned) throw AppError.notFound('Reminder not found');

    const reminder = await prisma.reminder.update({
      where: { id: owned.id },
      data: { status: 'CANCELLED' },
    });
    sendOk(res, { cancelled: true, reminder });
  }),
);
