import { Router } from 'express';
import { z } from 'zod';
import { prisma, type Prisma } from '@lifeplanner/database';
import {
  AppError,
  ErrorCode,
  deleteActivityBatchSchema,
  listActivityBatchesQuerySchema,
  parseDateOnly,
  sendOk,
  toDateOnlyString,
  updateActivityBatchSchema,
  type BatchScope,
} from '@lifeplanner/shared-utils';
import { asyncHandler } from '../middleware/error.js';
import { validate } from '../middleware/validate.js';
import { currentUser } from '../middleware/auth.js';
import { activityInclude, assertCategoryOwned, assertGoalOwned, connectTags } from '../lib/prismaHelpers.js';
import { serializeActivity } from '../lib/serializers.js';

/**
 * Addendum 5 §2 — editing a set of activities that were created together.
 *
 * This is deliberately narrow: it only ever touches rows carrying a batchId,
 * i.e. rows that came out of POST /activities/bulk. An activity created on its
 * own has no batch and is edited one at a time through /activities/:id, so
 * there is no path here that can quietly rewrite unrelated days.
 */
export const activityBatchesRouter = Router();

const batchParamsSchema = z.object({ batchId: z.string().min(1) });

/** Ownership check first, every time — a batchId alone proves nothing. */
async function findOwnedBatch(userId: string, batchId: string) {
  const batch = await prisma.activityBatch.findFirst({
    where: { id: batchId, userId },
    select: { id: true, title: true, createdAt: true },
  });
  if (!batch) throw AppError.notFound('Batch not found');
  return batch;
}

/**
 * Resolves the scope to the rows it names. `activityIds` wins when given, and
 * every id in it must belong to this batch — passing an id from somewhere else
 * is an error rather than a silent no-op.
 */
async function resolveTargets(
  userId: string,
  batchId: string,
  options: { scope: BatchScope; fromDate?: string; activityIds?: string[] },
): Promise<string[]> {
  const where: Prisma.ActivityWhereInput = { userId, batchId, deletedAt: null };

  if (options.activityIds?.length) {
    const ids = [...new Set(options.activityIds)];
    const owned = await prisma.activity.findMany({
      where: { ...where, id: { in: ids } },
      select: { id: true },
    });
    if (owned.length !== ids.length) {
      throw AppError.badRequest(
        'One or more activityIds are not part of this batch',
        ErrorCode.NOT_A_BATCH_ACTIVITY,
      );
    }
    return owned.map((a) => a.id);
  }

  if (options.scope === 'UPCOMING') {
    where.date = { gte: parseDateOnly(options.fromDate ?? new Date()) };
  } else if (options.scope === 'PENDING') {
    where.isDone = false;
  }

  const rows = await prisma.activity.findMany({ where, select: { id: true } });
  return rows.map((a) => a.id);
}

/**
 * Which fields the whole batch still agrees on. The edit form needs this: a
 * field every row shares can be shown with its value, a field they disagree on
 * has to be shown as "mixed" rather than being overwritten by accident.
 */
type SharedRow = {
  title: string;
  description: string | null;
  startTime: string | null;
  endTime: string | null;
  categoryId: string | null;
  goalId: string | null;
  isPrivate: boolean;
};

const SHARED_FIELDS: (keyof SharedRow)[] = [
  'title',
  'description',
  'startTime',
  'endTime',
  'categoryId',
  'goalId',
  'isPrivate',
];

function summarizeShared(rows: SharedRow[]) {
  const shared: Partial<SharedRow> = {};
  const mixed: string[] = [];
  for (const field of SHARED_FIELDS) {
    const first = rows[0]?.[field] ?? null;
    const uniform = rows.every((r) => (r[field] ?? null) === first);
    if (uniform) {
      (shared as Record<string, unknown>)[field] = first;
    } else {
      mixed.push(field);
    }
  }
  return { shared, mixedFields: mixed };
}

const batchSummary = (
  batch: { id: string; title: string; createdAt: Date },
  rows: (SharedRow & { id: string; date: Date | null; isDone: boolean })[],
) => {
  const dates = rows.map((r) => r.date).filter((d): d is Date => d !== null);
  const done = rows.filter((r) => r.isDone).length;
  const { shared, mixedFields } = summarizeShared(rows);
  return {
    id: batch.id,
    title: batch.title,
    createdAt: batch.createdAt,
    count: rows.length,
    done,
    pending: rows.length - done,
    rangeStart: dates.length ? toDateOnlyString(new Date(Math.min(...dates.map((d) => d.getTime())))) : null,
    rangeEnd: dates.length ? toDateOnlyString(new Date(Math.max(...dates.map((d) => d.getTime())))) : null,
    shared,
    mixedFields,
    /** False once every row has been deleted; such a batch can only be read. */
    editable: rows.length > 0,
  };
};

const summarySelect = {
  id: true,
  date: true,
  isDone: true,
  title: true,
  description: true,
  startTime: true,
  endTime: true,
  categoryId: true,
  goalId: true,
  isPrivate: true,
} satisfies Prisma.ActivitySelect;

// ---------------------------------------------------------------------------
// List
// ---------------------------------------------------------------------------

activityBatchesRouter.get(
  '/',
  validate(listActivityBatchesQuerySchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const { from, to, includeEmpty } = req.query as unknown as {
      from?: string;
      to?: string;
      includeEmpty?: boolean;
    };

    const activityWhere: Prisma.ActivityWhereInput = { deletedAt: null };
    if (from) activityWhere.date = { gte: parseDateOnly(from) };
    if (to) activityWhere.date = { ...(activityWhere.date as object), lte: parseDateOnly(to) };

    const batches = await prisma.activityBatch.findMany({
      where: {
        userId: me.id,
        // A batch whose activities have all been deleted is noise on the list.
        ...(includeEmpty ? {} : { activities: { some: activityWhere } }),
      },
      select: {
        id: true,
        title: true,
        createdAt: true,
        activities: { where: activityWhere, select: summarySelect },
      },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });

    sendOk(res, {
      batches: batches.map((b) => batchSummary(b, b.activities)),
    });
  }),
);

// ---------------------------------------------------------------------------
// Single batch
// ---------------------------------------------------------------------------

activityBatchesRouter.get(
  '/:batchId',
  validate(batchParamsSchema, 'params'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const batch = await findOwnedBatch(me.id, req.params.batchId);

    const [summaryRows, activities] = await Promise.all([
      prisma.activity.findMany({
        where: { userId: me.id, batchId: batch.id, deletedAt: null },
        select: summarySelect,
      }),
      prisma.activity.findMany({
        where: { userId: me.id, batchId: batch.id, deletedAt: null },
        include: activityInclude,
        orderBy: [{ date: 'asc' }, { order: 'asc' }],
      }),
    ]);

    sendOk(res, {
      batch: batchSummary(batch, summaryRows),
      activities: activities.map(serializeActivity),
    });
  }),
);

// ---------------------------------------------------------------------------
// Edit the batch
// ---------------------------------------------------------------------------

/**
 * One write applied across the scope. Scalar fields go through a single
 * updateMany; tags are a many-to-many and have to be set per row, which is why
 * the batch size is capped at creation time.
 */
activityBatchesRouter.patch(
  '/:batchId',
  validate(batchParamsSchema, 'params'),
  validate(updateActivityBatchSchema),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const batch = await findOwnedBatch(me.id, req.params.batchId);

    const {
      scope,
      fromDate,
      activityIds,
      batchTitle,
      tags,
      categoryId,
      goalId,
      isDone,
      ...rest
    } = req.body;

    if (categoryId !== undefined) await assertCategoryOwned(me.id, categoryId);
    if (goalId !== undefined) await assertGoalOwned(me.id, goalId);

    const ids = await resolveTargets(me.id, batch.id, { scope, fromDate, activityIds });
    const touchesActivities =
      tags !== undefined ||
      categoryId !== undefined ||
      goalId !== undefined ||
      isDone !== undefined ||
      Object.keys(rest).length > 0;

    if (touchesActivities && ids.length === 0) {
      throw AppError.badRequest('No activities in this batch match that scope');
    }

    // Unchecked, not the checked variant: updateMany can only set a category or
    // goal by its foreign key, since a relation connect makes no sense in bulk.
    const data: Prisma.ActivityUncheckedUpdateManyInput = { ...rest };
    if (categoryId !== undefined) data.categoryId = categoryId;
    if (goalId !== undefined) data.goalId = goalId;
    if (isDone !== undefined) {
      data.isDone = isDone;
      data.completedAt = isDone ? new Date() : null;
    }

    // Tag rows are created outside the transaction: they are per-user and
    // idempotent, and creating them inside would hold the lock for longer.
    const tagConnect = tags !== undefined ? await connectTags(me.id, tags) : null;
    const snapshot = { ...req.body } as Prisma.InputJsonValue;

    await prisma.$transaction(async (tx) => {
      if (Object.keys(data).length > 0) {
        await tx.activity.updateMany({ where: { id: { in: ids } }, data });
      }
      if (tagConnect) {
        for (const id of ids) {
          await tx.activity.update({ where: { id }, data: { tags: { set: tagConnect } } });
        }
      }
      if (ids.length > 0) {
        await tx.activityHistory.createMany({
          data: ids.map((activityId) => ({
            activityId,
            changeType: 'UPDATED' as const,
            snapshot,
          })),
        });
      }
      if (batchTitle !== undefined) {
        await tx.activityBatch.update({ where: { id: batch.id }, data: { title: batchTitle } });
      }
    });

    const [refreshed, summaryRows, activities] = await Promise.all([
      findOwnedBatch(me.id, batch.id),
      prisma.activity.findMany({
        where: { userId: me.id, batchId: batch.id, deletedAt: null },
        select: summarySelect,
      }),
      prisma.activity.findMany({
        where: { id: { in: ids } },
        include: activityInclude,
        orderBy: [{ date: 'asc' }, { order: 'asc' }],
      }),
    ]);

    sendOk(res, {
      batch: batchSummary(refreshed, summaryRows),
      updated: ids.length,
      activities: activities.map(serializeActivity),
    });
  }),
);

// ---------------------------------------------------------------------------
// Delete across the batch
// ---------------------------------------------------------------------------

/**
 * Soft-deletes, matching DELETE /activities/:id. The batch row itself is
 * removed once nothing live points at it, so an empty batch stops appearing in
 * the picker; the deleted activities keep their history either way.
 */
activityBatchesRouter.delete(
  '/:batchId',
  validate(batchParamsSchema, 'params'),
  validate(deleteActivityBatchSchema, 'query'),
  asyncHandler(async (req, res) => {
    const me = currentUser(req);
    const batch = await findOwnedBatch(me.id, req.params.batchId);
    const { scope, fromDate, activityIds } = req.query as unknown as {
      scope: BatchScope;
      fromDate?: string;
      activityIds?: string[];
    };

    const ids = await resolveTargets(me.id, batch.id, { scope, fromDate, activityIds });
    if (ids.length === 0) throw AppError.badRequest('No activities in this batch match that scope');

    const remaining = await prisma.$transaction(async (tx) => {
      await tx.activity.updateMany({
        where: { id: { in: ids } },
        data: { deletedAt: new Date() },
      });
      await tx.activityHistory.createMany({
        data: ids.map((activityId) => ({ activityId, changeType: 'DELETED' as const })),
      });
      const left = await tx.activity.count({
        where: { userId: me.id, batchId: batch.id, deletedAt: null },
      });
      if (left === 0) await tx.activityBatch.delete({ where: { id: batch.id } });
      return left;
    });

    sendOk(res, {
      deleted: ids.length,
      remaining,
      batchRemoved: remaining === 0,
    });
  }),
);
