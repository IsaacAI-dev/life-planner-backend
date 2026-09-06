import { prisma, type Prisma } from '@lifeplanner/database';
import { AppError } from '@lifeplanner/shared-utils';

/** Every user-api query is ownership-scoped; this centralizes the "or 404" path. */
export async function findOwnedActivity(userId: string, activityId: string) {
  const activity = await prisma.activity.findFirst({
    where: { id: activityId, userId, deletedAt: null },
    include: { category: true, tags: true },
  });
  if (!activity) throw AppError.notFound('Activity not found');
  return activity;
}

export async function assertCategoryOwned(userId: string, categoryId?: string | null) {
  if (!categoryId) return;
  const found = await prisma.category.findFirst({
    where: { id: categoryId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw AppError.badRequest('categoryId does not belong to you');
}

export async function assertGoalOwned(userId: string, goalId?: string | null) {
  if (!goalId) return;
  const found = await prisma.goal.findFirst({
    where: { id: goalId, userId, deletedAt: null },
    select: { id: true },
  });
  if (!found) throw AppError.badRequest('goalId does not belong to you');
}

/** Resolves tag names to per-user Tag rows, creating any that are new. */
export async function connectTags(userId: string, names?: string[]): Promise<Prisma.TagWhereUniqueInput[]> {
  if (!names?.length) return [];
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  await prisma.tag.createMany({
    data: unique.map((name) => ({ userId, name })),
    skipDuplicates: true,
  });
  const tags = await prisma.tag.findMany({
    where: { userId, name: { in: unique } },
    select: { id: true },
  });
  return tags.map((t) => ({ id: t.id }));
}

export const activityInclude = {
  category: { select: { id: true, name: true, color: true, icon: true } },
  tags: { select: { id: true, name: true, color: true } },
  goal: { select: { id: true, title: true, status: true } },
} satisfies Prisma.ActivityInclude;
