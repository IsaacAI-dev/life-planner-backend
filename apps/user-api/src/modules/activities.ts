import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  bulkCreateActivitySchema,
  createActivitySchema,
  createFlexibleActivitySchema,
  eachDayInRange,
  idParamSchema,
  isWeekend,
  listActivitiesQuerySchema,
  parseDateOnly,
  progressActivitySchema,
  reorderActivitiesSchema,
  sendOk,
  toggleActivitySchema,
  updateActivitySchema,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import {
  activityInclude,
  assertCategoryOwned,
  assertGoalOwned,
  connectTags,
  findOwnedActivity,
} from '../lib/prismaHelpers.js';
import { serializeActivity } from '../lib/serializers.js';
import { assertActivityQuota } from '../lib/entitlements.js';

export const activitiesRouter = Router();

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

activitiesRouter.get(
  '/',
  validate(listActivitiesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const q = req.query as unknown as {
      from?: string;
      to?: string;
      done?: boolean;
      categoryId?: string;
      goalId?: string;
      q?: string;
      flexible?: boolean;
      activeOn?: string;
    };

    const where: Prisma.ActivityWhereInput = { userId: me.id, deletedAt: null };

    if (q.done !== undefined) where.isDone = q.done;
    if (q.categoryId) where.categoryId = q.categoryId;
    if (q.goalId) where.goalId = q.goalId;
    if (q.q) where.title = { contains: q.q, mode: 'insensitive' };

    if (q.flexible === true) {
      // Addendum 2 §18.3 — flexible tasks are exactly the date: null rows.
      where.date = null;
      if (q.activeOn) {
        const on = parseDateOnly(q.activeOn);
        where.windowStart = { lte: on };
        where.windowEnd = { gte: on };
      } else if (q.from && q.to) {
        // Window overlaps the requested range.
        where.windowStart = { lte: parseDateOnly(q.to) };
        where.windowEnd = { gte: parseDateOnly(q.from) };
      }
    } else {
      // Omitting the flag keeps the base spec's dated-only behavior untouched.
      where.date = { not: null };
      if (q.from) where.date = { ...(where.date as object), gte: parseDateOnly(q.from) };
      if (q.to) where.date = { ...(where.date as object), lte: parseDateOnly(q.to) };
    }

    const activities = await prisma.activity.findMany({
      where,
      include: activityInclude,
      orderBy:
        q.flexible === true
          ? [{ windowStart: 'asc' }, { createdAt: 'asc' }]
          : [{ date: 'asc' }, { order: 'asc' }, { startTime: 'asc' }],
    });

    sendOk(res, { activities: activities.map(serializeActivity) });
  }),
);

// ---------------------------------------------------------------------------
// Create (dated)
// ---------------------------------------------------------------------------

activitiesRouter.post(
  '/',
  validate(createActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { tags, date, categoryId, goalId, ...rest } = req.body;

    // Free tier is capped per week; the limit itself lives in the env.
    await assertActivityQuota(me.id, 1);
    await assertCategoryOwned(me.id, categoryId);
    await assertGoalOwned(me.id, goalId);

    const activityDate = parseDateOnly(date);
    const order =
      rest.order ??
      (await prisma.activity.count({ where: { userId: me.id, date: activityDate, deletedAt: null } }));

    const activity = await prisma.activity.create({
      data: {
        ...rest,
        order,
        userId: me.id,
        date: activityDate,
        categoryId: categoryId ?? null,
        goalId: goalId ?? null,
        tags: { connect: await connectTags(me.id, tags) },
        history: { create: { changeType: 'CREATED' } },
      },
      include: activityInclude,
    });

    sendOk(res, { activity: serializeActivity(activity) }, 201);
  }),
);

// ---------------------------------------------------------------------------
// Create (flexible / non-date-specific) — Addendum 2 §18.3
// ---------------------------------------------------------------------------

activitiesRouter.post(
  '/flexible',
  validate(createFlexibleActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { tags, categoryId, goalId, windowStart, windowEnd, ...rest } = req.body;

    await assertActivityQuota(me.id, 1);
    await assertCategoryOwned(me.id, categoryId);
    await assertGoalOwned(me.id, goalId);

    const activity = await prisma.activity.create({
      data: {
        ...rest,
        userId: me.id,
        // A flexible row is date: null with a [windowStart, windowEnd] instead.
        date: null,
        windowStart: parseDateOnly(windowStart),
        windowEnd: parseDateOnly(windowEnd),
        completedCount: 0,
        isDone: false,
        categoryId: categoryId ?? null,
        goalId: goalId ?? null,
        tags: { connect: await connectTags(me.id, tags) },
        history: { create: { changeType: 'CREATED' } },
      },
      include: activityInclude,
    });

    sendOk(res, { activity: serializeActivity(activity) }, 201);
  }),
);

// ---------------------------------------------------------------------------
// Bulk create across a date range
// ---------------------------------------------------------------------------

activitiesRouter.post(
  '/bulk',
  validate(bulkCreateActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const {
      tags,
      categoryId,
      goalId,
      rangeStart,
      rangeEnd,
      excludeWeekends,
      daysOfWeek,
      batchTitle,
      ...rest
    } = req.body;

    await assertCategoryOwned(me.id, categoryId);
    await assertGoalOwned(me.id, goalId);

    const days = eachDayInRange(parseDateOnly(rangeStart), parseDateOnly(rangeEnd)).filter((d) => {
      if (excludeWeekends && isWeekend(d)) return false;
      if (daysOfWeek?.length && !daysOfWeek.includes(d.getUTCDay())) return false;
      return true;
    });

    if (days.length === 0) throw AppError.badRequest('No days match the given range and filters');
    if (days.length > 366) throw AppError.badRequest('Bulk create is limited to 366 days at a time');

    // Bulk create counts every row it would add against the weekly quota.
    await assertActivityQuota(me.id, days.length);

    const tagConnect = await connectTags(me.id, tags);

    const created = await prisma.$transaction(async (tx) => {
      const batch = await tx.activityBatch.create({
        data: { userId: me.id, title: batchTitle ?? rest.title },
      });

      const rows = [];
      for (const day of days) {
        rows.push(
          await tx.activity.create({
            data: {
              ...rest,
              userId: me.id,
              date: day,
              batchId: batch.id,
              categoryId: categoryId ?? null,
              goalId: goalId ?? null,
              tags: { connect: tagConnect },
              history: { create: { changeType: 'CREATED' } },
            },
            include: activityInclude,
          }),
        );
      }
      return { batch, rows };
    });

    sendOk(
      res,
      {
        batch: created.batch,
        count: created.rows.length,
        activities: created.rows.map(serializeActivity),
      },
      201,
    );
  }),
);

// ---------------------------------------------------------------------------
// Reorder within a day
// ---------------------------------------------------------------------------

activitiesRouter.post(
  '/reorder',
  validate(reorderActivitiesSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const date = parseDateOnly(req.body.date);
    const ids: string[] = req.body.orderedIds;

    const owned = await prisma.activity.findMany({
      where: { id: { in: ids }, userId: me.id, date, deletedAt: null },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw AppError.badRequest('One or more activities are not on that day or not yours');
    }

    await prisma.$transaction(
      ids.map((id, index) => prisma.activity.update({ where: { id }, data: { order: index } })),
    );

    sendOk(res, { reordered: ids.length });
  }),
);

// ---------------------------------------------------------------------------
// Single activity
// ---------------------------------------------------------------------------

activitiesRouter.get(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const activity = await prisma.activity.findFirst({
      where: { id: req.params.id, userId: me.id, deletedAt: null },
      include: { ...activityInclude, reminders: true },
    });
    if (!activity) throw AppError.notFound('Activity not found');
    sendOk(res, { activity: serializeActivity(activity) });
  }),
);

activitiesRouter.patch(
  '/:id',
  validate(idParamSchema, 'params'),
  validate(updateActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await findOwnedActivity(me.id, req.params.id);

    const { tags, date, windowStart, windowEnd, categoryId, goalId, isDone, ...rest } = req.body;

    if (categoryId !== undefined) await assertCategoryOwned(me.id, categoryId);
    if (goalId !== undefined) await assertGoalOwned(me.id, goalId);

    const isFlexible = existing.date === null;
    if (date !== undefined && isFlexible) {
      throw AppError.badRequest(
        'This is a flexible task; it has a window rather than a single date',
        ErrorCode.NOT_A_DATED_TASK,
      );
    }
    if ((windowStart !== undefined || windowEnd !== undefined) && !isFlexible) {
      throw AppError.badRequest(
        'Only flexible tasks have a window',
        ErrorCode.NOT_A_FLEXIBLE_TASK,
      );
    }

    const data: Prisma.ActivityUpdateInput = { ...rest };
    if (date !== undefined) data.date = parseDateOnly(date);
    if (windowStart !== undefined) data.windowStart = parseDateOnly(windowStart);
    if (windowEnd !== undefined) data.windowEnd = parseDateOnly(windowEnd);
    if (categoryId !== undefined) data.category = categoryId ? { connect: { id: categoryId } } : { disconnect: true };
    if (goalId !== undefined) data.goal = goalId ? { connect: { id: goalId } } : { disconnect: true };
    if (isDone !== undefined) {
      data.isDone = isDone;
      data.completedAt = isDone ? new Date() : null;
    }
    if (tags !== undefined) data.tags = { set: await connectTags(me.id, tags) };

    const nextStart = windowStart !== undefined ? parseDateOnly(windowStart) : existing.windowStart;
    const nextEnd = windowEnd !== undefined ? parseDateOnly(windowEnd) : existing.windowEnd;
    if (nextStart && nextEnd && nextEnd.getTime() < nextStart.getTime()) {
      throw AppError.badRequest('windowEnd must be on or after windowStart');
    }

    const activity = await prisma.activity.update({
      where: { id: existing.id },
      data: { ...data, history: { create: { changeType: 'UPDATED', snapshot: req.body } } },
      include: activityInclude,
    });

    sendOk(res, { activity: serializeActivity(activity) });
  }),
);

// ---------------------------------------------------------------------------
// Toggle (dated tasks)
// ---------------------------------------------------------------------------

activitiesRouter.patch(
  '/:id/toggle',
  validate(idParamSchema, 'params'),
  validate(toggleActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await findOwnedActivity(me.id, req.params.id);

    if (existing.date === null) {
      throw AppError.badRequest(
        'This is a flexible task — log progress with PATCH /activities/:id/progress instead',
        ErrorCode.NOT_A_DATED_TASK,
      );
    }

    const next = req.body.isDone ?? !existing.isDone;
    const activity = await prisma.activity.update({
      where: { id: existing.id },
      data: {
        isDone: next,
        completedAt: next ? new Date() : null,
        history: { create: { changeType: 'TOGGLED', snapshot: { isDone: next } } },
      },
      include: activityInclude,
    });

    sendOk(res, { activity: serializeActivity(activity) });
  }),
);

// ---------------------------------------------------------------------------
// Progress (flexible tasks) — Addendum 2 §18.3
// ---------------------------------------------------------------------------

activitiesRouter.patch(
  '/:id/progress',
  validate(idParamSchema, 'params'),
  validate(progressActivitySchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await findOwnedActivity(me.id, req.params.id);

    if (existing.date !== null) {
      throw AppError.badRequest(
        'This is a dated task — use PATCH /activities/:id/toggle instead',
        ErrorCode.NOT_A_FLEXIBLE_TASK,
      );
    }

    const increment: number = req.body.increment ?? 1;
    // Clamp at targetCount; isDone flips automatically once the target is met.
    const completedCount = Math.min(existing.completedCount + increment, existing.targetCount);
    const isDone = completedCount >= existing.targetCount;

    const activity = await prisma.activity.update({
      where: { id: existing.id },
      data: {
        completedCount,
        isDone,
        completedAt: isDone ? (existing.completedAt ?? new Date()) : null,
        history: {
          create: {
            changeType: 'TOGGLED',
            snapshot: { increment, completedCount, targetCount: existing.targetCount, isDone },
          },
        },
      },
      include: activityInclude,
    });

    sendOk(res, {
      activity: serializeActivity(activity),
      progress: {
        completedCount,
        targetCount: existing.targetCount,
        remaining: Math.max(0, existing.targetCount - completedCount),
      },
    });
  }),
);

// ---------------------------------------------------------------------------
// Delete (soft)
// ---------------------------------------------------------------------------

activitiesRouter.delete(
  '/:id',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await findOwnedActivity(me.id, req.params.id);

    await prisma.activity.update({
      where: { id: existing.id },
      data: {
        deletedAt: new Date(),
        history: { create: { changeType: 'DELETED' } },
      },
    });

    sendOk(res, { deleted: true });
  }),
);

// ---------------------------------------------------------------------------
// History
// ---------------------------------------------------------------------------

activitiesRouter.get(
  '/:id/history',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const owned = await prisma.activity.findFirst({
      where: { id: req.params.id, userId: me.id },
      select: { id: true },
    });
    if (!owned) throw AppError.notFound('Activity not found');

    const history = await prisma.activityHistory.findMany({
      where: { activityId: owned.id },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    sendOk(res, { history });
  }),
);

// ---------------------------------------------------------------------------
// Live sessions (P-09)
// ---------------------------------------------------------------------------

const sessionParamsSchema = z.object({ id: z.string().min(1), sessionId: z.string().min(1) });

activitiesRouter.post(
  '/:id/sessions',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const activity = await findOwnedActivity(me.id, req.params.id);

    if (activity.date === null) {
      throw AppError.badRequest(
        'Flexible tasks are not timed — log progress with PATCH /activities/:id/progress instead',
        ErrorCode.NOT_A_DATED_TASK,
      );
    }

    const open = await prisma.activitySession.findFirst({
      where: { activityId: activity.id, endedAt: null },
      select: { id: true },
    });
    if (open) throw AppError.conflict('This activity already has a running session');

    const session = await prisma.activitySession.create({
      data: { activityId: activity.id, userId: me.id },
    });
    sendOk(res, { session }, 201);
  }),
);

activitiesRouter.post(
  '/:id/sessions/:sessionId/stop',
  validate(sessionParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const existing = await prisma.activitySession.findFirst({
      where: { id: req.params.sessionId, activityId: req.params.id, userId: me.id },
    });
    if (!existing) throw AppError.notFound('Session not found');
    if (existing.endedAt) throw AppError.badRequest('That session has already been stopped');

    const endedAt = new Date();
    const session = await prisma.activitySession.update({
      where: { id: existing.id },
      data: { endedAt },
    });

    sendOk(res, {
      session: {
        ...session,
        durationMinutes: Math.round((endedAt.getTime() - session.startedAt.getTime()) / 60_000),
      },
    });
  }),
);

/** Every session for an activity, plus actual-vs-planned minutes. */
activitiesRouter.get(
  '/:id/sessions',
  validate(idParamSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const activity = await findOwnedActivity(me.id, req.params.id);

    const sessions = await prisma.activitySession.findMany({
      where: { activityId: activity.id },
      orderBy: { startedAt: 'asc' },
    });

    const actualMinutes = sessions.reduce(
      (sum, s) => sum + (s.endedAt ? (s.endedAt.getTime() - s.startedAt.getTime()) / 60_000 : 0),
      0,
    );

    let plannedMinutes: number | null = null;
    if (activity.startTime && activity.endTime) {
      const [sh, sm] = activity.startTime.split(':').map(Number);
      const [eh, em] = activity.endTime.split(':').map(Number);
      plannedMinutes = eh * 60 + em - (sh * 60 + sm);
    }

    sendOk(res, {
      sessions,
      running: sessions.find((s) => !s.endedAt) ?? null,
      actualMinutes: Math.round(actualMinutes),
      plannedMinutes,
    });
  }),
);
