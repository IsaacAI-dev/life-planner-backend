import { AppError, type CreateTagInput } from '@life-planner/shared-utils';
import { prisma } from '@life-planner/database';

export function listTags(userId: string) {
  return prisma.tag.findMany({
    where: { userId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { activities: true } } },
  });
}

export function createTag(userId: string, input: CreateTagInput) {
  return prisma.tag.create({
    data: { userId, name: input.name, color: input.color ?? null },
  });
}

export async function deleteTag(userId: string, id: string) {
  const tag = await prisma.tag.findFirst({ where: { id, userId } });
  if (!tag) throw AppError.notFound('Tag not found');
  await prisma.tag.delete({ where: { id } });
}
