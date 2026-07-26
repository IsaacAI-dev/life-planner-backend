import {
  AppError,
  expandRange,
  dateOnly,
  type BulkCreateActivityInput,
  type CreateActivityInput,
  type ListActivitiesQuery,
  type ReorderActivitiesInput,
  type UpdateActivityInput,
} from '@life-planner/shared-utils';
import { Prisma, prisma } from '@life-planner/database';

const activityInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  tags: { select: { id: true, name: true, color: true } },
} satisfies Prisma.ActivityInclude;

type ChangeType = 'CREATED' | 'UPDATED' | 'TOGGLED' | 'DELETED';

/** Append an audit row. Accepts a transaction client so it joins the same tx. */
function recordHistory(
  tx: Prisma.TransactionClient,
  activityId: string,
  userId: string,
  changeType: ChangeType,
  snapshot: unknown,
) {
  return tx.activityHistory.create({
    data: {
      activityId,
      userId,
      changeType,
      snapshot: snapshot as Prisma.InputJsonValue,
    },
  });
}

/** Build a tags connectOrCreate clause keyed by the per-user unique [userId, name]. */
function tagsConnectOrCreate(userId: string, tags?: string[]) {
  if (!tags?.length) return undefined;
  const unique = [...new Set(tags.map((t) => t.trim()).filter(Boolean))];
  return {
    connectOrCreate: unique.map((name) => ({
      where: { userId_name: { userId, name } },
      create: { userId, name },
    })),
  };
}

export async function listActivities(userId: string, q: ListActivitiesQuery) {
  const where: Prisma.ActivityWhereInput = {
    userId,
    deletedAt: null,
    ...(q.categoryId ? { categoryId: q.categoryId } : {}),
    ...(q.goalId ? { goalId: q.goalId } : {}),
    ...(q.done !== undefined ? { isDone: q.done } : {}),
    ...(q.tag ? { tags: { some: { name: q.tag } } } : {}),
    ...(q.from || q.to
      ? {
          date: {
            ...(q.from ? { gte: dateOnly(q.from) } : {}),
            ...(q.to ? { lte: dateOnly(q.to) } : {}),
          },
        }
      : {}),
    ...(q.q
      ? {
          OR: [
            { title: { contains: q.q, mode: 'insensitive' } },
            { description: { contains: q.q, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  return prisma.activity.findMany({
    where,
    include: activityInclude,
    orderBy: [{ date: 'asc' }, { order: 'asc' }, { createdAt: 'asc' }],
  });
}

export async function getActivity(userId: string, id: string) {
  const activity = await prisma.activity.findFirst({
    where: { id, userId, deletedAt: null },
    include: { ...activityInclude, history: { orderBy: { createdAt: 'desc' }, take: 20 } },
  });
  if (!activity) throw AppError.notFound('Activity not found');
  return activity;
}

export async function createActivity(userId: string, input: CreateActivityInput) {
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.create({
      data: {
        userId,
        title: input.title,
        description: input.description ?? null,
        categoryId: input.categoryId ?? null,
        goalId: input.goalId ?? null,
        date: dateOnly(input.date),
        startTime: input.startTime ?? null,
        endTime: input.endTime ?? null,
        tags: tagsConnectOrCreate(userId, input.tags),
      },
      include: activityInclude,
    });
    await recordHistory(tx, activity.id, userId, 'CREATED', activity);
    return activity;
  });
}

/**
 * Bulk create: expand [rangeStart, rangeEnd] into one Activity/day under a single
 * ActivityBatch, honoring excludeWeekends and an optional daysOfWeek whitelist.
 * All within one transaction.
 */
export async function bulkCreateActivities(userId: string, input: BulkCreateActivityInput) {
  const dates = expandRange(input.rangeStart, input.rangeEnd, {
    excludeWeekends: input.excludeWeekends,
    daysOfWeek: input.daysOfWeek,
  });
  if (dates.length === 0) {
    throw AppError.badRequest('Date range produced no days (check weekend/day filters)');
  }

  return prisma.$transaction(async (tx) => {
    const batch = await tx.activityBatch.create({
      data: {
        userId,
        title: input.batchTitle ?? input.title,
        rangeStart: dateOnly(input.rangeStart),
        rangeEnd: dateOnly(input.rangeEnd),
        excludeWeekends: input.excludeWeekends,
      },
    });

    const created = [];
    for (const date of dates) {
      const activity = await tx.activity.create({
        data: {
          userId,
          batchId: batch.id,
          title: input.title,
          description: input.description ?? null,
          categoryId: input.categoryId ?? null,
          goalId: input.goalId ?? null,
          date,
          startTime: input.startTime ?? null,
          endTime: input.endTime ?? null,
          tags: tagsConnectOrCreate(userId, input.tags),
        },
        include: activityInclude,
      });
      await recordHistory(tx, activity.id, userId, 'CREATED', activity);
      created.push(activity);
    }

    return { batch, activities: created };
  });
}

async function assertOwned(userId: string, id: string) {
  const existing = await prisma.activity.findFirst({ where: { id, userId, deletedAt: null } });
  if (!existing) throw AppError.notFound('Activity not found');
  return existing;
}

export async function updateActivity(userId: string, id: string, input: UpdateActivityInput) {
  await assertOwned(userId, id);
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.update({
      where: { id },
      data: {
        ...(input.title !== undefined ? { title: input.title } : {}),
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.categoryId !== undefined ? { categoryId: input.categoryId } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        ...(input.date !== undefined ? { date: dateOnly(input.date) } : {}),
        ...(input.startTime !== undefined ? { startTime: input.startTime } : {}),
        ...(input.endTime !== undefined ? { endTime: input.endTime } : {}),
        ...(input.order !== undefined ? { order: input.order } : {}),
        ...(input.tags !== undefined
          ? { tags: { set: [], ...tagsConnectOrCreate(userId, input.tags) } }
          : {}),
      },
      include: activityInclude,
    });
    await recordHistory(tx, activity.id, userId, 'UPDATED', { changes: input, result: activity });
    return activity;
  });
}

export async function toggleActivity(userId: string, id: string, isDone?: boolean) {
  const existing = await assertOwned(userId, id);
  const next = isDone ?? !existing.isDone;
  return prisma.$transaction(async (tx) => {
    const activity = await tx.activity.update({
      where: { id },
      data: { isDone: next, completedAt: next ? new Date() : null },
      include: activityInclude,
    });
    await recordHistory(tx, activity.id, userId, 'TOGGLED', { isDone: next });
    return activity;
  });
}

export async function deleteActivity(userId: string, id: string) {
  await assertOwned(userId, id);
  await prisma.$transaction(async (tx) => {
    await tx.activity.update({ where: { id }, data: { deletedAt: new Date() } });
    await recordHistory(tx, id, userId, 'DELETED', { at: new Date().toISOString() });
  });
}

/** Soft-delete an entire bulk set. */
export async function deleteBatch(userId: string, batchId: string) {
  const batch = await prisma.activityBatch.findFirst({ where: { id: batchId, userId } });
  if (!batch) throw AppError.notFound('Batch not found');
  const result = await prisma.activity.updateMany({
    where: { batchId, userId, deletedAt: null },
    data: { deletedAt: new Date() },
  });
  return { deletedCount: result.count };
}

/** Reorder activities within a single day by assigning `order` from the given sequence. */
export async function reorderActivities(userId: string, input: ReorderActivitiesInput) {
  const date = dateOnly(input.date);
  const owned = await prisma.activity.findMany({
    where: { id: { in: input.orderedIds }, userId, date, deletedAt: null },
    select: { id: true },
  });
  const ownedIds = new Set(owned.map((a) => a.id));
  if (ownedIds.size !== input.orderedIds.length) {
    throw AppError.badRequest('orderedIds contains activities not on this day');
  }
  await prisma.$transaction(
    input.orderedIds.map((id, index) =>
      prisma.activity.update({ where: { id }, data: { order: index } }),
    ),
  );
  return listForDate(userId, date);
}

function listForDate(userId: string, date: Date) {
  return prisma.activity.findMany({
    where: { userId, date, deletedAt: null },
    include: activityInclude,
    orderBy: [{ order: 'asc' }, { createdAt: 'asc' }],
  });
}
