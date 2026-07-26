import { AppError, type CreateCategoryInput, type UpdateCategoryInput } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export function listCategories(userId: string) {
  return prisma.category.findMany({
    where: { userId, deletedAt: null },
    orderBy: { createdAt: 'asc' },
  });
}

export async function createCategory(userId: string, input: CreateCategoryInput) {
  // Unique [userId, name] is enforced at the DB level; P2002 → 409 via middleware.
  return prisma.category.create({
    data: {
      userId,
      name: input.name,
      color: input.color,
      icon: input.icon ?? null,
    },
  });
}

async function getOwnedCategory(userId: string, id: string) {
  const cat = await prisma.category.findFirst({ where: { id, userId, deletedAt: null } });
  if (!cat) throw AppError.notFound('Category not found');
  return cat;
}

export async function updateCategory(userId: string, id: string, input: UpdateCategoryInput) {
  await getOwnedCategory(userId, id);
  return prisma.category.update({
    where: { id },
    data: {
      ...(input.name !== undefined ? { name: input.name } : {}),
      ...(input.color !== undefined ? { color: input.color } : {}),
      ...(input.icon !== undefined ? { icon: input.icon } : {}),
    },
  });
}

/** Soft delete: activities keep history and become uncategorized (categoryId → null on read). */
export async function deleteCategory(userId: string, id: string) {
  await getOwnedCategory(userId, id);
  await prisma.category.update({ where: { id }, data: { deletedAt: new Date() } });
}
