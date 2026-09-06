import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '@lifeplanner/database';
import {
  AppError,
  createGoalSchema,
  createMilestoneSchema,
  idParamSchema,
  listGoalsQuerySchema,
  parseDateOnly,
  sendOk,
  updateGoalSchema,
  updateMilestoneSchema,
  featureGoalSchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { serializeGoal } from '../lib/serializers.js';
import { assertGoalQuota } from '../lib/entitlements.js';

export const goalsRouter = Router();

const milestoneParamsSchema = z.object({ id: z.string().min(1), milestoneId: z.string().min(1) });

const withProgress = (goal: Record<string, unknown>) => {
  const activities = (goal.activities as { isDone: boolean }[] | undefined) ?? [];
  const milestones = (goal.milestones as { isDone: boolean }[] | undefined) ?? [];
  const doneActivities = activities.filter((a) => a.isDone).length;
  const doneMilestones = milestones.filter((m) => m.isDone).length;
  return {
    ...serializeGoal(goal),
    progress: {
      activities: { total: activities.length, done: doneActivities },
      milestones: { total: milestones.length, done: doneMilestones },
      percent:
        activities.length + milestones.length === 0
          ? 0
          : Math.round(
              ((doneActivities + doneMilestones) / (activities.length + milestones.length)) * 100,
            ),
    },
  };
};

goalsRouter.get(
  '/',
  validate(listGoalsQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { status } = req.query as unknown as { status?: 'ACTIVE' | 'ACHIEVED' | 'ARCHIVED' };
    const goals = await prisma.goal.findMany({
      where: { userId: me.id, deletedAt: null, ...(status ? { status } : {}) },
      include: {
        milestones: { orderBy: { order: 'asc' } },
        activities: { where: { deletedAt: null }, select: { id: true, isDone: true } },
      },
      orderBy: [{ status: 'asc' }, { targetDate: 'asc' }, { createdAt: 'desc' }],
    });
    sendOk(res, { goals: goals.map(withProgress) });
  }),
);

goalsRouter.post(
  '/',
  validate(createGoalSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    await assertGoalQuota(me.id, 1);
    const { targetDate, ...rest } = req.body;
    const goal = await prisma.goal.create({
      data: { ...rest, userId: me.id, targetDate: targetDate ? parseDateOnly(targetDate) : null },
      include: { milestones: true },
    });
    sendOk(res, { goal: serializeGoal(goal) }, 201);
  }),
);

goalsRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const goal = await prisma.goal.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      include: {
        milestones: { orderBy: { order: 'asc' } },
        activities: { where: { deletedAt: null }, select: { id: true, title: true, isDone: true, date: true } },
      },
    });
    if (!goal) throw AppError.notFound('Goal not found');
    sendOk(res, { goal: withProgress(goal) });
  }),
);

goalsRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateGoalSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.goal.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Goal not found');

    const { targetDate, ...rest } = req.body;
    const goal = await prisma.goal.update({
      where: { id: owned.id },
      data: {
        ...rest,
        ...(targetDate === undefined
          ? {}
          : { targetDate: targetDate ? parseDateOnly(targetDate) : null }),
      },
      include: { milestones: { orderBy: { order: 'asc' } } },
    });
    sendOk(res, { goal: serializeGoal(goal) });
  }),
);

goalsRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.goal.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Goal not found');
    await prisma.goal.update({ where: { id: owned.id }, data: { deletedAt: new Date() } });
    sendOk(res, { deleted: true });
  }),
);

goalsRouter.post(
  '/:id/milestones',
  validate(idParamSchema, 'params'),
  validate(createMilestoneSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.goal.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Goal not found');

    const { dueDate, ...rest } = req.body;
    const milestone = await prisma.milestone.create({
      data: { ...rest, goalId: owned.id, dueDate: dueDate ? parseDateOnly(dueDate) : null },
    });
    sendOk(res, { milestone }, 201);
  }),
);

goalsRouter.patch(
  '/:id/milestones/:milestoneId',
  validate(milestoneParamsSchema, 'params'),
  validate(updateMilestoneSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const milestone = await prisma.milestone.findFirst({
      where: { id: req.params.milestoneId, goal: { id: req.params.id, userId: me.id } },
      select: { id: true },
    });
    if (!milestone) throw AppError.notFound('Milestone not found');

    const { dueDate, ...rest } = req.body;
    const updated = await prisma.milestone.update({
      where: { id: milestone.id },
      data: { ...rest, ...(dueDate === undefined ? {} : { dueDate: dueDate ? parseDateOnly(dueDate) : null }) },
    });
    sendOk(res, { milestone: updated });
  }),
);

goalsRouter.delete(
  '/:id/milestones/:milestoneId',
  validate(milestoneParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const milestone = await prisma.milestone.findFirst({
      where: { id: req.params.milestoneId, goal: { id: req.params.id, userId: me.id } },
      select: { id: true },
    });
    if (!milestone) throw AppError.notFound('Milestone not found');
    await prisma.milestone.delete({ where: { id: milestone.id } });
    sendOk(res, { deleted: true });
  }),
);

/**
 * P-17 — exactly one featured goal. Clearing the others happens in the same
 * transaction so the invariant can't be broken by two concurrent calls.
 */
goalsRouter.patch(
  '/:id/featured',
  validate(idParamSchema, 'params'),
  validate(featureGoalSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.goal.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Goal not found');

    const goal = await prisma.$transaction(async (tx) => {
      if (req.body.featured) {
        await tx.goal.updateMany({
          where: { userId: me.id, featured: true, id: { not: owned.id } },
          data: { featured: false },
        });
      }
      return tx.goal.update({
        where: { id: owned.id },
        data: { featured: req.body.featured },
        include: { milestones: { orderBy: { order: 'asc' } } },
      });
    });

    sendOk(res, { goal: serializeGoal(goal) });
  }),
);
